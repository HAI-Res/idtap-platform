// Loaded with `node --require` by the staging script only (never by production,
// which runs server.js under systemd without it). server.ts calls app.listen(3000)
// with no host, i.e. on every interface; on a laptop that would put real user data
// on the LAN. This forces every listening socket in the process onto 127.0.0.1.
'use strict';
if (process.env.IDTAP_STAGING !== '1') {
  console.error('localhost-only.cjs: refusing to run outside the staging script');
  process.exit(1);
}
const net = require('net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
    const port = Number(args[0]);
    const cb = args.find(a => typeof a === 'function');
    return listen.call(this, { port, host: '127.0.0.1' }, cb);
  }
  if (args[0] && typeof args[0] === 'object' && 'port' in args[0]) {
    args[0] = { ...args[0], host: '127.0.0.1' };
  }
  return listen.apply(this, args);
};
