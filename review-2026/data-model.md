# Review Section: The Core Data Model

**Scope:** `src/js/classes.ts` (4165), `src/ts/model/*` (4826 across 13 files),
`shared/types.ts` (1337) + `shared/enums.ts`, `server/classes.ts`/`analysis.ts`
shims, and the deployed `server/extract.js` bundle.

**Bottom line:** The model exists in **two full copies** — the old monolith
`src/js/classes.ts` ("copy A") and the new split `src/ts/model/*` ("copy B"). The
good news, confirmed against the *deployed* bundle: **both the frontend and the
production Node export path use copy B consistently.** Copy A is dead at runtime.
So the most dangerous scenario — server reading transcriptions through a stale,
incompatible model — is **latent, not live.** It sits one re-pointing mistake away.
Two genuine issues do exist today: a silent round-trip loss of `Trajectory.instrumentation`
(vocal trajectories reload as "Sitar"), and a completely untyped/unvalidated
deserialization boundary. Detail below.

> Methodology note: my first read of this (stated verbally earlier in the session)
> hypothesized the server was using copy A and silently producing wrong export
> pitches. A subagent deep-read **disproved** that by inspecting the compiled
> `server/extract.js`, and I independently re-verified: the bundle contains only
> `// src/ts/model/*` source markers (no `src/js/classes.ts`), and its single `Pitch.toJSON`
> emits the stripped copy-B shape (`server/extract.js:68061`, `:68519`). Recording the
> correction so the synthesis phase doesn't carry the wrong version.

---

## How the two copies relate

- **Frontend** imports copy B (`@/ts/model`) everywhere. Copy A (`src/js/classes.ts`)
  has **zero** importers in `src/` (`grep "js/classes" src` → empty).
- **Server** *appears* to use copy A: `server/classes.ts` is literally
  `export * from '../src/js/classes'`, and `server/extract.ts:7-13` imports
  `Piece/Pitch/Phrase/Trajectory` from `./classes`. **But those are type-only uses** —
  `extract.ts` never does `new Pitch(...)` etc., so esbuild erases the imports. The
  live object graph in the export path is built by `instantiatePiece`
  (`src/js/analysis.ts:19`), which imports `Piece` from `@/ts/model` and calls copy B's
  `Piece.fromJSON`. The esbuild `@/*` path alias resolves to `src/ts/model`, so the
  bundle ships copy B. Confirmed: `server/extract.js` has source markers only for
  `src/ts/model/*` (`:67856`–`:74167`).
- `server/classes.ts`, `server/analysis.ts`, `server/utils.ts` are all 1-line
  re-export shims. `src/js/analysis.ts` (live, used by AnalyzerComponent and
  PitchPrevalence) already imports copy B — it is **not** duplicated and should stay.

So copy A is dead in both runtimes. Its danger is purely that it *looks* usable while
being subtly incompatible (see drift below).

---

## The class model (copy B — canonical)

- **Pitch** (`pitch.ts`) — one scale degree: `swara` (0–6), `oct`, `raised`,
  `logOffset` (microtonal cents), plus `ratios`/`fundamental` which are *tuning
  context* (from the raga), not identity — hence stripped from `toJSON`. `frequency`
  derives Hz from `ratio · fundamental · 2^oct · 2^logOffset`.
- **Trajectory** (`trajectory.ts`, 923) — one continuous melodic gesture: shape `id`
  (0–13), `pitches[]`, `durTot`/`durArray`, `articulations`, vocal `vowel`/consonants,
  `automation`, `vibObj`, `num`, `groupId`, `uniqueId`.
- **Phrase** (`phrase.ts`, 733) — `trajectoryGrid: Trajectory[][]` (string-indexed),
  plus chikari/groups/categorization grids, `isSectionStart`.
- **Piece** (`piece.ts`, 1465) — `phraseGrid: Phrase[][]` (track-indexed), `raga`,
  `instrumentation`, meters, `trackTitles`, `excerptRange`, `assemblageDescriptors`.
  Owns `fromJSON`, legacy migration, and `ensureStringSynchronization`.
- **Raga** (507), **Section** (83), **Group** (132), **Automation** (161),
  **Assemblage** (167, copy-B-only).

### Polyphonic dual-string structure — track → string → trajectories
Two levels: `Piece.phraseGrid[track]` (`piece.ts:144`) per instrument track, and
within each phrase `Phrase.trajectoryGrid[stringIdx]` (`phrase.ts:61`) where index 0 =
main string, 1 = second/jor string. `ensureStringSynchronization()`
(`piece.ts:395`) runs only for Sitar/Sarangi: ensures `trajectoryGrid[1]` exists and,
if empty, fills it with a single silent trajectory (`id:12`) spanning the phrase, then
renumbers. `stringFromTraj()` (`piece.ts:763`) resolves a trajectory's string by
`uniqueId` scan. `Phrase.trajectories` aliases `trajectoryGrid[0]` for back-compat.

---

## Two-copy drift — `toJSON()` field diff

| Class | Copy A emits | Copy B emits | Divergence |
|---|---|---|---|
| **Pitch** | `swara, raised, oct, ratios, fundamental, logOffset` (`classes.ts:763`) | `swara, raised, oct, logOffset` (`pitch.ts:485`) | B strips `ratios`, `fundamental` |
| **Trajectory** | adds `name`, `instrumentation`, `tags` (`classes.ts:1881`) | strips those 3 (`trajectory.ts:862`) | B strips 3 |
| **Phrase** | emits per-phrase `raga`, no `isSectionStart` (`classes.ts:2458`) | strips `raga`, adds `isSectionStart` (`phrase.ts:627`) | model fork on section boundaries |
| **Piece** | `durArray, sectionStarts, sectionCategorization, sectionStartsGrid` (`classes.ts:3598`) | strips those 4, adds `trackTitles`, `assemblageDescriptors` (`piece.ts:1350`) | B strips 4 legacy, adds 2 |
| **Raga / Chikari** | identical | identical | none |

### The structural difference that makes copy A dangerous
**Copy A has no `fromJSON` on any class** (`grep fromJSON src/js/classes.ts` → 0). It
rehydrates via constructors that **do not thread raga tuning into pitches**. Copy B has
a top-down `fromJSON` chain that does: `Piece.fromJSON` (`piece.ts:1384`) pulls
`raga.stratifiedRatios` + `raga.fundamental` and passes them down through
`Phrase.fromJSON` → `Trajectory.fromJSON` → `Pitch.fromJSON` (`pitch.ts:494`), where
`ratios ?? obj.ratios` lets the raga values win.

**Consequence:** Because the DB now stores stripped pitches (no `ratios`/`fundamental`),
they are *only* correctly reconstructable by copy B's raga-threading `fromJSON`. Copy B
in production does this correctly — Raga.toJSON was **not** stripped, so the tuning
table reliably survives, and non-12-TET ragas round-trip fine. **But if anyone ever
repoints the server at copy A** (or bundles it), copy A's Pitch would silently fall
back to 12-TET ratios / 261.63 Hz defaults (the known "fromJSON doesn't throw" quirk)
and produce **wrong cents/frequencies in Excel/JSON exports for every non-ET raga, with
no error.** This is the latent landmine. **Remediation: delete `src/js/classes.ts` and
repoint `server/classes.ts` at `@/ts/model`, removing the trap entirely.**

---

## LIVE bug: `Trajectory.instrumentation` round-trip loss

`Trajectory.toJSON` no longer emits `instrumentation` (`trajectory.ts:862`, "inherited
from piece context"), but **no `fromJSON` re-injects the owning track's instrument** —
`Phrase.fromJSON`/`Trajectory.fromJSON` just spread `obj` (which lacks it), so every
reconstructed trajectory defaults to `Instrument.Sitar` (`trajectory.ts:85`). The
constructor *uses* `this.instrumentation` as behavior: for `Vocal (M)/(F)` it strips
`pluck` articulations (`trajectory.ts:359`). So after any save→reload, a vocal
trajectory comes back as "Sitar" and the pluck-stripping no longer fires. Reproduced in
the deployed bundle (`server/extract.js:69497`). Harmless for pure pitch/timing export
today, but it is a real instrumentation round-trip inconsistency and a trap for any
future instrument-conditional logic. → bug-hunt phase.

---

## Serialization round-trip — otherwise sound

- **Safe strips (regenerated, no loss):** Trajectory `name` (rebuilt from `id` via
  `name_` getter), `tags` (defaults `[]`); Pitch `ratios`/`fundamental` (re-threaded
  from raga); Piece `durArray`/`sectionCategorization` (duplicates of
  `…Grid[0]`); per-phrase `raga` (redundant with piece raga).
- **`$unset` list matches the model.** Update routes `$unset`
  `{sectionStartsGrid, sectionStarts, phrases, sectionCategorization, durArray}`
  (`server/server.ts:295`, `apiRoutes.ts:290`) — exactly the fields copy B stopped
  emitting. Stale legacy fields are actively scrubbed on each save. `Piece.fromJSON`
  still *reads* `sectionStartsGrid` for old documents (`piece.ts:1402`) — correct
  defensive migration.

---

## Code health

- **`src/js/classes.ts` (4165) — dead at runtime, recommend deletion** after repointing
  the `server/classes.ts` shim and `extract.ts` type imports to `@/ts/model`. Keeping
  it is the Task-2 landmine; it adds nothing.
- **Untyped deserialization boundary.** All `fromJSON(obj: any, …)` signatures are
  `any`; no schema validates that a MongoDB document matches the expected shape. The
  server build can't catch it either — `server/tsconfig.json` runs `strict: false`,
  `noImplicitAny: false`. So a malformed/old document fails silently (defaults) rather
  than loudly.
- Largest/most complex: `classes.ts` (dead), `piece.ts` (1465), `trajectory.ts` (923).
  `Pitch`'s constructor doubles as deserializer + validator, which is precisely what
  creates the default-fallback trap.
- No `TODO/FIXME/HACK` markers in either copy.

---

## Shared-backend implications (feeds the modernization roadmap)

There are effectively **three** independent reimplementations of this model: copy A
(dead), copy B (frontend + Node, canonical), and the **Python API client** (separate
repo, its own data classes — see the `python-api` section). Copy B serializes cleanly
in the happy path and threads tuning context properly, but the *reconstruction
contract* is the crux: the stripped on-disk shape is only correct if the reader applies
two implicit rules —

1. `Pitch.ratios`/`fundamental` come from the piece's `raga.stratifiedRatios`/`fundamental`,
   never from defaults;
2. `Trajectory.instrumentation` comes from the owning track.

Today those rules live as hand-written `fromJSON` logic that each runtime must replicate
exactly, and where any of them can silently fall back to wrong defaults. **The single
biggest obstacle to one canonical model is this fork plus the absence of a shared,
validated serialization schema.** The path forward: (1) collapse copy A into copy B;
(2) promote the stripped-field reconstruction rules into a documented, schema-validated
contract (e.g. a JSON Schema enforced on read in all three runtimes) so the current
silent-wrong-pitch failure mode becomes a loud one. That schema is the precondition for
trusting a unified backend — and it directly addresses the `SERIALIZATION_SYNC_SPEC.md`
drift that already exists between the TS and Python sides.

---

## Leads handed to later phases

**Bug-hunt:** `Trajectory.instrumentation` round-trip → vocal reloads as Sitar
(`trajectory.ts:85`, `:359`, `:862`).
**Security/robustness:** fully `any`-typed `fromJSON` boundary + `strict:false` server
build → no validation of untrusted DB/Python-client documents.
**Modernization:** delete copy A; define a shared JSON Schema as the serialization
source of truth across frontend / Node / Python; reconcile with `SERIALIZATION_SYNC_SPEC.md`.
