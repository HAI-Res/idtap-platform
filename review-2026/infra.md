# Review Section: Build, Deploy, CI, Tests, Repo Hygiene

**Scope:** `package.json` scripts, `.github/workflows/*`, `vite.config.js`/`tsconfig.json`,
the test setup, dependency health, and repo hygiene (root-level files, tracked artifacts,
secrets).

**Bottom line:** No new critical security issue here (the tracked `.env` holds only
`PYTHONPATH`, not a secret — good). The story is **drift and clutter**: the GitHub Actions
deploy workflow is **disabled** while `CLAUDE.md` documents automatic deployment, Node
versions disagree across three workflows, CI **ignores lint failures**, model unit-test
coverage is genuinely good but there are **zero component/renderer/audio/editor tests**, and
the repo root carries ~15 pieces of legacy build cruft plus tracked binary test artifacts.

---

## 1. CI/CD — works, but drifted and inconsistent

**`ci.yml`** (push/PR to `main`): two jobs. `test` — Node `22.9.0`, pnpm, `lint`, `pnpm test`
(vitest), `build`. `test-python` — `uv`, Python `3.11`. Reasonable shape. Two issues:
- **Lint failures are swallowed:** `pnpm run lint || echo "Linting failed but continuing…"`
  (`ci.yml:32`). Lint is decorative — it never blocks.
- No type-check gate beyond what `build` happens to enforce.

**`deploy.yml.disabled`** — the frontend rsync-deploy workflow is **disabled** (renamed with
`.disabled`). Yet `CLAUDE.md` states "Frontend deployment is fully automated via GitHub
Actions … Triggers: Push to `main`." **These contradict each other.** Either the docs are
stale and frontend deploy is now manual (`pnpm deployDist`), or deploy happens by some
out-of-band mechanism. → Verify how the frontend actually reaches `/var/www/html` today and
fix the docs. (The disabled workflow also uses Node 18 and an `RSYNC_PASSWORD` secret.)

**`update-changelog.yml`** — generates the changelog from conventional commits on push to
`main`, then rebuilds. Uses Node `16` in one job and `22.9.0` in another.

**Node-version sprawl:** `22.9.0` (ci), `16` (changelog job 1), `18` (deploy.disabled), `22.9.0`
(changelog job 2). Pick one and pin it (`.nvmrc`/`engines`).

**`claude.yml` / `claude-review.yml`** — the Claude PR-review integrations; fine.

---

## 2. Tests

**TS model coverage is good.** 16 vitest specs in `src/ts/tests/` cover the domain model
class-by-class: `pitch`, `trajectory`, `phrase`, `piece`, `raga`, `section`, `group`,
`articulation`, `automation`, `chikari`, `assemblage`, `noteViewPhrase`, `meter`, plus
`apiRoutes.test.ts` and `phraseCategorizationPreservation.test.ts`. This is the healthiest
tested layer in the project.

**Gaps:**
- **Zero component tests.** No Vue component is tested — nothing for the renderer, editor,
  audio player, or analysis tools (the 8k-line `TranscriptionLayer.vue`, the playhead
  reduced-motion modes, the audio transport seek logic — all untested). Given the bug density
  found in those areas (see `renderer.md`, `editor-core.md`, `audio.md`), this is the biggest
  coverage gap.
- **Duplicate `meter.test.js` AND `meter.test.ts`** — likely one is stale.
- The fixture `src/ts/tests/fixtures/serialization_test.json` is the **same stale full-format
  data** as the Python side (see `python-api.md`); the model round-trip tests validate against
  pre-strip data, so they don't exercise the stripped-format path either. No stripped-format
  fixture exists on either side — the cross-runtime conformance gap is systemic.

---

## 3. Dependency health

The `package.json` `pnpm.overrides` block (~25 entries: `axios`, `vite`, `body-parser`,
`qs`, `node-forge`, `jws`, etc.) is a visible **history of vulnerability patching** —
transitive deps force-bumped to patched versions. That's diligent, but a large overrides
block is also a maintenance smell (it papers over outdated direct deps). Worth periodically
bumping the direct dependencies so the overrides can shrink. Recent commits (`f6a6f9ac`,
the dependabot merges) show active security-update work — good.

Build toolchain is modern (Vite 7, esbuild, vitest, Node 22). The lingering inconsistency is
Python (see `python-pipeline.md` — 8 manifests, `/opt/idtap-python` provisioned by none).

---

## 4. Repo hygiene — clutter, legacy configs, tracked artifacts

**Legacy build configs for a Vite project (delete):** `webpack.config.js`, `vue.config.js`,
`alt_vue.config.js` all sit at the root alongside the live `vite.config.js`. The project
builds with Vite; these three are dead. Likewise `tslint.json` (TSLint is deprecated; ESLint
is the live linter) and `setup.py` (legacy duplicate of `pyproject.toml`, describing the
moved-out client package).

**Dead/legacy files at root:** `server.js` (the dead legacy server — see `servers.md`),
`add_consonants.js`, `build_worker.js`, `migration_plan.md`, `PORTING_README.md`,
`porting_requirements.txt`, `python_api.md`, `__init__.py` (an empty package marker at repo
root, meaningless here), `test.png`, `test.xlsx`.

**Tracked binary/test artifacts that shouldn't be in git:** `extracts/excel/*.xlsx`,
`python/auto_transcribe/melodic_contours/contour_*.png`, `python/visualization_tools/gray_dir/*.gz`,
`.../test_out/*.png|*.gz`, `python/mass_upload/test_dir/*`. These are generated outputs /
scratch fixtures bloating the repo. (Also note the **untracked** working file flagged at
session start: `extracts/excel/HAVI_2026_Budget_Working_local.xlsx` — unrelated, but `extracts/`
clearly accumulates stray spreadsheets and should be gitignored.)

**Git submodule:** `articulation_classification` → `github.com/jon-myers/articulation_classification`.
A separate research repo pulled in as a submodule; confirm it's still needed (submodules add
clone friction and are easy to leave stale).

**Good:** `dist/` is **not** tracked (correct). `.env` contains only `PYTHONPATH`. `credentials/`
(the Google client secret) is gitignored — though still present in the working tree and worth
deleting + rotating (see `servers.md`).

---

## 5. Deployment topology (documented for the synthesis)

- **Two hosts:** `137.184.90.119` (main app server: Node TS server, MongoDB-facing, most
  Python scripts) and `swara.studio` (some Python: melograph, mass-upload daemon, temp-restore).
  Whether these are the same physical machine is **unconfirmed** — `CLAUDE.md` implies
  `swara.studio` is "Python processing scripts," and nginx on `137.184.90.119` serves
  `server_name swara.studio` (see `servers.md`), suggesting the domain points at the main box;
  the `deploy*` scripts targeting `root@swara.studio` vs `root@137.184.90.119` may both resolve
  to one host. → Worth confirming and documenting definitively.
- **Server runtime:** `server/server.ts` under `nodemon`/`ts-node` in a tmux session;
  `pnpm deployTSServer` rsyncs source + runs `pnpm install --frozen-lockfile` (the one deploy
  path with dependency discipline).
- **Frontend:** rsync to `/var/www/html`, fronted by nginx (no auth — see `servers.md`).
  *Mechanism currently ambiguous (§1).*
- **Python:** ~15 per-file rsync scripts to the two hosts — the fragile part (see
  `python-pipeline.md`).

---

## Leads handed to the synthesis

**Modernization / hygiene quick wins (low risk):** delete the three legacy build configs +
`tslint.json` + `server.js` + the root scratch files; gitignore + untrack the binary
artifacts and `extracts/`; resolve the duplicate `meter.test.*`; pin one Node version.
**CI hardening:** make lint and type-check blocking; clarify/re-enable the deploy workflow and
fix the `CLAUDE.md` discrepancy.
**Testing:** add component/integration tests for the high-bug-density areas (renderer playhead
modes, audio transport, editor save path); add a stripped-format serialization fixture shared
with Python (ties to the conformance-test recommendation in `python-api.md`).
**Deploy:** consolidate the per-file Python rsync into one versioned mechanism; confirm the
two-host topology.
