# IDTAP Codebase Review 2026 — Plan & Progress

Full-codebase review: architecture map, security audit, bug hunt, performance
assessment, modernization roadmap. Done incrementally (one or two subsystems
per sitting) so it survives across sessions and usage windows.

**Branch:** `review/codebase-audit-2026`
**Resume instruction:** "continue the codebase review" — pick the next unchecked item, do it, write the section file, commit, update this checklist.

## Method per sitting
1. Skim structure (grep/headers) before deep-reading; deep-read only load-bearing code.
2. Write findings to `review-2026/<section>.md` — concrete, file:line cited. (NB: `docs/` is gitignored — the review lives at repo-root `review-2026/`.)
3. Update this checklist, commit to the review branch.
4. Note security/bug/perf leads inline in each section; the synthesis pass collects them.

## Sections

- [x] **servers** — DONE → `servers.md`. Headline: ~90 web routes on `app` have NO auth/authz (caller asserts own userID); the `/api` router is correctly gated. Legacy server.js is fully dead (delete it). Several concrete bugs found (missing `/` in spectrogram delete path; api permission query compares Google sub vs Mongo _id).
- [x] **data-model** — DONE → `data-model.md`. Headline: TWO model copies (old `src/js/classes.ts` vs new `src/ts/model/`); BOTH frontend and deployed server bundle use the NEW one (verified against extract.js), so cross-model drift is LATENT not live — but copy A is a landmine (no fromJSON, would silently default non-ET pitches if ever repointed). Delete copy A. LIVE bug: Trajectory.instrumentation not restored on load → vocal reloads as Sitar. Deserialization boundary fully `any`-typed, server tsconfig strict:false. Shared-backend obstacle = the fork + no validated serialization schema across frontend/Node/Python.
- [x] **renderer** — DONE → `renderer.md`. Headline: 4 overlay layers in 1 native-scroll container (+2 axes) = the "6 stacks"; architecture is fine. Block playhead is genuinely motion-free; Animated + DottedLine both run continuous rAF (DottedLine is NOT motion-safe). Reduced-motion is HARDCODED to Jon's userID, no prefers-reduced-motion anywhere in editor. Worst jank = unthrottled per-frame currentTime watcher during PLAYBACK, not scroll. Spectrogram = whole-recording gz blob → worker → 1000px canvas tiles; duplicated lazy-load scheduler in 2 layers; recommend server tile pyramid + shader recolor. WebGL rewrite = wrong first move; 5 surgical fixes get 80% at 10% risk. Unmount leaks (observer + rAF). Dead D3 scrollbars in EditorComponent.
- [x] **editor-core** — DONE → `editor-core.md`. ~150-field god-object; Piece is clean single source of truth but mutated in place everywhere. NO undo/redo, NO autosave (unrecoverable-edit risk). Selection state owned 2 layers down in TranscriptionLayer, surfaced via recomputeTrigger nudge. Severe ref-reach coupling (55 refs, 85 casts, writes into child internals). Polyphonic string-desync bugs: extendDurTot/newTrajEmit don't re-sync string 1; currentStringIdx not reset on instrument switch. Panel bugs (vibrato wrong field, AutomationWindow .values typo, etc.).
- [x] **audio** — DONE → `audio.md`. Live synth path is GOOD (Synths.vue, ~0 any, physical-model worklets). Clock = AudioContext.currentTime (no drift). Two-stage rAF; Animated playhead re-samples clock directly + damps; Block/DottedLine use discretized prop. ~half the worklets are DEAD (karplusStrong v1, extendedKPS, chikaris/chikaris2, sarangi2) incl a name collision; SarangiSynth.vue orphaned. CORRECTION: rubberband/klatt worklets are minified-1-line, not stubs; both live (rubberband=pitch, SoundTouch=tempo, offline only). Bugs: seek-while-playing desyncs synths; rubberBandNode! pre-shift throw; leaks (stretchWorker, Sa osc). MeterControls/SpectrogramControls misplaced in audioPlayer/.
- [x] **frontend-other** — DONE → `frontend-other.md`. serverCalls.ts = 88 endpoints, 0 auth (confirms servers.md client-side); router guard is client-side-only on a self-set cookie. Analysis tools run heavy compute on main thread, duplicate server logic. Bugs: debugger; in prod, CollectionViewer.vue:344 wrong method name → runtime crash, async races, listener leaks.
- [x] **python-pipeline** — DONE → `python-pipeline.md`. CRITICAL #2: hardcoded export_robot Mongo password COMMITTED in backup_mongo.py:4, runs daily in prod cron (.envrc creds are NOT tracked). HIGH: os.system f-string shell injection in mass_upload daemon. 8 disagreeing dependency manifests; /opt/idtap-python provisioned by none; fragile per-file rsync deploy → 3 divergent make_spec_data copies. DSP itself is fine.
- [x] **python-api** — DONE → `python-api.md`. CRITICAL DATA BUG (demonstrated): SERIALIZATION_SYNC_SPEC never applied → Python client returns WRONG pitch frequencies for stripped/non-12-TET data (Yaman 246Hz loads as 261.63Hz, 108 cents off), silent. Tests lock the stale format. Auth: weak Fernet key (static salt), ID token as bearer, no refresh, new-save via unauthenticated legacy route. Shared-backend: 3 model copies, no machine-checked contract → recommend canonical JSON Schema + cross-runtime conformance test.
- [ ] **infra** — package.json scripts, CI workflows, test coverage map, repo hygiene (root cruft, tracked files that shouldn't be) → `infra.md`
- [ ] **synthesis** — final report: prioritized findings (critical security → bugs → perf → hygiene), modernization roadmap (backend unification, renderer rewrite, AI-pipeline readiness), open PR → `REPORT.md`

## Usage notes
- Sitting #1 (servers) is the calibration run — measure window cost before deciding whether to add subagent parallelism for later sections.
- A 10-agent parallel workflow attempt on 2026-06-11 burned ~30% of a usage window in minutes and was killed; avoid full-file fan-out reads.
