# Review Section: Editor Core & State

**Scope:** `src/comps/editor/EditorComponent.vue` (2992), the editor panels
(`TrajSelectPanel`, `AssemblageEditor`, `AutomationWindow`, the label editors,
`ModeSelector`), state plumbing in `src/main.ts` + `src/vuex.d.ts`, and how the editor
coordinates the Renderer and the audio player.

**Bottom line:** `EditorComponent.vue` is a ~150-field god-object that owns the open
`Piece` (a clean single source of truth for musical data) but coordinates everything
else through two enormous prop/event interfaces (~55 props to Renderer, ~60 to the
audio player) plus 55 `$refs` reach-throughs with 85 type-casts that reach *two layers
deep* into children. Two findings stand out as more than cosmetic: **there is no
undo/redo and no autosave** — every edit mutates the Piece in place irreversibly — and
**selection state isn't owned here**; it lives inside `TranscriptionLayer` and is
surfaced upward by ref-reach plus a manual `recomputeTrigger` reactivity nudge. Several
real polyphonic string-desync bugs are flagged below.

---

## 1. State architecture — three mechanisms, no clean division

- **Vuex** (`main.ts:10-61`, typed `vuex.d.ts:7-17`) holds **only auth/session** identity
  (`_id`, `userID`, names, `query`). No actions, getters, or modules; none of the
  editor's musical state. `_id` defaults to a **hardcoded transcription id**
  `'63445d13dc8b9023a09747a6'` (`main.ts:13`, reused as the fallback piece at
  `EditorComponent.vue:925`).
- **EditorComponent `data()`** (`:673-839`) is the de-facto god-object: **~150 fields**
  mixing the `piece` (the real single source of truth), ~30 view-config booleans, D3/DOM
  objects stuffed into reactive data (`x`, `y`, `zoom`, `selBox`, `svgNode`, `scrollX/Y`
  — a known Vue anti-pattern), throttled-fn handles, and transient interaction state.
- **mitt bus** (`main.ts:82-88`) is used **minimally and is not a backdoor** — only 3
  events, all on the audio→transcription pulse-tap path (`PulseTapDetect.vue:36`,
  `EditorAudioPlayer.vue:1351` → `TranscriptionLayer.vue:7881`). EditorComponent never
  touches `emitter` at all.

The Piece is a coherent source of truth, but it's **mutated in place by many components**
(panels splice `sectionCatGrid`, `assemblageDescriptors`, etc. directly through props),
relying on Vue deep reactivity. The two ~50-entry prop/event interfaces reimplement
manual two-way binding dozens of times (`@update:x='x = $event'`).

---

## 2. Interaction model

- **Modes:** `EditorMode` enum (`shared/enums.ts:6-15`): Trajectory, Series, PhraseDiv,
  Meter, Chikari, Region, AssemblagePhrasePick, None. Held in `selectedMode`.
- **Selection — owned two layers down.** The source of truth is `trajRenderStatus` in
  `TranscriptionLayer.vue`; `selectedTrajs` is *computed* there (`:963-980`).
  EditorComponent reads selection by reaching through refs
  (`this.$refs.renderer.transcriptionLayer.selectedTraj`, `:1222-1239`) and forces its
  own computed to re-evaluate via a manual `recomputeTrigger` counter (`:1229`, bumped
  from a child `@update:recomputeTrigger`). Fragile: a missed bump leaves selection
  stale.
- **Keyboard shortcuts — very thin.** `handleKeydown` (`:2440-2453`) handles only number
  keys (traj-type pick) and spacebar (play). No save, delete, arrow-nudge, or
  copy/paste keybinding (clipboard fields exist but aren't wired). `handleKeyup` is
  **defined but never registered**.
- **Undo/redo — ABSENT.** No undo/history/stack anywhere in `src/`. Every edit mutates
  `this.piece` irreversibly. For a transcription tool this is a significant gap.
- **Persistence — explicit save only, no autosave/debounce.** `savePiece()` (`:2416`)
  fires from a button/event; cleans phrases, dedupes section starts, POSTs to the
  server, clears `unsavedChanges`. Unsaved-changes guards exist (`beforeRouteLeave`
  `:872`, `beforeunload` `:2107`). **No-undo + no-autosave together = an
  unrecoverable-edit risk** — a bad in-place mutation can't be reverted and there's no
  periodic fallback save.

---

## 3. Polyphonic dual-string coordination — real desync bugs

`currentStringIdx: 0|1` (`data:811`) is prop-drilled to the renderer; the user switches
strings by clicking (TranscriptionLayer emits `update:currentStringIdx`). Edits target a
string via `const stringIdx = this.trajTimePts[0].stringIdx ?? 0` (`:1841`).
`ensureStringSynchronization` (`piece.ts:395`) only pads `trajectoryGrid[1]` for
Sitar/Sarangi and **only if string 1 has no non-silent content** — so once string 1 has
real content, it never re-pads for drift; alignment becomes the caller's job, and callers
are inconsistent:

- **`extendDurTot` (`:2135-2197`) extends only string 0.** It appends extension silence
  to `lastPhrase.trajectories` (= `trajectoryGrid[0]` via the getter), never to string 1,
  and never calls `ensureStringSynchronization()`. Polyphonic string 1 is left shorter.
  → bug-hunt.
- **`newTrajEmit` never re-syncs after splicing (`:1937-1971`).** Inserting on one string
  doesn't realign the other. → bug-hunt.
- **No watcher resets `currentStringIdx` on instrument switch.** `editingInstIdx` has no
  watcher, so switching to a monophonic instrument can leave `currentStringIdx === 1`
  pointing at a non-existent `trajectoryGrid[1]`. → bug-hunt.

---

## 4. Coupling & complexity

`EditorComponent.vue` (2992): template `1-330` (dominated by the two prop/event blocks),
`data()` ~150 fields, `mounted` ~180 lines of load orchestration in one try/catch,
~16 computed (several reaching into refs), ~80 methods / ~1400 lines (largest:
`newTrajEmit` ~280 lines of FP boundary math).

Coupling to Renderer/AudioPlayer is **severe and bidirectional**: `$refs` dereferenced
55×, with **85 reach-through casts**, often two levels deep
(`$refs.audioPlayer.$refs.meterControls.X`), and EditorComponent *writes into child
internals* (sets `tsp.selectedIdx`, `ap.sourceNode.loopStart`). Explicit `any` is only 1,
but the 85 `as XType` casts bypass Vue's type system entirely.

**Refactor seams:** (1) lift selection state into a composable/store above the Renderer
(kill `recomputeTrigger`); (2) collapse the ~55/~60-prop interfaces into a shared reactive
`editorConfig` via provide/inject; (3) move D3 objects out of reactive `data()`; (4) split
the ~1400-line methods block by concern.

**Dead code:** `resize()` (`:2482`) and `handleKeyup` (`:2430`) defined but never
registered; commented font-loading block (`main.ts:63-79`); ~70 commented lines + 18
console logs.

---

## 5. Panel-component bugs (concrete, → bug-hunt)

- **`TrajSelectPanel.vue:264,288`** — read-only vibrato inputs `v-model` to `periods`
  instead of `extent`/`offset`: wrong field bound, stale display.
- **`TrajSelectPanel.vue:1015`** — hover `setTimeout` not cleared on unmount.
- **`AutomationWindow.vue:241`** — `this.trajectories.values.length` (an array has no
  `.values`) instead of `this.automation!.values.length`: last-point detection always
  false.
- **`SectionLabelEditor.vue:279`** — `adHocFields` aliased by reference from the model
  with no deep copy; edits leak back into the Piece.
- **Pervasive direct prop mutation** across the panels — tolerated only because `piece`
  is the shared source of truth, but it bypasses the prop contract.

**Other leads:** userID hardcode for the migraine accommodation (`:895`, should be a
preference — see `renderer.md`); hardcoded fallback transcription id (`:925`/`main.ts:13`);
giant swallowing try/catch in `mounted` (`:899-1070`) can leave the editor partially
initialized with no user-facing error.
