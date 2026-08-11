// Local origin for the desktop app.
//
// The renderer loads http://127.0.0.1:<port>/ and sees the same single origin the
// web app sees in production (SERVER_BASE = location.origin), so the 66k-line
// frontend runs unmodified. This server:
//   - serves the built frontend (dist/) and falls back to index.html on SPA routes
//   - proxies everything else to the upstream (swara.studio), attaching the stored
//     session JWT as the `sid` cookie and capturing sliding-renewal re-issues
//   - intercepts GET /auth/login to hand control to the system-browser login flow
//
// Electron-free on purpose: testable under plain `node --test`.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

// Keep in sync with src/router/index.ts in the web app.
export const SPA_ROUTES = new Set([
  '/', '/transcriptions', '/audioRecordings', '/raagEditor', '/editor',
  '/analyzer', '/logIn', '/collections', '/editorInstructions',
  '/analysisInstructions', '/changelog',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

const LOGIN_WAIT_PAGE = `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333}</style>
<div><h2>Finish signing in with your browser</h2>
<p>A Google sign-in page has opened in your default browser.<br>This window will continue automatically once you're signed in.</p></div>
<script>
  const poll = setInterval(async () => {
    try {
      const r = await fetch('/session/me', { cache: 'no-store' });
      if (r.ok) { clearInterval(poll); location.assign('/'); }
    } catch {}
  }, 1500);
</script>`;

/**
 * @param {object} opts
 * @param {string} opts.distDir absolute path to the built frontend
 * @param {string} opts.upstream e.g. "https://swara.studio"
 * @param {() => string|null} opts.getSessionToken
 * @param {(token: string|null) => void} opts.setSessionToken
 * @param {() => void} opts.onLoginRequest called when the app navigates to /auth/login
 * @returns {Promise<{server: import('node:http').Server, port: number, origin: string}>}
 */
export function startLocalServer(opts) {
  const { distDir, upstream, getSessionToken, setSessionToken, onLoginRequest } = opts;
  const upstreamUrl = new URL(upstream);
  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  const serveFile = (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const immutable = /-[A-Za-z0-9_-]{8,}\./.test(path.basename(filePath)); // vite hashed asset
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  };

  const proxy = (req, res, pathname) => {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers.cookie; // never forward renderer cookies; the session is ours to attach
    const token = getSessionToken();
    if (token) headers.cookie = `sid=${token}`;

    const upReq = transport.request({
      host: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    }, (upRes) => {
      // capture sliding-renewal session re-issues (and logout clears)
      const setCookies = upRes.headers['set-cookie'] || [];
      for (const c of setCookies) {
        const m = /^sid=([^;]*)/.exec(c);
        if (m) setSessionToken(m[1] ? m[1] : null);
      }
      if (pathname === '/session/logout' && upRes.statusCode === 200) setSessionToken(null);

      const outHeaders = { ...upRes.headers };
      delete outHeaders['set-cookie']; // session never enters the renderer cookie jar
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    });
    upReq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream unreachable', detail: err.code || err.message }));
    });
    req.pipe(upReq);
  };

  const handler = (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);

    if (pathname === '/auth/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      onLoginRequest();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(LOGIN_WAIT_PAGE);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const safePath = path.normalize(path.join(distDir, pathname));
      if (safePath.startsWith(distDir + path.sep) || safePath === distDir) {
        const filePath = pathname === '/' ? path.join(distDir, 'index.html') : safePath;
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return serveFile(res, filePath);
      } else {
        res.writeHead(400);
        return res.end();
      }
      if (SPA_ROUTES.has(pathname)) return serveFile(res, path.join(distDir, 'index.html'));
    }

    return proxy(req, res, pathname);
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}
