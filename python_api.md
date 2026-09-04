# Python API & Server Overview

This document captures the high‑level structure of the IDTAP server API (TypeScript) and the
Python client library (`idtap`), so you (the developer/agent) can refer to it when working
on the Python side of the project.

---

## 1. Server‑Side API (TypeScript)

All server code lives under `server/`.  Key pieces:

- **`server/apiRoutes.ts`**
  - Defines authenticated `/api/...` endpoints, e.g.:
    - `GET /api/transcriptions`
    - `GET /api/transcription/:id`
    - `GET /api/transcription/:id/json`
    - `GET /api/transcription/:id/excel`
    - `POST /api/transcription`
    - `POST /api/visibility`

- **`server/oauthRoutes.ts`**
  - Defines unauthenticated `/oauth/...` endpoints for Python/other clients:
    - `GET  /oauth/authorize` → returns Google OAuth URL (`auth_url`).
    - `POST /oauth/token`     → exchanges code for tokens and user profile.

- **`server/server.ts`**
  - Bootstraps Express, middleware (CORS, bodyParser, Google token verification),
    MongoDB connections, and mounts `apiRoutes` and `oauthRoutes`.

---

## 2. Python Client Library (`idtap`)

The Python client no longer lives in this repo. It was extracted to its own repository,
[`HAI-Res/idtap-client`](https://github.com/HAI-Res/idtap-client), and is published to PyPI as
`idtap` (the package was formerly named `idtap_api`). Install it with `pip install idtap` /
`uv pip install idtap`; module paths below are relative to that repo's `idtap/` package.
It provides:

1. **`auth.py`** (OAuth flow via server):
   - `login_google()`: opens browser, captures redirect, then POSTs to `/oauth/token`.
   - `load_token()` / `clear_token()`: migrate & retrieve stored tokens (keyring, encrypted, legacy).

2. **`secure_storage.py`** (secure token storage):
   - Preferred: OS keyring;
   - Fallback: encrypted file (`~/.swara/.tokens.enc`);
   - Legacy: plaintext (`~/.swara/token.json`).

3. **`client.py`** (HTTP client wrapper):
   - `SwaraClient`: handles token loading/auto‑login and wraps server routes:
     - `.get_piece(id)`, `.excel_data(id)`, `.json_data(id)`
     - `.save_piece(piece_dict)`
     - `.insert_new_transcription(piece_dict)` — insert a new transcription for the current user
     - `.get_viewable_transcriptions(...)`
     - `.update_visibility(artifactType, _id, explicitPermissions)`

4. **Data classes** under `idtap/classes/`:
   - `Articulation`, `Automation`, `Assemblage`, `Chikari`, `Group`, `Meter`,
     `NoteViewPhrase`, `Piece`, `Phrase`, `Pitch`, `Raga`, `Section`, `Trajectory`.
   - Enums in `idtap/enums.py` (e.g. `Instrument`).

---

## 3. Installation & Tests

Server-side Python (the scripts under `python/`) uses a uv-managed virtualenv at `.venv-test`.
`run_tests.sh` creates it on first run, so there is nothing to install by hand:

```bash
# Run all server-script tests (creates .venv-test via uv if missing)
./python/run_tests.sh

# Narrow the run
./python/run_tests.sh -k import
```

Dependencies come from `requirements.txt`; CI does the same thing (`.github/workflows/ci.yml`).
Client-library tests live in the `idtap-client` repo, not here.

```python
from idtap import SwaraClient, Piece

client = SwaraClient(base_url="https://swara.studio/")
# auto‑login via browser/OAuth
data = client.get_piece("abc123")
```

---

_Keep this file updated as the server routes or Python client methods evolve._