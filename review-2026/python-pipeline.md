# Review Section: Server-Side Python Pipeline

**Scope:** `python/` (process_audio, visualization_scripts/, visualization_tools/,
dataManagement/, mass_upload/, backup_scripts/, auto_transcribe/, cleanJson/,
pitch_shifting/, essentia/, tests/), invoked from `server/server.ts` via
`spawn('/opt/idtap-python/bin/python', […])`.

**Bottom line:** The live pipeline (upload → tonic detection → format conversion → peaks,
plus async spectrogram/melograph generation) is functional and the DSP is reasonable. But
this subsystem holds the review's **second critical security finding** —
**a hardcoded MongoDB password committed to git and running in production cron** — plus
shell-injection patterns in the mass-upload daemon, an 8-way tangle of disagreeing
dependency manifests, and a fragile per-file rsync deploy that has already produced three
divergent copies of the same script.

---

## CRITICAL — committed production credential

**`python/backup_scripts/backup_mongo.py:4`** hardcodes a plaintext MongoDB connection
string with the `export_robot` password, and **the file is git-tracked** (confirmed:
`git ls-files` lists it). It runs **daily in production** via cron
(`server/server.ts:154`). The password is interpolated into a `mongodump` shell command, so
it's also exposed in the host process table. The same credential is documented in
`CLAUDE.md`'s backup section. **→ Rotate the `export_robot` credential and move it to an env
var.** This is independent of, and on top of, the web-auth gap in `servers.md`.

*(For contrast: `/.envrc` also contains DB credentials — `USER_NAME`/`PASSWORD`, Jon's
personal Mongo user — but `.envrc` is **not** git-tracked, so those aren't in history.
Still worth rotating eventually since the pattern is leaky, but it's not a committed-secret
incident the way `backup_mongo.py` is.)*

## HIGH — shell injection via `os.system` f-strings

- **`mass_upload/directory_watcher.py:52`** — `os.system(f'python3 process_mass_uploaded_audio.py {file_path}')`
  with `file_path` from a filesystem walk, unquoted. This is a **daemon** on the swara.studio
  host; a crafted filename dropped into the watched directory → arbitrary command execution.
- **`mass_upload/process_mass_uploaded_audio.py:17-30`** — ffmpeg commands and a bare
  `os.system(f'python3 make_spec_data.py {rec_id}')` built by f-string from `sys.argv[1]`.
- **`process_audio.py:78-88`** — ffmpeg via `os.system` f-strings on the uploaded filename.
  Today the filename is a server-generated ObjectId (`server.ts:1957`), so it's not directly
  attacker-controlled, but the pattern is one rename from injection.
- The server's *spawn* call sites pass args as arrays (no shell), so the injection risk lives
  *inside* the Python scripts that re-shell via `os.system`. **→ Convert all to
  `subprocess.run([...])` list form.**

---

## 1. Live vs dead inventory

**Server-invoked (live):** `process_audio.py`, `visualization_scripts/make_spec_data.py`,
`visualization_scripts/generate_melograph.py`, `visualization_tools/generate_log_spectrograms.py`,
`cleanJson/make_excel.py`, `dataManagement/aggregations/delete_unlinked_audio.py` (cron),
`backup_scripts/backup_mongo.py` (cron). `pitch_shifting/pitch_shift.py` is clean and
args-driven.

**Manual/daemon:** `mass_upload/*`, `backup_scripts/to_temp_db.py`, DB seeders in
`dataManagement/`, `essentia/update_all_tonics.py`.

**Dead/scratch:** `auto_transcribe/*` (research ML, hardcoded test IDs, a leftover
`breakpoint()`), `essentia/make_spectrogram.py` (**non-functional** — uses `json` without
importing it), numbered scratch dupes `visualization_tools/make_spec_data{,-1,-2}.py`, and
9 of 10 `aggregations/*` are one-off backfills.

**Broken server path:** `/makeMelograph` (`server.ts:1073`) spawns bare `'generate_melograph.py'`
(no dir), but the live copy is under `visualization_scripts/` — likely broken unless deploy
happens to drop a copy at the server cwd. (The working melograph path uses the explicit
`./visualization_scripts/...` at `server.ts:1988`.)

---

## 2. The audio pipeline

`process_audio.py <fn> <aeID> <recIdx> <newId>` (`server.ts:1971`): loads the upload via
Essentia `EasyLoader`, runs **`TonicIndianArtMusic`** for the Sa estimate, writes
`duration`/`saEstimate`/`saVerified=false` back to Mongo (`upsert`), transcodes to
wav/mp3/opus, and computes a 5-level min/max **peaks** envelope → `peaks/<id>.json`.

Spectrogram/melograph are fired **separately and asynchronously** after the upload response
(`server.ts:1990`):
- **`make_spec_data.py`** runs Essentia **NSGConstantQ** (CQT, 72 bins/octave), `log10`, normalizes
  to uint8, and writes `spec_data/<id>/spec_data.gz` (gzipped row-major uint8 image) +
  `spec_shape.json`. This is exactly the blob the frontend worker fetches and pako-inflates
  (`spectrogramWorker.ts:266`).
- **`generate_melograph.py`** runs `PredominantPitchMelodia`, masks low-confidence, splits into
  voiced chunks, downsamples → `melographs/<id>/melograph.json`.
- **`generate_log_spectrograms.py`** builds tiled `.webp` mip-pyramid images (the legacy
  PNG/webp tile path, largely vestigial on the client per `renderer.md`).

Note a real inconsistency: the live `visualization_scripts/make_spec_data.py` has its column
rotation **commented out** (`:60`) while the stale `visualization_tools` copy still applies it
(`:55`) — and the **tests exercise the stale copy**, so the deployed copy has no direct
coverage and the two produce different output.

---

## 3. MongoDB access from Python

Nearly every DB script builds `mongodb+srv://{USER_NAME}:{PASSWORD}@swara.f5cuf.mongodb.net/`
from env vars (good) — **except `backup_mongo.py:4`** (the committed hardcoded credential
above). Backup = `mongodump` to `backups/<date>` daily; restore counterpart `to_temp_db.py`
writes into a `tempSwara` DB. The `aggregations/*` are mostly one-off backfills;
`delete_unlinked_audio.py` (cron) deletes orphaned audio files via an `$objectToArray`
pipeline over `audioEvents.recordings`.

---

## 4. Dependency & environment chaos

**8+ competing, disagreeing manifests:** `/requirements.txt` (server set: essentia, numpy,
pymongo…), `/py_requirements.txt` (one line: `pymongo`), `/porting_requirements.txt` (test
tooling), `/pyproject.toml` **and** `/setup.py` (both describe the *client* `idtap_api` package
— now a separate repo — with a disjoint dep set, no essentia/numpy), three committed virtualenv
dirs (`api_env/`, `idtp_env/`, `.venv-test/`), and `/.envrc` referencing `pipenv` with **no
Pipfile present**. The real runtime, `/opt/idtap-python`, is a hand-built venv on the host that
**no manifest in the repo provisions** — deployment never runs `pip install` against any of
them (contrast the Node side's `pnpm install --frozen-lockfile`). Classic "manifests diverged
from reality."

**Deploy model — per-file rsync, fragile:** ~15 individual `package.json` scripts push single
files to **two** hosts (`137.184.90.119` and `swara.studio`). No atomicity/versioning; a
forgotten `deployX` leaves a stale script live — which is exactly how the three `make_spec_data`
copies and the broken bare `generate_melograph` reference arose.

---

## 5. Health & test coverage

Python 3 throughout, minimal error handling (scripts assume `sys.argv` positions and connect to
Mongo at import). Pervasive hardcoded paths/IDs and debug artifacts (`test.png` always written
by `generate_log_spectrograms.py:74`). Tests (`python/tests/`) are well-isolated (autouse
fixture strips DB creds) but thin and **partly misdirected**: `make_spec_data` tests import the
*stale* copy; `process_audio.py`/`make_excel.py` get only `py_compile` syntax checks plus tests
against hand-copied re-implementations that can drift from the real source.

**Prioritized leads:** (1) rotate + de-hardcode `backup_mongo.py:4`; (2) convert the `os.system`
f-strings to `subprocess.run([...])`; (3) reconcile the three `make_spec_data` copies and point
tests at the deployed one; fix the broken bare `generate_melograph` reference
(`server.ts:1073`); (4) consolidate the 8 manifests and provision `/opt/idtap-python` from one;
reconsider the per-file rsync deploy.
