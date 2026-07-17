// Server-mediated OIDC login (Authorization Code + PKCE), IdP-agnostic by design.
//
// The browser never touches a token: it navigates to /auth/login, we redirect to the
// provider (Google today), the provider bounces back to /auth/callback, we exchange
// the code server-side, verify the id_token, upsert the user, and set the `sid`
// session cookie. Swapping Google for another OIDC provider later is a config change
// (authorize/token URLs + client creds), not a client change.
//
// /session/me + /session/logout let the SPA read/clear session state. See
// migration-2026/A5-web-auth-plan.md.

import { Router, Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import {
  signSession, sessionCookieOptions, clearSessionCookieOptions, SESSION_COOKIE,
  signAuthTx, verifyAuthTx, authTxCookieOptions, AUTH_TX_COOKIE,
} from './session';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

interface AuthDeps {
  users: any; // Collection
  googleClientId: string;
  googleClientSecret: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

// Absolute origin the browser is using, so the OAuth redirect_uri matches exactly what
// is registered. PUBLIC_BASE_URL wins (reliable behind the nginx TLS proxy); otherwise
// derive from forwarded headers / the request (dev).
function baseUrl(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}
const redirectUriFor = (req: Request) => `${baseUrl(req)}/auth/callback`;

export default function authRoutes(deps: AuthDeps): Router {
  const { users, googleClientId, googleClientSecret } = deps;
  const router = Router();

  // Begin login: stash state + PKCE verifier in a short-lived signed cookie, redirect to Google.
  router.get('/auth/login', (req, res) => {
    const state = b64url(crypto.randomBytes(24));
    const codeVerifier = b64url(crypto.randomBytes(32));
    const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());

    // only allow returning to a local path (no open redirect)
    let returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
    if (!returnTo.startsWith('/') || returnTo.startsWith('//')) returnTo = '/';

    res.cookie(AUTH_TX_COOKIE, signAuthTx({ state, codeVerifier, returnTo }), authTxCookieOptions());

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUriFor(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'online',
    });
    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  // Provider callback: verify state, exchange code, verify id_token, upsert user, set session.
  router.get('/auth/callback', async (req, res) => {
    try {
      const code = req.query.code;
      const state = req.query.state;
      const txRaw = req.cookies?.[AUTH_TX_COOKIE];
      res.clearCookie(AUTH_TX_COOKIE, clearSessionCookieOptions());

      const tx = typeof txRaw === 'string' ? verifyAuthTx(txRaw) : null;
      if (!tx || typeof code !== 'string' || state !== tx.state) {
        return res.status(400).send('Invalid or expired login attempt. Please try signing in again.');
      }

      const redirectUri = redirectUriFor(req);
      const client = new OAuth2Client({ clientId: googleClientId, clientSecret: googleClientSecret, redirectUri });
      // redirect_uri for the exchange comes from the constructor above; pass only code + PKCE verifier.
      const { tokens } = await (client.getToken as any)({ code, codeVerifier: tx.codeVerifier });
      if (!tokens?.id_token) return res.status(401).send('No identity token returned by provider.');

      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: googleClientId });
      const payload = ticket.getPayload();
      if (!payload?.sub) return res.status(401).send('Could not verify identity token.');

      const profile = {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        given_name: payload.given_name,
        family_name: payload.family_name,
        picture: payload.picture,
      };
      const result = await users.findOneAndUpdate(
        { sub: payload.sub },
        { $set: profile, $setOnInsert: { collections: [], transcriptions: [], savedQueries: [] } },
        { upsert: true, returnDocument: 'after' },
      );
      const user = result?.value ?? result; // tolerate driver result shape
      const uid = (user._id as ObjectId).toString();

      res.cookie(SESSION_COOKIE, signSession({ sub: payload.sub, uid, email: payload.email, name: payload.name }), sessionCookieOptions());
      return res.redirect(tx.returnTo || '/');
    } catch (err) {
      console.error('auth callback error', err);
      return res.status(500).send('Login failed. Please try again.');
    }
  });

  // Current session — populated by the attachUser middleware from the sid cookie.
  router.get('/session/me', async (req, res) => {
    const u = req.user;
    if (!u?.uid) return res.status(401).json({ error: 'not authenticated' });
    try {
      const user = await users.findOne({ _id: new ObjectId(u.uid) });
      if (!user) return res.status(401).json({ error: 'not authenticated' });
      return res.json(user);
    } catch (err) {
      console.error('session/me error', err);
      return res.status(500).json({ error: 'lookup failed' });
    }
  });

  router.post('/session/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
    res.json({ ok: true });
  });

  return router;
}
