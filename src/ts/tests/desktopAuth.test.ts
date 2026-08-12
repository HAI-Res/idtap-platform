import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { ObjectId } from 'mongodb';

const hoisted = vi.hoisted(() => {
  // session.ts refuses to load without a secret; set it before any import runs
  process.env.SESSION_SECRET = 'test-secret';
  return {
    verifyIdToken: vi.fn(),
    getToken: vi.fn(),
  };
});

// Resolution is pinned to the root copy via the test alias in vite.config.js,
// so this bare specifier and the import in authRoutes.ts hit the same module.
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(() => hoisted),
}));

import authRoutes from '../../../server/authRoutes';
import { verifySession } from '../../../server/session';

const b64url = (buf: Buffer) => buf.toString('base64url');
const s256 = (s: string) => b64url(crypto.createHash('sha256').update(s).digest());

const userId = new ObjectId();
const makeApp = () => {
  const users = {
    findOneAndUpdate: vi.fn().mockResolvedValue({ value: { _id: userId, sub: 'sub-1' } }),
    findOne: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  // minimal cookie parsing (cookie-parser is a server-only dep, not in the root tree)
  app.use((req, _res, next) => {
    (req as any).cookies = Object.fromEntries(
      (req.headers.cookie || '').split(/; */).filter(Boolean).map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
    );
    next();
  });
  app.use(authRoutes({ users, googleClientId: 'cid', googleClientSecret: 'csec' }));
  return app;
};

// Drive the desktop handshake up to the point where the loopback would receive the
// one-time code, and return that code plus the app-side PKCE verifier.
async function runDesktopLogin(app: express.Express, appState = b64url(crypto.randomBytes(24))) {
  const verifier = b64url(crypto.randomBytes(32));
  const start = await request(app)
    .get('/auth/desktop')
    .query({ port: '52345', state: appState, challenge: s256(verifier) });
  expect(start.status).toBe(302);
  const googleUrl = new URL(start.headers.location);
  expect(googleUrl.hostname).toBe('accounts.google.com');
  const googleState = googleUrl.searchParams.get('state')!;
  const txCookie = start.headers['set-cookie'][0].split(';')[0];

  hoisted.getToken.mockResolvedValue({ tokens: { id_token: 'idt' } });
  hoisted.verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub: 'sub-1', email: 'x@y.z', name: 'Test User' }),
  });

  const cb = await request(app)
    .get('/auth/callback')
    .query({ code: 'g-code', state: googleState })
    .set('Cookie', txCookie);
  expect(cb.status).toBe(302);
  const loopback = new URL(cb.headers.location);
  expect(loopback.origin).toBe('http://127.0.0.1:52345');
  expect(loopback.searchParams.get('state')).toBe(appState);
  return { code: loopback.searchParams.get('code')!, verifier, cb };
}

describe('desktop auth flow', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  test('full handshake yields a valid session JWT', async () => {
    const app = makeApp();
    const { code, verifier, cb } = await runDesktopLogin(app);

    // desktop flow must not set the web session cookie on the browser
    const cbCookies = (cb.headers['set-cookie'] || []).join(';');
    expect(cbCookies).not.toMatch(/(^|[^_])sid=/);

    const ex = await request(app)
      .post('/session/desktop/exchange')
      .send({ code, code_verifier: verifier });
    expect(ex.status).toBe(200);
    const session = verifySession(ex.body.token);
    expect(session?.uid).toBe(userId.toString());
    expect(session?.sub).toBe('sub-1');
    expect(ex.body.user.name).toBe('Test User');
  });

  test('codes are single-use', async () => {
    const app = makeApp();
    const { code, verifier } = await runDesktopLogin(app);
    await request(app).post('/session/desktop/exchange').send({ code, code_verifier: verifier }).expect(200);
    await request(app).post('/session/desktop/exchange').send({ code, code_verifier: verifier }).expect(401);
  });

  test('wrong verifier is rejected and consumes the code', async () => {
    const app = makeApp();
    const { code, verifier } = await runDesktopLogin(app);
    const wrong = b64url(crypto.randomBytes(32));
    await request(app).post('/session/desktop/exchange').send({ code, code_verifier: wrong }).expect(401);
    // even the right verifier can't be used now — the failed attempt consumed the code
    await request(app).post('/session/desktop/exchange').send({ code, code_verifier: verifier }).expect(401);
  });

  test('expired codes are rejected', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const { code, verifier } = await runDesktopLogin(app);
    vi.advanceTimersByTime(61_000);
    await request(app).post('/session/desktop/exchange').send({ code, code_verifier: verifier }).expect(401);
  });

  test('/auth/desktop validates its parameters', async () => {
    const app = makeApp();
    const ok = { port: '52345', state: b64url(crypto.randomBytes(24)), challenge: s256('v') };
    await request(app).get('/auth/desktop').query({ ...ok, port: '80' }).expect(400);       // privileged port
    await request(app).get('/auth/desktop').query({ ...ok, port: 'abc' }).expect(400);
    await request(app).get('/auth/desktop').query({ ...ok, state: 'short' }).expect(400);
    await request(app).get('/auth/desktop').query({ ...ok, challenge: 'not-43-chars' }).expect(400);
    await request(app).get('/auth/desktop').query(ok).expect(302);
  });

  test('exchange validates its body shape', async () => {
    const app = makeApp();
    await request(app).post('/session/desktop/exchange').send({}).expect(400);
    await request(app).post('/session/desktop/exchange').send({ code: 'a!b', code_verifier: 'x' }).expect(400);
    await request(app).post('/session/desktop/exchange').send({ code: 'unknowncode', code_verifier: 'xyz' }).expect(401);
  });

  test('web login flow is unchanged: callback still sets the sid cookie', async () => {
    const app = makeApp();
    const start = await request(app).get('/auth/login');
    expect(start.status).toBe(302);
    const googleState = new URL(start.headers.location).searchParams.get('state')!;
    const txCookie = start.headers['set-cookie'][0].split(';')[0];

    hoisted.getToken.mockResolvedValue({ tokens: { id_token: 'idt' } });
    hoisted.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'sub-1' }) });

    const cb = await request(app)
      .get('/auth/callback')
      .query({ code: 'g-code', state: googleState })
      .set('Cookie', txCookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    expect((cb.headers['set-cookie'] || []).join(';')).toMatch(/sid=/);
  });
});
