#!/usr/bin/env bash
# IDTAP local staging: a throwaway copy of production data on this Mac.
#
#   pnpm staging:up   [--archive PATH] [--checkout DIR] [--skip-build] [--keep-db]
#   pnpm staging:status
#   pnpm staging:down
#
# up:   fetch the newest nightly backup (agents:/data/hai-res/idtap/backups/mongo/,
#       over `ssh agents`; no VPN or Duo) or use --archive; restore it into a
#       throwaway user-level mongod (Homebrew mongodb-community; --dbpath in the
#       cache dir, --bind_ip 127.0.0.1; no brew service, no launchd, nothing at
#       login); build and start the server + web app
#       from --checkout (default: this checkout) against it; print the URL.
# down: stop everything and delete the database and every restored file.
#
# See docs/STAGING.md. Nothing here talks to production except the one read-only
# scp of the backup file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING_DIR="${IDTAP_STAGING_DIR:-$HOME/Library/Caches/idtap-staging}"
MONGO_PORT="${IDTAP_STAGING_MONGO_PORT:-27027}"
STAGING_PORT="${IDTAP_STAGING_PORT:-4000}"
APP_PORT=3000   # fixed in server.ts (app.listen(3000))
BACKUP_HOST=agents
BACKUP_DIR=/data/hai-res/idtap/backups/mongo

die() { echo "staging: $*" >&2; exit 1; }
say() { echo "staging: $*"; }

# ---------------------------------------------------------------- safety
# Anything that identifies production. If one of these is in the environment
# the run refuses to start: a stray MONGO_URI or VITE_API_URL is how a "local"
# server ends up writing to the real database.
PROD_PATTERN='swara\.studio|idtap\.csail\.mit\.edu|128\.52\.132\.248|mongodb\.net|mongodb\+srv|/data/hai-res|/opt/idtap'

assert_env_clean() {
  local hits
  hits="$(env | grep -iE "$PROD_PATTERN" | cut -d= -f1 || true)"
  [ -z "$hits" ] || die "refusing to start: production host or URI in the environment: $(echo $hits)"
  # Variables that would redirect the app even without a production value.
  for v in MONGO_URI USER_NAME PASSWORD VITE_API_URL PUBLIC_BASE_URL IDTAP_MEDIA_ROOT GOOGLE_CLIENT_SECRET; do
    [ -z "$(printenv "$v" || true)" ] || die "refusing to start: $v is set in the environment; unset it (staging sets its own)"
  done
}

assert_local_uri() {
  case "$1" in
    mongodb://127.0.0.1:*|mongodb://localhost:*) ;;
    *) die "refusing: database URI is not loopback: $1" ;;
  esac
  echo "$1" | grep -qiE "$PROD_PATTERN" && die "refusing: database URI looks like production: $1"
  return 0
}

assert_staging_dir() {
  case "$STAGING_DIR" in
    "$HOME"/*) ;;
    *) die "IDTAP_STAGING_DIR must be under \$HOME, got $STAGING_DIR" ;;
  esac
  echo "$STAGING_DIR" | grep -qiE "$PROD_PATTERN" && die "IDTAP_STAGING_DIR looks like a production path"
  case "$STAGING_DIR" in "$CHECKOUT"/*) die "IDTAP_STAGING_DIR must be outside the repo";; esac
  return 0
}

need_mongo() {
  for b in mongod mongorestore mongosh; do
    command -v "$b" >/dev/null || die "$b not found. Install once with:
    brew tap mongodb/brew && brew install mongodb-community mongodb-database-tools
  (do NOT run 'brew services start': staging starts mongod itself, only while it is up)"
  done
}

# ---------------------------------------------------------------- args
CMD="${1:-}"; shift || true
ARCHIVE=""; CHECKOUT="$(git -C "$HERE" rev-parse --show-toplevel)"; SKIP_BUILD=0; KEEP_DB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --checkout) CHECKOUT="$(cd "$2" && git rev-parse --show-toplevel)"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep-db) KEEP_DB=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
MONGO_URI="mongodb://127.0.0.1:${MONGO_PORT}"

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

stop_pidfiles() {
  for f in "$@"; do
    if pid_alive "$f"; then kill "$(cat "$f")" 2>/dev/null || true; fi
    rm -f "$f"
  done
}
# the app server and the proxy (mongod keeps running)
stop_app() { stop_pidfiles "$STAGING_DIR/run/proxy.pid" "$STAGING_DIR/run/server.pid"; }
# everything, mongod included
stop_procs() { stop_app; stop_pidfiles "$STAGING_DIR/run/mongod.pid"; }

# ---------------------------------------------------------------- up
up() {
  assert_env_clean
  assert_staging_dir
  assert_local_uri "$MONGO_URI"
  need_mongo
  if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! pid_alive "$STAGING_DIR/run/server.pid"; then
    die "port $APP_PORT is already in use by another process (a vite dev server?); stop it first"
  fi
  mkdir -p "$STAGING_DIR"/{backup,media,tmp,run,logs,db}
  chmod 700 "$STAGING_DIR"

  # 1. the backup (--keep-db: restart the app on another checkout against the
  #    staging DB as it is, edits included; needs a running staging mongod)
  if [ $KEEP_DB -eq 1 ]; then
    pid_alive "$STAGING_DIR/run/mongod.pid" || die "--keep-db needs a running staging database (run staging:up first)"
  elif [ -n "$ARCHIVE" ]; then
    [ -f "$ARCHIVE" ] || die "no such archive: $ARCHIVE"
    cp "$ARCHIVE" "$STAGING_DIR/backup/"
    ARCHIVE="$STAGING_DIR/backup/$(basename "$ARCHIVE")"
  else
    say "finding the newest backup on $BACKUP_HOST:$BACKUP_DIR"
    local newest
    newest="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$BACKUP_HOST" \
      "ls -1t $BACKUP_DIR/swara-*.archive.gz | head -1" 2>/dev/null | tail -1)"
    [ -n "$newest" ] || die "could not list $BACKUP_DIR on $BACKUP_HOST (is the agents tunnel up? see 'fleet tunnel status')"
    case "$newest" in "$BACKUP_DIR"/swara-*.archive.gz) ;; *) die "unexpected backup name: $newest";; esac
    ARCHIVE="$STAGING_DIR/backup/$(basename "$newest")"
    if [ ! -f "$ARCHIVE" ]; then
      say "copying $(basename "$newest")"
      scp -q -o BatchMode=yes "$BACKUP_HOST:$newest" "$ARCHIVE.part" && mv "$ARCHIVE.part" "$ARCHIVE"
    fi
  fi
  [ $KEEP_DB -eq 1 ] || gzip -t "$ARCHIVE" || die "archive is not valid gzip: $ARCHIVE"

  # 2. a throwaway mongod on loopback (a plain user process), then the restore
  if ! pid_alive "$STAGING_DIR/run/mongod.pid"; then
    if lsof -nP -iTCP:"$MONGO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      die "port $MONGO_PORT is in use by another process; set IDTAP_STAGING_MONGO_PORT"
    fi
    say "starting mongod $(mongod --version | sed -n 's/^db version //p') on 127.0.0.1:$MONGO_PORT"
    nohup mongod --dbpath "$STAGING_DIR/db" --bind_ip 127.0.0.1 --port "$MONGO_PORT" \
      --logpath "$STAGING_DIR/logs/mongod.log" </dev/null >/dev/null 2>&1 &
    echo $! >"$STAGING_DIR/run/mongod.pid"
  fi
  local i=0
  until mongosh --quiet "$MONGO_URI" --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1; do
    i=$((i+1)); [ $i -lt 60 ] || { tail -5 "$STAGING_DIR/logs/mongod.log" >&2; die "mongod did not come up"; }
    pid_alive "$STAGING_DIR/run/mongod.pid" || { tail -5 "$STAGING_DIR/logs/mongod.log" >&2; die "mongod exited"; }
    sleep 1
  done
  if [ $KEEP_DB -eq 1 ]; then say "keeping the current staging database"; else
  say "restoring $(basename "$ARCHIVE") (drops the staging copy first)"
  mongorestore --quiet --uri "$MONGO_URI" --drop --gzip --archive="$ARCHIVE" --nsInclude='swara.*'
  mongosh --quiet "$MONGO_URI/swara" --eval \
    'print("restored: " + db.transcriptions.countDocuments() + " transcriptions, " + db.users.countDocuments() + " users")'
  fi

  # 3. build and start the app from the checkout
  [ -d "$CHECKOUT/node_modules" ] || (cd "$CHECKOUT" && pnpm install --frozen-lockfile)
  if [ $SKIP_BUILD -eq 0 ]; then
    say "building $CHECKOUT ($(git -C "$CHECKOUT" rev-parse --abbrev-ref HEAD) @ $(git -C "$CHECKOUT" rev-parse --short HEAD))"
    # a clean environment: no VITE_API_URL can sneak a production API into the bundle
    (cd "$CHECKOUT" && env -i PATH="$PATH" HOME="$HOME" pnpm -s build >"$STAGING_DIR/logs/build.log" 2>&1) \
      || die "web build failed, see $STAGING_DIR/logs/build.log"
    (cd "$CHECKOUT" && env -i PATH="$PATH" HOME="$HOME" pnpm -s buildServer >>"$STAGING_DIR/logs/build.log" 2>&1) \
      || die "server build failed, see $STAGING_DIR/logs/build.log"
  fi
  grep -qE "swara\.f5cuf|mongodb\+srv" "$CHECKOUT/server/build/server.js" && \
    say "note: the bundle still contains the Atlas fallback URI; MONGO_URI below overrides it"

  # The production app-dir layout (.github/workflows/update-changelog.yml): the
  # bundle is built with --packages=external, so its runtime deps come from
  # server/package.json installed into the app dir, next to server.js and dist/.
  local APP="$STAGING_DIR/app"
  mkdir -p "$APP"
  cp "$CHECKOUT/server/package.json" "$APP/package.json"
  (cd "$APP" && env -i PATH="$PATH" HOME="$HOME" pnpm install --prod --no-frozen-lockfile --prefer-offline \
    >>"$STAGING_DIR/logs/build.log" 2>&1) || die "server dependency install failed, see $STAGING_DIR/logs/build.log"
  rsync -a --delete "$CHECKOUT/dist/" "$APP/dist/"
  cp "$CHECKOUT/server/build/server.js" "$APP/server.js"

  stop_app
  : > "$STAGING_DIR/run/empty.env"
  local secret; secret="$(openssl rand -hex 32)"
  # Everything the server sees. env -i drops whatever the shell had.
  local -a ENV=(
    PATH="$PATH" HOME="$HOME"
    IDTAP_STAGING=1
    NODE_OPTIONS="--require $HERE/localhost-only.cjs"
    DOTENV_CONFIG_PATH="$STAGING_DIR/run/empty.env"   # dotenv/config: never read a checkout .env
    MONGO_URI="$MONGO_URI"
    SESSION_SECRET="$secret"
    GOOGLE_CLIENT_ID="staging-disabled.apps.googleusercontent.com"
    GOOGLE_CLIENT_SECRET="staging-disabled"
    PUBLIC_BASE_URL="http://127.0.0.1:${STAGING_PORT}"
    IDTAP_MEDIA_ROOT="$STAGING_DIR/media"
    IDTAP_UPLOAD_TMP="$STAGING_DIR/tmp/"
    IDTAP_PYTHON_PATH="$HERE/python-disabled.sh"
  )
  for kv in "${ENV[@]}"; do
    case "${kv%%=*}" in PATH|HOME) continue;; esac
    echo "$kv" | grep -qiE "$PROD_PATTERN" && die "refusing: ${kv%%=*} looks like production"
  done
  assert_local_uri "$MONGO_URI"
  # `cd` first and on its own, so `$!` is node's pid (not a subshell's), and
  # stdin/stdout are detached so nothing holds the caller's terminal or pipe
  cd "$APP"
  env -i "${ENV[@]}" nohup node server.js </dev/null >"$STAGING_DIR/logs/server.log" 2>&1 &
  echo $! >"$STAGING_DIR/run/server.pid"
  env -i "${ENV[@]}" STAGING_PORT="$STAGING_PORT" STAGING_CHECKOUT="$CHECKOUT" \
    nohup node "$HERE/proxy.cjs" </dev/null >"$STAGING_DIR/logs/proxy.log" 2>&1 &
  echo $! >"$STAGING_DIR/run/proxy.pid"
  cd - >/dev/null
  i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STAGING_PORT}/session/me" 2>/dev/null)" = 401 ]; do
    i=$((i+1))
    if [ $i -ge 90 ] || ! pid_alive "$STAGING_DIR/run/server.pid"; then
      tail -20 "$STAGING_DIR/logs/server.log" >&2; stop_procs; die "the server did not come up"
    fi
    sleep 1
  done
  # every listening socket of the server and the proxy must be loopback-only
  local pid addrs
  for pid in "$(cat "$STAGING_DIR/run/server.pid")" "$(cat "$STAGING_DIR/run/proxy.pid")" "$(cat "$STAGING_DIR/run/mongod.pid")"; do
    addrs="$(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p')"
    [ -n "$addrs" ] || { stop_procs; die "could not read the listening sockets of pid $pid"; }
    if echo "$addrs" | grep -qv '^127\.0\.0\.1:'; then
      stop_procs; die "pid $pid listens beyond loopback ($(echo $addrs)); stopped everything"
    fi
  done
  echo "$CHECKOUT" >"$STAGING_DIR/run/checkout"
  say "up. Local copy of production data; nothing here reaches production."
  echo
  echo "  App:      http://127.0.0.1:${STAGING_PORT}/"
  echo "  Sign in:  http://127.0.0.1:${STAGING_PORT}/__staging/login"
  echo "  Checkout: $CHECKOUT ($(git -C "$CHECKOUT" rev-parse --abbrev-ref HEAD))"
  echo "  Logs:     $STAGING_DIR/logs/"
  echo "  Stop + wipe: pnpm staging:down"
}

# ---------------------------------------------------------------- down
down() {
  assert_staging_dir
  stop_procs
  # mongod may take a moment to flush and exit after SIGTERM
  local i=0
  while pgrep -f "mongod --dbpath $STAGING_DIR/db" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  if [ -d "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; say "stopped mongod and deleted $STAGING_DIR (database, backup, media, logs)"; fi
}

status() {
  pid_alive "$STAGING_DIR/run/server.pid" && echo "server: running (pid $(cat "$STAGING_DIR/run/server.pid"))" || echo "server: stopped"
  pid_alive "$STAGING_DIR/run/proxy.pid" && echo "proxy:  http://127.0.0.1:${STAGING_PORT}/" || echo "proxy:  stopped"
  pid_alive "$STAGING_DIR/run/mongod.pid" && echo "mongod: 127.0.0.1:${MONGO_PORT} (pid $(cat "$STAGING_DIR/run/mongod.pid"))" || echo "mongod: stopped"
  [ -f "$STAGING_DIR/run/checkout" ] && echo "checkout: $(cat "$STAGING_DIR/run/checkout")"
  ls "$STAGING_DIR/backup" 2>/dev/null | sed 's/^/backup: /'
}

case "$CMD" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) die "usage: staging.sh up|down|status [--archive PATH] [--checkout DIR] [--skip-build]" ;;
esac
