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
- [ ] **editor-core** — EditorComponent.vue + editor panels: state management, interaction model, polyphonic string coordination → `editor-core.md`
- [ ] **audio** — audioPlayer/, audioWorklets/, synths/: Web Audio graph, synthesis engines, playhead position flow, spectrogram loading → `audio.md`
- [ ] **frontend-other** — analysis/, files/, collections/, audioRecordings/, router, serverCalls.ts: client API surface, auth guards, state patterns → `frontend-other.md`
- [ ] **python-pipeline** — python/ (visualization, dataManagement, mass_upload, backups): invocation paths, deploy fragility, dependency-manifest sprawl → `python-pipeline.md`
- [ ] **python-api** — ../Python-API repo: data-class parity with TS model, serialization sync status, shared-backend requirements → `python-api.md`
- [ ] **infra** — package.json scripts, CI workflows, test coverage map, repo hygiene (root cruft, tracked files that shouldn't be) → `infra.md`
- [ ] **synthesis** — final report: prioritized findings (critical security → bugs → perf → hygiene), modernization roadmap (backend unification, renderer rewrite, AI-pipeline readiness), open PR → `REPORT.md`

## Usage notes
- Sitting #1 (servers) is the calibration run — measure window cost before deciding whether to add subagent parallelism for later sections.
- A 10-agent parallel workflow attempt on 2026-06-11 burned ~30% of a usage window in minutes and was killed; avoid full-file fan-out reads.
