import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLocalServer } from '../src/localServer.mjs';

let distDir, upstream, upstreamPort, local, token, loginRequests, seenUpstream;

before(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idtap-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html>app shell</html>');
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets', 'app-abc12345.js'), 'console.log(1)');

  seenUpstream = [];
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenUpstream.push({ url: req.url, method: req.method, cookie: req.headers.cookie, body });
      if (req.url === '/renew') {
        res.writeHead(200, { 'set-cookie': 'sid=renewed-token; Path=/; HttpOnly' });
        return res.end('{}');
      }
      if (req.url === '/session/logout') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      // the real server runs cors({ origin: '*' }), so every reply carries this
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ echo: req.url }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  token = 'test-jwt';
  loginRequests = 0;
  local = await startLocalServer({
    distDir,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    getSessionToken: () => token,
    setSessionToken: (t) => { token = t; },
    onLoginRequest: () => { loginRequests += 1; },
  });
});

after(() => {
  local.server.close();
  upstream.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

const get = (p, headers = {}) => fetch(`${local.origin}${p}`, { headers, redirect: 'manual' });

test('serves index.html at /', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /app shell/);
});

test('serves hashed assets with immutable caching', async () => {
  const r = await get('/assets/app-abc12345.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
});

test('SPA routes fall back to index.html', async () => {
  const r = await get('/editor');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /app shell/);
});

test('non-SPA, non-static paths proxy upstream with the sid cookie attached', async () => {
  const r = await fetch(`${local.origin}/getOneTranscription`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'userID=leaky-display-cookie' },
    body: '{"_id":"x"}',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { echo: '/getOneTranscription' });
  const seen = seenUpstream.at(-1);
  assert.equal(seen.cookie, 'sid=test-jwt');       // our session attached
  assert.equal(seen.body, '{"_id":"x"}');           // body forwarded
  assert.ok(!/userID/.test(seen.cookie || ''));     // renderer cookies never forwarded
});

test('captures sliding-renewal sid re-issues and strips set-cookie from the response', async () => {
  const r = await get('/renew');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(token, 'renewed-token');
});

test('logout clears the stored token', async () => {
  const r = await fetch(`${local.origin}/session/logout`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(token, null);
});

test('GET /auth/login is intercepted, not proxied', async () => {
  const beforeCount = seenUpstream.length;
  const r = await get('/auth/login');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Finish signing in/);
  assert.equal(loginRequests, 1);
  assert.equal(seenUpstream.length, beforeCount);
});

test('the wait page returns to where the user left off', async () => {
  const target = async (q) => {
    const html = await (await get(`/auth/login${q}`)).text();
    return /const target = (".*?");/.exec(html)[1];
  };
  assert.equal(await target('?returnTo=%2FlogIn'), '"/logIn"');
  assert.equal(await target('?returnTo=%2Feditor%3Fid%3Dabc'), '"/editor?id=abc"');
  assert.equal(await target(''), '"/"');
  // only plain local paths: no other origins, no breaking out of the script tag
  assert.equal(await target('?returnTo=%2F%2Fevil.example'), '"/"');
  assert.equal(await target('?returnTo=https%3A%2F%2Fevil.example'), '"/"');
  assert.equal(await target('?returnTo=%2Fx%3C%2Fscript%3E'), '"/"');
});

test('path traversal outside dist is rejected', async () => {
  const r = await fetch(`${local.origin}/..%2f..%2fetc%2fpasswd`);
  assert.equal(r.status, 400);
});

// The proxy attaches the session to whatever reaches the port, so a web page that
// finds it must not be able to act as the user (upstream's CSRF header check can't
// help: its own CORS config would wave the preflight through).
test('cross-origin callers are refused before anything is proxied', async () => {
  const beforeCount = seenUpstream.length;
  for (const headers of [
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, // another server on 127.0.0.1, different port
  ]) {
    const r = await get('/getAllTranscriptions', headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal(seenUpstream.length, beforeCount); // never reached the upstream
});

test('the renderer\'s own requests pass the caller check', async () => {
  const r = await get('/session/me', {
    origin: local.origin,
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(r.status, 200);
});

test('CORS grants from the upstream are not relayed', async () => {
  const r = await get('/session/me');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('a malformed escape sequence is a 400, not a crash', async () => {
  const r = await get('/%zz');
  assert.equal(r.status, 400);
  const still = await get('/');
  assert.equal(still.status, 200); // server (and, in Electron, the app) still alive
});
