// Server-issued session: a signed JWT carried in an httpOnly cookie (`sid`).
//
// This is the trust anchor for the web app. The login flow (authRoutes.ts) verifies
// the user's identity with Google once, then mints one of these; every subsequent
// request is identified from the verified cookie, never from client-supplied fields.
// See migration-2026/A5-web-auth-plan.md.

import jwt from 'jsonwebtoken';
import type { CookieOptions } from 'express';

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  // Fail fast: signing sessions with a missing/empty secret would be a security hole.
  throw new Error('SESSION_SECRET is not set — refusing to start.');
}

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** transient login-transaction cookie (state + PKCE verifier) between /auth/login and /auth/callback */
export const AUTH_TX_COOKIE = 'auth_tx';
const AUTH_TX_TTL_SECONDS = 10 * 60; // 10 minutes

export interface SessionUser {
  /** Google subject — stable identity-provider id */
  sub: string;
  /** Mongo user _id (what the rest of the codebase calls userID) */
  uid: string;
  email?: string;
  name?: string;
}

export function signSession(user: SessionUser): string {
  const { sub, uid, email, name } = user;
  return jwt.sign({ sub, uid, email, name }, SESSION_SECRET as string, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

/** Returns the verified session (with `exp`), or null if absent/invalid/expired. */
export function verifySession(token: string): (SessionUser & { exp: number }) | null {
  try {
    const p = jwt.verify(token, SESSION_SECRET as string) as jwt.JwtPayload;
    if (!p || typeof p.sub !== 'string' || typeof p.uid !== 'string') return null;
    return { sub: p.sub, uid: p.uid, email: p.email, name: p.name, exp: p.exp ?? 0 };
  } catch {
    return null;
  }
}

function cookieBase(): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
}

export function sessionCookieOptions(): CookieOptions {
  return { ...cookieBase(), maxAge: SESSION_TTL_SECONDS * 1000 };
}

export function clearSessionCookieOptions(): CookieOptions {
  return cookieBase();
}

// --- login-transaction cookie (short-lived, signed) ---

export interface AuthTx {
  state: string;
  codeVerifier: string;
  returnTo: string;
  /** present when the login was initiated by a native app (authRoutes /auth/desktop):
   *  where to hand the one-time code back — a loopback `port` (macOS/Electron) or an
   *  allow-listed custom-scheme `redirect` (iOS, which has no loopback listener) —
   *  plus the app's own state + PKCE challenge for the exchange leg. Exactly one of
   *  `port` / `redirect` is set. */
  desktop?: { port?: number; redirect?: string; state: string; challenge: string };
}

export function signAuthTx(tx: AuthTx): string {
  return jwt.sign(tx, SESSION_SECRET as string, { expiresIn: AUTH_TX_TTL_SECONDS });
}

export function verifyAuthTx(token: string): AuthTx | null {
  try {
    const p = jwt.verify(token, SESSION_SECRET as string) as jwt.JwtPayload;
    if (!p || typeof p.state !== 'string' || typeof p.codeVerifier !== 'string') return null;
    const tx: AuthTx = { state: p.state, codeVerifier: p.codeVerifier, returnTo: p.returnTo || '/' };
    const d = p.desktop;
    if (d && typeof d.state === 'string' && typeof d.challenge === 'string'
        && (Number.isInteger(d.port) || typeof d.redirect === 'string')) {
      tx.desktop = { state: d.state, challenge: d.challenge };
      if (Number.isInteger(d.port)) tx.desktop.port = d.port;
      if (typeof d.redirect === 'string') tx.desktop.redirect = d.redirect;
    }
    return tx;
  } catch {
    return null;
  }
}

export function authTxCookieOptions(): CookieOptions {
  return { ...cookieBase(), maxAge: AUTH_TX_TTL_SECONDS * 1000 };
}
