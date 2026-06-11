# Review Section: The Python API Client (idtap-api)

**Scope:** the separate repo `../Python-API/` (PyPI `idtap-api`, v0.1.43) — the third
independent reimplementation of the IDTAP domain model — and its serialization parity with
the TS model.

**Bottom line — there's a live data-integrity bug.** The Python client **silently returns
wrong pitch frequencies** for any transcription saved by the current web app, and for any
non-default-fundamental raga whose pitches omit embedded ratios. This was demonstrated
empirically, not inferred (below). The root cause: PR #887 stripped `ratios`/`fundamental`
from the TS Pitch serialization, the `SERIALIZATION_SYNC_SPEC.md` was written to port that
change to Python — and **the Python side was never updated** (the spec is even uncommitted).
Separately, the client's auth has a weak encrypted-storage key, uses the ID token as an API
bearer, and routes new-transcription saves through the *unauthenticated* legacy endpoint.

---

## 1. The data-integrity bug (priority) — demonstrated

The TS Pitch now emits only `{swara, raised, oct, logOffset}` and **re-threads
ratios/fundamental from the raga on read** (`src/ts/model/pitch.ts:485-503`; chain
Piece→Phrase→Trajectory→Pitch.fromJSON). The Python side does none of this:

- `Pitch.to_json` (`pitch.py:201`) still emits `ratios`/`fundamental`; `from_json`
  (`pitch.py:394`) is `cls(obj)` with **no ratios/fundamental params**.
- `Trajectory`/`Phrase`/`Piece` `from_json` never accept or thread raga context
  (`trajectory.py:936`, `phrase.py:560`, `piece.py:1451` calls `Phrase.from_json(p)` bare;
  it never reads `raga.stratified_ratios`, which exists at `raga.py:458` but is unused on
  read).

**Empirical demonstration** (the agent loaded the repo's own fixture, raga Yaman /
fundamental 246 Hz, whose track-0 pitches carry no embedded ratios):
- Loaded `fundamental = 261.63`, `frequency = 261.63 Hz` (the 12-TET default).
- Correct value = **246.0 Hz**. Off by ~108 cents — a different pitch.
- Track 1/2 pitches happen to carry embedded ratios and load correctly → this is exactly the
  "mixed JSON" hazard. The failure is **silent**: `Pitch.__init__` defaults fill 261.63 +
  12-TET without error.

So any stripped-format JSON from the updated web app loads at the wrong frequency in Python.
The spec's implementation checklist (`SERIALIZATION_SYNC_SPEC.md:768`) is **0/13 done**.

**This supersedes the prior project note** that treated the sync spec as "written for
handoff" — the handoff never happened; the Python client is producing wrong data now. → This
is the single highest-value Python-side fix; the spec is a faithful, complete 13-edit recipe.

---

## 2. Tests lock in the stale format

The serialization tests **would block the fix and validate against stale data**:
- `pitch_test.py:37` asserts `to_json()` **includes** `ratios`/`fundamental` — contradicts
  the spec target; fails the moment the sync is applied.
- `pitch_test.py:449` round-trip passes today **only because** `to_json` still embeds the
  fields, so `from_json` reads them back.
- `piece_test.py:95` compares Python-to-Python (`to_json → from_json → to_json`) — it cannot
  detect drift from the TS contract.
- The fixture `serialization_test.json` is **old full-format data** (legacy `durArray`,
  per-phrase `raga`, per-traj `name`/`tags`, mixed pitch ratios). There is **no fixture in
  the new stripped format**, so nothing exercises the threading path. Round-trip "safety"
  today is an artifact of the un-stripped serializer, not real cross-client compatibility.

---

## 3. API coverage & auth

**Coverage:** `SwaraClient` (`client.py:25`) correctly uses the authenticated `/api/*`
surface with `Authorization: Bearer <id_token>` for most operations (get/save/list
transcription, excel/json export, upload audio, metadata, visibility, waiver) and the
`/oauth/*` flow for login. **One gap:** `save_transcription` (`client.py:733`) routes pieces
*without* an `_id` through `insert_new_transcription` → the **legacy, unauthenticated**
`POST /insertNewTranscription` (`server.ts:262`), trusting the client-supplied `userID`.
Existing pieces correctly use the permission-checked `POST /api/transcription`. → Route all
saves through `/api/transcription` (which already handles the insert branch).

**Auth flow:** server-mediated OAuth2 auth-code flow with a transient localhost server,
CSRF `state` check, token exchange at `/oauth/token`. Concerns:
- **Weak encrypted-storage key.** The Fernet-fallback key is PBKDF2 over
  `f"{username}:{service}:{machine_id}"` with a **hardcoded static salt `b'swara_salt'`**
  (`secure_storage.py:231`); on macOS/Windows `machine_id` falls back to `hostname:username`
  (`:326`). The key is reconstructible by anyone knowing the (guessable) username+hostname —
  obfuscation, not encryption. The static salt defeats PBKDF2.
- **ID token used as API bearer** (`client.py:80`) — ID tokens are for identity, not API
  access; a known anti-pattern.
- **No refresh.** `refresh_token` is stored but never used (`auth.py:141`); on expiry the
  client just clears tokens and demands interactive re-login. Plaintext fallback writes the
  refresh token in cleartext (`secure_storage.py:278`).

---

## 4. Shared-backend assessment (feeds the roadmap)

This is the clearest argument in the whole review for backend unification, because the §1 bug
is the **predictable failure mode** of the current arrangement: three hand-maintained model
copies (TS copy A dead, TS copy B canonical, Python), synced by prose specs and manual edits,
with no machine-checked contract. A TS PR shipped, a Markdown handoff was written, and Python
silently never caught up — with **zero test failures**.

**What's duplicated:** (1) the model itself — `pitch/trajectory/phrase/piece/raga.py` are
line-by-line reimplementations of `src/ts/model/*`, including the trajectory synthesis math
and constructor side effects; (2) two independent `to_json`/`from_json` pairs with two
notions of which fields exist (the thing that drifted); (3) **validation** — Python has an
*extra* `_validate_*` layer (`trajectory.py:264`, `piece.py:240`) that can reject inputs the
TS app/server accept, and vice versa; (4) the `explicitPermissions` schema encoded in three
places; (5) camelCase↔snake_case bridging with a hand-maintained preserve-list (`utils.py:20`).

**Concrete unification path:**
- A **single canonical JSON Schema** (or shared IDL) for the transcription document,
  consumed and validated by both runtimes in CI. The stripped contract is already prose in
  `SERIALIZATION_SYNC_SPEC.md` — promote it to a schema artifact.
- The **raga-threading rule is the hardest invariant** ("pitch frequency is only
  reconstructible with raga context") — a schema can't express that cross-reference; it needs
  a documented post-deserialization threading step both runtimes implement identically. This
  is the thing most likely to keep silently diverging, so it needs an explicit
  **cross-runtime conformance test** (load one shared fixture through *both* TS and Python,
  assert frequency-equality). That test would have caught §1 instantly.
- Validation should live in **one tier (the server)**; thin the Python per-field validation
  to schema-conformance.

**Biggest obstacle:** the model is **behavior, not just data** — trajectory synthesis,
constructor side effects that mutate `dur_array`/`articulations`, group/section
reconstruction in `from_json`. A shared *serialization schema* is achievable and high-value
but does **not** unify the ~2000 lines of duplicated musical logic. Truly sharing that
requires either a single source-of-truth implementation (TS→WASM, or a language-neutral core
service the Python client calls instead of reimplementing — note this connects to the WASM
discussion: the *model/DSP core* is the portable piece) or accepting duplicate behavior pinned
by a shared conformance suite. The latter is the pragmatic near-term move and would have
prevented this exact regression.

---

## Leads handed to later phases

**Bug-hunt / data-integrity (urgent):** apply `SERIALIZATION_SYNC_SPEC.md` to the Python code
and add a stripped-format conformance fixture; until then the client returns wrong pitches.
**Security:** weak Fernet key derivation + static salt (`secure_storage.py:231`); ID token as
bearer (`client.py:80`); new-transcription save via unauthenticated legacy route
(`client.py:733` → `server.ts:262`); no token refresh.
**Modernization:** canonical JSON Schema + cross-runtime conformance test as the unification
spine; consolidate validation server-side; treat the model/DSP core as the portable WASM/Swift
candidate (see the rendering & portability note in `REPORT.md`).
