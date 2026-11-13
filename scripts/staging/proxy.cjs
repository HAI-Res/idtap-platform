// Local staging front door: 127.0.0.1:$STAGING_PORT -> the app server on 127.0.0.1:3000.
//
// It adds one thing the app does not have: a staging-only sign-in. Production
// sign-in is Google OAuth, which cannot work here (the production client id is
// not configured for a localhost redirect, and staging gets a dummy one), so
//   GET /__staging/login            -> a page listing users to sign in as
//   GET /__staging/login?email=...  -> sets the `sid` session cookie and redirects to /
// The cookie is the app's own session JWT, signed with the staging run's random
// SESSION_SECRET, which is generated per `staging:up`, never written to the
// repo, and different from production's.
//
// Why this cannot reach production: it is not part of the server bundle
// (server/build/server.js) or the web build. It lives only in scripts/staging,
// runs only when the staging script starts it, and refuses to start unless
// IDTAP_STAGING=1 and MONGO_URI points at loopback. A token it mints is signed
// with a secret production does not have, so it verifies nowhere else.
'use strict';
const http = require('http');
const { createRequire } = require('module');
const path = require('path');

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`proxy: ${k} is not set`); process.exit(1); }
  return v;
};
if (process.env.IDTAP_STAGING !== '1') {
  console.error('proxy: refusing to run outside the staging script (IDTAP_STAGING!=1)');
  process.exit(1);
}
const MONGO_URI = need('MONGO_URI');
const host = new URL(MONGO_URI.replace(/^mongodb:/, 'http:')).hostname;
if (!MONGO_URI.startsWith('mongodb://') || !['127.0.0.1', 'localhost'].includes(host)) {
  console.error(`proxy: MONGO_URI must be mongodb://127.0.0.1 or localhost, got host ${host}`);
  process.exit(1);
}
const SECRET = need('SESSION_SECRET');
const PORT = Number(need('STAGING_PORT'));
const UPSTREAM = { host: '127.0.0.1', port: 3000 };
const checkoutRequire = createRequire(path.join(need('STAGING_CHECKOUT'), 'package.json'));
const jwt = checkoutRequire('jsonwebtoken');
const { MongoClient } = checkoutRequire('mongodb');

let db;
async function users() {
  if (!db) db = (await MongoClient.connect(MONGO_URI)).db('swara');
  return db.collection('users');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function login(req, res, url) {
  const col = await users();
  const email = url.searchParams.get('email');
  if (!email) {
    const list = await col.find({}, { projection: { email: 1, name: 1 } }).sort({ email: 1 }).toArray();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>IDTAP staging sign-in</title>
<body style="font:15px system-ui;margin:2em;max-width:40em">
<h1>IDTAP local staging</h1>
<p><b>Local copy of production data.</b> Nothing here reaches production. Sign in as:</p>
<ul>${list.map(u => `<li><a href="/__staging/login?email=${encodeURIComponent(u.email)}">${esc(u.email)}</a> ${esc(u.name)}</li>`).join('')}</ul>
</body>`);
    return;
  }
  const u = await col.findOne({ email });
  if (!u) { res.writeHead(404); res.end(`no user with email ${email}`); return; }
  const token = jwt.sign(
    { sub: String(u.sub ?? `staging-${u._id}`), uid: String(u._id), email: u.email, name: u.name },
    SECRET, { expiresIn: 7 * 24 * 3600 });
  res.writeHead(302, {
    // the app's own cookie shape (server/session.ts); Secure is honoured on
    // http://127.0.0.1 because browsers treat loopback as a secure context
    'Set-Cookie': `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    Location: '/',
  });
  res.end();
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/__staging/login') {
    login(req, res, url).catch(err => { res.writeHead(500); res.end(String(err)); });
    return;
  }
  const up = http.request({ ...UPSTREAM, method: req.method, path: req.url, headers: req.headers }, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', err => { res.writeHead(502); res.end(`staging: app server not reachable (${err.message})`); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`staging proxy on http://127.0.0.1:${PORT}`));
