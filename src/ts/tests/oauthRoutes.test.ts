import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(),
  verifyIdToken: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  generateAuthUrl: vi.fn(),
  request: vi.fn(),
}));

// google-auth-library is installed only under server/node_modules, so the bare
// specifier resolves to a different module ID here than inside oauthRoutes.ts —
// mock the server's copy explicitly.
vi.mock('../../../server/node_modules/google-auth-library', () => ({
  OAuth2Client: vi.fn(() => mocks),
}));

import oauthRoutes from '../../../server/oauthRoutes';

const makeApp = (users: any) => {
  const app = express();
  app.use(express.json());
  app.use('/oauth', oauthRoutes({ users }, 'client-id', 'client-secret'));
  return app;
};

describe('POST /oauth/token grant_type=refresh_token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns refreshed tokens and profile', async () => {
    mocks.refreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'new-at', id_token: 'new-idt' },
    });
    mocks.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'sub-1' }),
    });
    const users = { findOne: vi.fn().mockResolvedValue({ _id: 'u1', sub: 'sub-1' }) };

    const res = await request(makeApp(users))
      .post('/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: 'rt-old' });

    expect(res.status).toBe(200);
    expect(res.body.id_token).toBe('new-idt');
    expect(res.body.access_token).toBe('new-at');
    // Google omitted refresh_token in the response → old one is echoed back
    expect(res.body.refresh_token).toBe('rt-old');
    expect(res.body.profile).toEqual({ _id: 'u1', sub: 'sub-1' });
    expect(mocks.setCredentials).toHaveBeenCalledWith({ refresh_token: 'rt-old' });
    expect(users.findOne).toHaveBeenCalledWith({ sub: 'sub-1' });
  });

  test('revoked refresh token yields 401 invalid_grant', async () => {
    mocks.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    const users = { findOne: vi.fn() };

    const res = await request(makeApp(users))
      .post('/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: 'rt-revoked' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('missing refresh_token yields 400', async () => {
    const res = await request(makeApp({ findOne: vi.fn() }))
      .post('/oauth/token')
      .send({ grant_type: 'refresh_token' });

    expect(res.status).toBe(400);
  });

  test('profile lookup failure still returns tokens', async () => {
    mocks.refreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'new-at', id_token: 'new-idt' },
    });
    mocks.verifyIdToken.mockRejectedValue(new Error('aud mismatch'));
    const users = { findOne: vi.fn() };

    const res = await request(makeApp(users))
      .post('/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: 'rt-old' });

    expect(res.status).toBe(200);
    expect(res.body.id_token).toBe('new-idt');
    expect(res.body.profile).toBeNull();
  });

  test('authorization-code exchange path is unchanged', async () => {
    mocks.getToken.mockResolvedValue({
      tokens: { access_token: 'at', id_token: 'idt', refresh_token: 'rt' },
    });
    mocks.request.mockResolvedValue({ data: { sub: 'sub-1', email: 'a@b.c' } });
    const users = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ value: { _id: 'u1', sub: 'sub-1' } }),
    };

    const res = await request(makeApp(users))
      .post('/oauth/token')
      .send({ code: 'auth-code', redirect_uri: 'http://localhost:8080/' });

    expect(res.status).toBe(200);
    expect(res.body.id_token).toBe('idt');
    expect(res.body.refresh_token).toBe('rt');
    expect(res.body.profile).toEqual({ _id: 'u1', sub: 'sub-1' });
    expect(mocks.getToken).toHaveBeenCalledWith('auth-code');
  });
});
