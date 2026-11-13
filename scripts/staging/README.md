# Local staging

A throwaway copy of production, on this Mac, for trying a branch against real
data before it goes anywhere near `main`.

> **⚠️ Merging to `main` deploys straight to production.** The self-hosted runner on
> idtap.csail.mit.edu builds and restarts the `idtap` service on every push to
> `main`, and there is no staging server. Local staging is the only place to try a
> branch on real data. Open PRs as drafts and let Jon merge.

```bash
pnpm staging:up                       # newest nightly backup, this checkout
pnpm staging:up --checkout ../idtap-platform-syllables   # try another branch
pnpm staging:up --archive ~/Downloads/swara-20261113-043002.archive.gz
pnpm staging:status
pnpm staging:down                     # stop everything, delete the DB and every restored file
```

`up` prints:

```
  App:      http://127.0.0.1:4000/
  Sign in:  http://127.0.0.1:4000/__staging/login
```

## What `up` does

1. **Backup.** Lists `agents:/data/hai-res/idtap/backups/mongo/` over `ssh agents`
   (Tailscale; no VPN, no Duo) and `scp`s the newest `swara-*.archive.gz` (about
   6.5 MB). This read-only copy is the only time staging talks to the lab side.
   `--archive PATH` skips it. If `agents` is unreachable, run `fleet tunnel status`.
2. **Database.** Starts `mongod` as a plain user process with
   `--bind_ip 127.0.0.1 --port 27027` and `--dbpath ~/Library/Caches/idtap-staging/db`,
   then runs `mongorestore --drop --gzip --archive` on the backup (database `swara`).
   It runs only while staging is up. It's not a `brew services` service or a launchd job,
   so nothing starts at login.
3. **App.** Runs `pnpm build` and `pnpm buildServer` in the checkout, in an
   `env -i` environment so no `VITE_API_URL` can reach the bundle. Then it lays out
   an app dir the way the deploy does (`server/package.json` installed with
   `pnpm install --prod`, plus `server.js` and `dist/`) under the cache dir, and
   starts it with only the variables listed below. A local front-door proxy listens
   on 127.0.0.1:4000; the app server itself is on 127.0.0.1:3000.
4. Prints the URL.

Restored data and logs live in `~/Library/Caches/idtap-staging` (override with
`IDTAP_STAGING_DIR`, which must be under `$HOME` and outside the repo).
`.gitignore` also ignores `*.archive.gz`, as a backstop. **Never commit backup data**: it
is real user data.

### MongoDB: Homebrew, run by hand

One-time install (Jon approved it on 2026-11-13):

```bash
brew tap mongodb/brew
brew install mongodb-community mongodb-database-tools
```

**Don't run `brew services start mongodb-community`.** Staging starts its own
`mongod` and `staging:down` stops it, so no Mongo runs at login or in the
background. This uses Homebrew rather than Docker because Docker Desktop
wasn't usable on this Mac (its daemon never came up).

## It never touches production

`up` refuses to start if:
- any environment variable contains a production host or path: `swara.studio`,
  `idtap.csail.mit.edu`, `128.52.132.248`, `mongodb.net`, `mongodb+srv`,
  `/data/hai-res`, `/opt/idtap`;
- `MONGO_URI`, `USER_NAME`, `PASSWORD`, `VITE_API_URL`, `PUBLIC_BASE_URL`,
  `IDTAP_MEDIA_ROOT` or `GOOGLE_CLIENT_SECRET` is set at all (staging sets its own);
- the database URI it built is not `mongodb://127.0.0.1` or `localhost`;
- after start, the server or the proxy is listening on anything but 127.0.0.1
  (it stops both and exits).

### Everything outbound, and how each is neutralised

| What the app does | Where | Staging |
|---|---|---|
| **Database.** Without `MONGO_URI` the server builds the **Atlas production URI** from `USER_NAME`/`PASSWORD` | `server.ts` | `MONGO_URI=mongodb://127.0.0.1:27027`, asserted loopback; `USER_NAME`/`PASSWORD` refused |
| **`.env` loading.** `import 'dotenv/config'` reads `.env` from the working directory | `server.ts` | `DOTENV_CONFIG_PATH` points at an empty file; `env -i` drops the shell's variables |
| **Listening on every interface.** `app.listen(3000)` passes no host, so it would put real data on the LAN | `server.ts` | `node --require scripts/staging/localhost-only.cjs` forces every listening socket to 127.0.0.1; checked with `lsof` after start |
| **Frontend API base.** `vite dev` points at `https://swara.studio/` | `src/config.ts` | Staging serves a production build, which talks to its own origin; `VITE_API_URL` is refused and the build runs under `env -i` |
| **Google OAuth.** `/auth/login`, `/auth/callback` (token exchange) and `/api` Bearer verification (`verifyIdToken`) | `authRoutes.ts`, `server.ts` | `GOOGLE_CLIENT_ID`/`SECRET` are dummies, so nothing can sign in through Google; use the staging sign-in below |
| **Python spawns.** Spectrograms, melographs, audio processing, Excel/JSON export, and two midnight cron jobs: `delete_unlinked_audio.py` (**deletes media no DB record links to**) and `backups/backup_mongo.py` | `server.ts`, `apiRoutes.ts` | `IDTAP_PYTHON_PATH=scripts/staging/python-disabled.sh`, which refuses every run and logs what would have run. Those features return errors in staging |
| **Uploads and media.** Uploads and ffmpeg conversion write under the media root; production's is the NFS audio store | `mediaConfig.ts` | `IDTAP_MEDIA_ROOT` and `IDTAP_UPLOAD_TMP` point into the cache dir (empty, local). `/data/hai-res` in the env is refused |
| **Email, notifications, analytics, other third-party APIs** | none | None exist in the server or the web app (checked 2026-11-13; a headless editor session made requests only to 127.0.0.1, `unpkg.com` and `lh3.googleusercontent.com`) |
| **CDN assets.** VexFlow fonts from `cdn.jsdelivr.net` / `unpkg.com` | `global.css`, `index.html` | Left on: read-only public font downloads, no data sent |
| **Avatar image.** The nav bar loads the user's Google profile picture from `lh3.googleusercontent.com` | `NavBar.vue` | Left on: a read-only image request |
| **Server dependencies.** `up` installs `server/package.json` into the app dir, as the deploy does | `staging.sh` | Downloads from the npm registry; nothing sent about the data |
| **Share link.** The editor builds `https://swara.studio/editor?id=…` | `EditorAudioPlayer.vue` | Text only; nothing is requested |

**Media is not copied.** Audio, peaks and spectrograms stay on the production NFS
and are not fetched, so pieces open without audio or a spectrogram image. The
transcription data itself is complete.

## Signing in

Production sign-in is Google OAuth, which can't work locally: the production
client isn't registered for a localhost redirect, and staging gets a dummy
client id. Staging has its own sign-in instead:

- Open `http://127.0.0.1:4000/__staging/login` and pick a user (Jon:
  `jonmyers@mit.edu`), or go straight to `/__staging/login?email=jonmyers@mit.edu`.
- The page sets the app's own `sid` session cookie (the JWT `server/session.ts`
  issues), signed with a random `SESSION_SECRET` generated on each `up`.

**This can't be turned on in production.** It isn't in the app at all.
- It lives in `scripts/staging/proxy.cjs`, a separate local process in front of the
  server, and it's not part of `server/build/server.js` or the web build. Production
  runs `server.js` under systemd and never starts the proxy.
- The proxy refuses to start unless `IDTAP_STAGING=1` and `MONGO_URI` is loopback.
- Its tokens are signed with a per-run secret that production doesn't have, so they
  verify nowhere else.

The app's "Log in with Google" button goes to Google with the dummy client id and
fails there. That's expected.

## Notes

- Port 3000 is fixed in `server.ts`, so staging can't run alongside a `vite dev`
  server on 3000 (`up` checks).
- `up` again re-restores the backup over the staging DB (`--drop`), which discards
  local edits. `--keep-db` restarts the app (for example on another `--checkout`)
  against the staging DB as it is, so you can compare two branches on the same
  data. `--skip-build` reuses the last build.
- Logs: `~/Library/Caches/idtap-staging/logs/{build,server,proxy}.log`.
- `down` stops `mongod`, waits for it to exit, and deletes the whole cache
  directory, database included.
