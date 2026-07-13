# CSAIL deploy artifacts

Ready-to-drop-in config for standing up IDTAP on the CSAIL box
(`idtap.csail.mit.edu` / `128.52.132.248`). Authored 2026-07-13 while the public
firewall + model-conformance work are pending, so cutover is fast once unblocked.

| File | Goes to | Purpose |
|---|---|---|
| `nginx-idtap.conf` | `/etc/nginx/sites-available/idtap` (symlink → `sites-enabled/`) | TLS termination + reverse proxy to Node `:3000` |
| `idtap.service` | `/etc/systemd/system/idtap.service` | Node server, `User=jonmyers`, boot-persistent, auto-restart |
| `idtap-mass-upload-watcher.service` | `/etc/systemd/system/` | mass-upload `directory_watcher.py` (2nd DO tmux session) |

The `.service` files contain **`TODO(A2)`** markers for decisions finalized at deploy
time (app dir layout, a jonmyers-accessible Node 20 + audio venv, `.env` source).
All of A2 is gated on the conformance work landing — see the `openstack-migration-plan`
memory.

## Order of operations (once firewall is open + conformance merged)

1. **App layout** — put built server (`dist/`), frontend (`dist/`), and the prod
   Python scripts under one dir (the `WorkingDirectory`); resolve the Node + venv
   paths so `jonmyers` can execute them (current `~/audio-venv` is under
   `/home/ubuntu`, mode 700 — move to e.g. `/opt/idtap/audio-venv`; venv needs
   `pymongo`).
2. **Secrets** — copy `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
   `VUE_APP_GOOGLE_CLIENT_ID` from DO `/root/.env` into the app `.env`
   (box-to-box, never committed).
3. **systemd** — install both units, `daemon-reload`, `enable --now`,
   verify with `journalctl -u idtap -f`.
4. **nginx (needs firewall open)** — install `nginx-idtap.conf`. Before a cert
   exists, comment out the four `ssl_*` lines and the 443 block, or run certbot's
   nginx plugin which edits them in.
5. **TLS via certbot** (port 80 must be publicly reachable for HTTP-01):
   ```
   sudo apt install certbot python3-certbot-nginx
   sudo mkdir -p /var/www/certbot
   # First a cert for the CSAIL name (which already points at the box):
   sudo certbot --nginx -d idtap.csail.mit.edu
   # After swara.studio DNS is cut over to 128.52.132.248:
   sudo certbot --nginx -d swara.studio -d www.swara.studio
   ```
6. **DNS cutover** — point `swara.studio` A record at `128.52.132.248`, then the
   second certbot command, then decommission DigitalOcean.

## Notes
- **Security improvement vs DO:** the old nginx had a port-80 `default_server` that
  proxied *all* traffic (incl. raw-IP) to the app — the vector behind the unauthed-API
  review finding. This config only proxies the named vhosts; port 80 just does ACME +
  redirect. (Full fix is A5, route auth.)
- **Mongo auth:** local Mongo is currently unauthenticated (bind `127.0.0.1`). A4
  enables auth and adds creds to the service env — do it before/at public exposure.
- Values that match DO and must be preserved: `client_max_body_size 2000M`,
  proxy timeouts `5400s`, WebSocket upgrade headers.
