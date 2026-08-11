# IDTAP Desktop

Electron shell for the IDTAP web app. It serves the repo's built frontend
(`dist/`) from a local origin and reverse-proxies API and media requests to the
upstream server, so the web app runs completely unmodified — same code, same
`SERVER_BASE = location.origin` assumption, no preload scripts, no IPC.

## Sign-in

Google blocks OAuth inside embedded frameworks, so login never happens in the
Electron window. Clicking **Sign in** opens the system browser at the server's
`/auth/desktop` route; the server runs its normal Google leg, then redirects the
browser to a one-shot `127.0.0.1` loopback listener with a short-lived,
PKCE-bound, single-use code. The app exchanges it at
`POST /session/desktop/exchange` for the same session JWT the web app carries in
its `sid` cookie, and stores it encrypted via the OS keychain (Electron
`safeStorage`). The proxy attaches the JWT to upstream requests and keeps it
fresh from the server's sliding-renewal re-issues. No Google Cloud Console
configuration is involved.

## Running (development)

```bash
# 1. build the frontend at the repo root
pnpm install && pnpm build

# 2. run the shell
cd desktop
pnpm install
pnpm start
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `IDTAP_UPSTREAM` | `https://swara.studio` | API/media server to proxy to |
| `IDTAP_DIST` | `../dist` | Location of the built frontend |

Note the upstream must be running a server version that includes the
`/auth/desktop` + `/session/desktop/exchange` routes.

## Tests

```bash
pnpm test   # node --test; no Electron required
```

`src/localServer.mjs` and `src/auth.mjs` are Electron-free by design so the
static/proxy/auth logic is testable under plain Node. Electron-touching code is
confined to `src/main.mjs` and `src/tokenStore.mjs`. Server-side tests for the
desktop auth endpoints live in `src/ts/tests/desktopAuth.test.ts` at the repo
root.
