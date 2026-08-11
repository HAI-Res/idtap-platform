import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startLoginFlow } from '../src/auth.mjs';

const b64url = (buf) => buf.toString('base64url');

// Stub of the platform server: records the /auth/desktop params the browser would
// carry, and implements /session/desktop/exchange with real PKCE verification.
let upstream, upstreamOrigin, issued;

before(async () => {
  issued = null;
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/session/desktop/exchange' && req.method === 'POST') {
        const { code, code_verifier } = JSON.parse(body);
        const challengeOk = issued
          && code === issued.code
          && b64url(crypto.createHash('sha256').update(code_verifier).digest()) === issued.challenge;
        if (!challengeOk) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":"invalid_grant"}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: 'session-jwt', user: { uid: 'u1', name: 'Test' } }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
});

after(() => upstream.close());

test('full loopback flow: open browser → callback → exchange → token stored', async () => {
  let openedUrl = null;
  let result = null;
  await startLoginFlow({
    upstream: upstreamOrigin,
    openExternal: (url) => { openedUrl = url; },
    onSuccess: (t, u) => { result = { t, u }; },
    onFailure: (e) => { throw e; },
  });

  // "browser" reaches the server's /auth/desktop with these params
  const u = new URL(openedUrl);
  assert.equal(u.pathname, '/auth/desktop');
  const port = u.searchParams.get('port');
  const state = u.searchParams.get('state');
  const challenge = u.searchParams.get('challenge');
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);

  // "server" mints a code bound to the challenge and redirects to the loopback
  issued = { code: b64url(crypto.randomBytes(32)), challenge };
  const cb = await fetch(`http://127.0.0.1:${port}/callback?code=${issued.code}&state=${state}`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /Signed in/);
  assert.equal(result.t, 'session-jwt');
  assert.equal(result.u.uid, 'u1');
});

test('state mismatch is rejected without touching the exchange endpoint', async () => {
  let openedUrl = null;
  let failed = null;
  await startLoginFlow({
    upstream: upstreamOrigin,
    openExternal: (url) => { openedUrl = url; },
    onSuccess: () => { throw new Error('should not succeed'); },
    onFailure: (e) => { failed = e; },
  });
  const port = new URL(openedUrl).searchParams.get('port');
  issued = null; // exchange would 401 if reached — but it must not be reached
  const cb = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=WRONG`);
  assert.equal(cb.status, 400);
  assert.match(await cb.text(), /State mismatch/);
  assert.equal(failed, null); // state mismatch closes the flow page-side only
});
