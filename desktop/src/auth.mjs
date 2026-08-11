// System-browser Google sign-in for the desktop app.
//
// Google blocks OAuth inside embedded frameworks (disallowed_useragent), so the
// flow never touches an Electron window: we open the user's default browser at
// the server's /auth/desktop route, the server runs its normal Google leg, and
// on success redirects the browser to our 127.0.0.1 loopback with a short-lived
// one-time code. We exchange code + PKCE verifier at /session/desktop/exchange
// for the same session JWT the web app carries in its sid cookie. No Google
// Cloud Console configuration is involved on the desktop side at all.
//
// Electron-free on purpose: `openExternal` is injected, so tests can drive the
// whole flow with plain node.

import http from 'node:http';
import crypto from 'node:crypto';

const b64url = (buf) => buf.toString('base64url');
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const donePage = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333}</style>
<div><h2>${title}</h2><p>${body}</p></div>`;

let activeFlow = null; // only one login in flight; a new request supersedes it

/**
 * @param {object} opts
 * @param {string} opts.upstream e.g. "https://swara.studio"
 * @param {(url: string) => void} opts.openExternal opens the system browser
 * @param {(token: string, user: object) => void} opts.onSuccess
 * @param {(err: Error) => void} [opts.onFailure]
 */
export async function startLoginFlow(opts) {
  const { upstream, openExternal, onSuccess, onFailure = () => {} } = opts;

  if (activeFlow) { activeFlow.close(); activeFlow = null; }

  const codeVerifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(24));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }

    const finish = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      cleanup();
    };

    if (url.searchParams.get('state') !== state) {
      return finish(400, donePage('Sign-in failed', 'State mismatch — please try signing in again from the app.'));
    }
    const code = url.searchParams.get('code');
    if (!code) {
      return finish(400, donePage('Sign-in failed', 'No authorization code received — please try again from the app.'));
    }

    try {
      const r = await fetch(`${upstream}/session/desktop/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier }),
      });
      if (!r.ok) throw new Error(`exchange failed (${r.status})`);
      const { token, user } = await r.json();
      if (!token) throw new Error('exchange returned no token');
      onSuccess(token, user);
      finish(200, donePage('Signed in to IDTAP', 'You can close this tab and return to the app.'));
    } catch (err) {
      onFailure(err);
      finish(502, donePage('Sign-in failed', 'The app could not complete sign-in. Please try again.'));
    }
  });

  const timeout = setTimeout(() => { cleanup(); onFailure(new Error('login timed out')); }, FLOW_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timeout);
    server.close();
    if (activeFlow?.server === server) activeFlow = null;
  };
  activeFlow = { server, close: cleanup };

  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const params = new URLSearchParams({ port: String(port), state, challenge });
  openExternal(`${upstream}/auth/desktop?${params.toString()}`);
  return { port };
}
