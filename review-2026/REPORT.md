# IDTAP Codebase Review 2026 — Synthesis Report

*Prepared June 2026, branch `review/codebase-audit-2026`. Nine subsystem sections live
alongside this file in `review-2026/`; each finding here links to the section with full
file:line detail. This report is the executive layer: what's urgent, what's worth doing, and
how to modernize toward the AI-pipeline / shared-backend / multi-platform future.*

---

## The one-paragraph version

IDTAP is a genuinely sophisticated piece of software — the domain model, the physical-modeling
synths, the microtonal raga framework, and the transcription editor are real, hard-won
engineering, and the *newer* code (the `src/ts/model/` classes, the `/api` router, the model
unit tests) is clean and well-typed. The problems are concentrated in three buckets: **(1) a
security posture that is effectively absent** — the web API has no authentication and is
confirmed internet-reachable, and there's a committed production database password; **(2) two
silent data-integrity bugs** — the Python client returns wrong pitch frequencies, and vocal
trajectories lose their instrument on reload; and **(3) accumulated entropy** — dead code,
duplicated models, fragile deploys, and a renderer whose reduced-motion accommodations are
hardcoded to your user ID. None of this is surprising for a codebase grown organically over
years by a solo researcher, and almost all of it is fixable incrementally. The security items
are the only ones that are genuinely urgent.

---

## Critical findings (act on these first)

### C1. The web API has no authentication — confirmed internet-reachable
The ~90 web routes the Vue app uses (`/updateTranscription`, `/oneTranscription` delete,
`/updateTranscriptionOwner`, `/cloneTranscription`, `/getOneTranscription`, …) sit on `app`
with **no auth middleware and no permission checks**; the client just sends a plaintext
`userID` the server trusts. Verified end-to-end: `serverCalls.ts` attaches zero
tokens/cookies, and the production **nginx config forwards every path to `:3000` with no auth
directive** — so anyone can read/modify/delete any transcription at `https://swara.studio/<route>`
(and over plain HTTP on the bare IP). The router's login gate is a client-side check on a
self-set cookie — UX only. *The correct, permission-checked versions of these operations
already exist in `apiRoutes.ts`.* → `servers.md`, `frontend-other.md`. **You've said low
urgency because traffic is ~nil; that's a reasonable risk call, but this is the thing to fix
before any public re-launch or AI-pipeline exposure.**

### C2. Committed production MongoDB credential
`python/backup_scripts/backup_mongo.py:4` hardcodes the `export_robot` Mongo password in
plaintext, **is git-tracked**, and runs daily in production cron. → `python-pipeline.md`.
**Rotate that credential and move it to env regardless of the C1 timeline** — it's in your git
history. (Your personal `.envrc` creds are *not* tracked, so those are lower priority.)

### C3. Python client returns wrong pitch frequencies (silent data corruption)
PR #887 stripped `ratios`/`fundamental` from the TS Pitch serialization; the
`SERIALIZATION_SYNC_SPEC.md` to port that to Python **was never applied** (still uncommitted,
0/13 edits). Demonstrated empirically: a Yaman transcription (fundamental 246 Hz) loads in the
Python client as **261.63 Hz — off by ~108 cents**, with no error. Any transcription saved by
the current web app, and any non-12-TET raga, is affected. → `python-api.md`. The fix is to
apply the existing spec plus add a stripped-format conformance fixture.

---

## High-priority (correctness & health)

- **H1. Vocal trajectories reload as "Sitar."** `Trajectory.instrumentation` isn't restored in
  `fromJSON`, so after save→reload a vocal trajectory's instrument-conditional logic
  (pluck-stripping) silently stops firing. Live in both the app and the server bundle. →
  `data-model.md`.
- **H2. No undo/redo and no autosave in the editor.** Every edit mutates the Piece in place
  irreversibly; persistence is manual-save only. Together these make a bad edit unrecoverable.
  For a transcription tool this is the most impactful UX/safety gap. → `editor-core.md`.
- **H3. Polyphonic string desync.** `extendDurTot` and `newTrajEmit` edit one string without
  re-aligning the other, and `currentStringIdx` isn't reset on instrument switch — Sitar/Sarangi
  dual-string transcriptions can drift out of temporal alignment. → `editor-core.md`.
- **H4. Shell-injection patterns** in the mass-upload daemon (`os.system` f-strings on
  filenames). Not currently reachable by untrusted input, but fragile. → `python-pipeline.md`.
- **H5. A runtime-crashing bug and a `debugger;` in production** in the non-editor frontend
  (`CollectionViewer.vue:344` calls a non-existent method; `AnalyzerComponent.vue:1733`). →
  `frontend-other.md`.

A consolidated bug list (≈30 concrete file:line items, including audio transport seek-desync,
the spectrogram-delete path bug, several listener/AudioContext leaks, side-effecting
computeds) lives across the section files under each "bug-hunt" lead. Recommend filing these as
issues in a batch.

---

## The reduced-motion / rendering finding (health-specific)

Only **Block mode** is genuinely free of smooth positional motion (your actual trigger; the
opacity *fades* in DottedLine are fine for you). But the accommodation is **hardcoded to your
user ID**, there's **no `prefers-reduced-motion` support** in the editor, and the worst scroll
jank is actually an unthrottled per-frame watcher during *playback*. → `renderer.md`. Five
surgical fixes (real reduced-motion setting, throttle the playback watcher, fix two unmount
leaks, etc.) address both safety and jank at low risk.

**On the WASM/native rendering question:** WASM won't make browser *rendering* fundamentally
smoother — it can't touch the compositor any more directly than JS can; the smoothness lever is
**compositor-driven animation (CSS/WAAPI) + WebGPU**, available from JS today. WASM's real value
is **heavy compute** (spectrogram colorize, DSP, the model math), which is also the genuinely
portable core for an eventual native Swift app. The strategic framing: **share a portable
compute/model core (WASM-friendly), keep rendering platform-native (WebGPU in browser, Metal on
native).** Full discussion in the dialogue; carried into the roadmap below.

---

## Architecture themes (the modernization substrate)

- **The model exists in three copies.** TS copy A (`src/js/classes.ts`, dead — delete it), TS
  copy B (`src/ts/model/`, canonical), and the Python client (drifted — C3). They're kept in
  sync by prose and manual edits, which is exactly why C3 happened. → `data-model.md`,
  `python-api.md`.
- **State & coupling.** `EditorComponent.vue` is a ~150-field god-object coordinating children
  via two ~55-prop interfaces and 85 ref-reach casts that write into child internals; selection
  state lives two layers down and is surfaced by a manual reactivity nudge. Identity is split
  across cookies and Vuex with no single source of truth. → `editor-core.md`, `frontend-other.md`.
- **Dead weight.** ~half the audio worklets are dead (one with a name collision), `server.js` is
  a dead 2180-line duplicate, three legacy build configs, duplicated lazy-load schedulers,
  tracked binary artifacts. → `audio.md`, `infra.md`, `renderer.md`.
- **Deploy fragility.** ~15 per-file Python rsyncs to two hosts, 8 disagreeing dependency
  manifests, a runtime venv (`/opt/idtap-python`) no manifest provisions, and a disabled deploy
  workflow that contradicts the docs. → `python-pipeline.md`, `infra.md`.

---

## Modernization roadmap

Sequenced so each phase is independently valuable and de-risks the next. This is a menu, not a
mandate.

**Phase 0 — Stop the bleeding (days).**
Rotate the committed DB credential (C2). Apply the serialization sync spec + conformance fixture
to fix the Python pitch bug (C3). Fix H1 (instrumentation round-trip). These are small, isolated,
high-value, and don't depend on anything else.

**Phase 1 — Close the security gap (1–2 weeks).**
Make the Vue client carry the Google token on every call (it already obtains one); move the
mutating/reading web routes behind the `/api` auth middleware and reuse the permission checks
already in `apiRoutes.ts`; lock CORS to the real origin. This both fixes C1 and is the
groundwork for backend unification. Do it before any public relaunch or AI-pipeline exposure.

**Phase 2 — Editor safety & the reduced-motion fixes (1–2 weeks).**
Add an edit-history/undo stack and a debounced autosave (H2). Ship the five renderer fixes:
a real reduced-motion user setting + `prefers-reduced-motion`, throttle the playback highlight
watcher, fix the unmount leaks. Fix the polyphonic string-sync bugs (H3). This is the phase that
most improves *your* daily use.

**Phase 3 — Unify the model contract (2–4 weeks).**
Delete TS copy A. Promote the stripped-serialization rules to a **canonical JSON Schema** that
both TS and Python validate against in CI, plus a **cross-runtime conformance test** (one fixture
set loaded through both, asserting frequency-equality) — the thing that would have caught C3
automatically. This is the real foundation for "a common backend for the Python and TypeScript
APIs."

**Phase 4 — Hygiene & deploy (ongoing, parallelizable).**
Delete dead code (server.js, dead worklets, legacy configs, copy A). Consolidate the Python
manifests and the per-file rsync deploy; provision `/opt/idtap-python` from one manifest. Make CI
lint/type-check blocking; reconcile the deploy workflow with reality. Add component tests for the
high-bug-density areas.

**Phase 5 — The longer-horizon rendering/portability bet (when you're ready).**
Extract a portable model+DSP core (the WASM/Swift-shareable piece). Move the spectrogram to a
server-side tile pyramid + WebGPU shader recolor. Consider WebGPU + WAAPI for any genuinely
smooth rendering you want. This is the path that could one day share a core with native
Mac/iPad apps — but it sits on top of Phase 3's unified model, so it comes last.

---

## What's genuinely good (so it doesn't get lost)

The `src/ts/model/` domain model is clean, well-typed, and properly threads tuning context. The
`/api` router is a correct, authenticated, permission-checked REST surface — a ready-made target
for unification. The live synthesis path (`Synths.vue` + the physical-model worklets) is
well-structured with near-zero `any`. The model has real unit-test coverage. The audio clock is
driven correctly off `AudioContext.currentTime`. The recent dependency-security work is diligent.
The bones are good; the work ahead is mostly removing entropy and closing gaps, not rebuilding.

---

## Section index
- `servers.md` — the two servers, the auth gap, route audit
- `data-model.md` — the dual model, serialization, the instrumentation bug
- `renderer.md` — layer stack, playhead/reduced-motion, jank, spectrogram loading, WebGL verdict
- `editor-core.md` — state god-object, no undo/autosave, polyphonic sync
- `audio.md` — Web Audio graph, synths, transport, dead-worklet cruft
- `frontend-other.md` — client API surface, auth, analysis tools, files/collections
- `python-pipeline.md` — server-side Python, the committed credential, deploy chaos
- `python-api.md` — the Python client, the demonstrated pitch bug, shared-backend assessment
- `infra.md` — CI/CD, tests, dependency health, repo hygiene
- `PLAN.md` — the running checklist (all sections complete)
