# Review Section: The Editor Renderer

**Scope:** `src/comps/editor/Renderer.vue` (1177, the layer compositor),
`renderer/TranscriptionLayer.vue` (8056, the largest file in the repo),
`SpectrogramLayer.vue` (382), `MelographLayer.vue` (184), `XAxis.vue` (545),
`YAxis.vue` (206), `ModeSelector.vue`, `TrajectoryAnnotator.vue`, the spectrogram
Web Worker `src/ts/workers/spectrogramWorker.ts`, and the scroll plumbing in
`EditorComponent.vue`.

**Bottom line for you specifically:** The reduced-motion story is weaker than you
probably remember. **Block mode is genuinely motion-free and clean** — good. But (1)
your migraine accommodations are **hardcoded to your user ID**, not a real setting, so
they protect only you and only by accident; (2) there is **no `prefers-reduced-motion`
guard anywhere in the editor**; (3) **"DottedLine" mode is not actually motion-free** —
it runs a continuous per-frame opacity fade. The scroll jank is real but its worst
source is *playback*, not scrolling: an unthrottled per-frame watcher. And the good
news on the big question — **a WebGL rewrite is the wrong first move.** Five surgical
fixes get you ~80% of the benefit (motion safety + jank) at ~10% of the risk.

---

## 1. The layer stack — your "~6 stacks" demystified

`Renderer.vue` builds **one** natively-scrolled container (`.scrollingContainer`,
`overflow: scroll`, `Renderer.vue:84`, `:990`) holding **4 absolutely-positioned
overlay layers** pinned to the same origin (`Renderer.vue:1026`,
`.layersContainer > * { position:absolute; top:0; left:0 }`), in paint order:

1. `.backgroundLayer` — plain colored div (`:91`)
2. `SpectrogramLayer` — a flex row of `<canvas>` tiles (`:92`)
3. `MelographLayer` — one `<svg>` contour (`:100`)
4. `TranscriptionLayer` — the `<svg>` editor (`:112`)

The **2 axes** (`XAxis`, `YAxis`) sit in sticky sibling containers *outside* the scroll
box (`:46`, `:63`). So "6 stacks" = 4 overlays + 2 axes.

**The architecture here is actually fine.** Because all 4 overlays are children of one
scroll container, they scroll together for free via the compositor — there is no
per-layer transform or redraw on scroll. Four absolutely-positioned siblings is cheap.
The decomposition by concern (spectrogram / melograph / transcription / axes) is
reasonable. The problems are not "too many layers"; they're three specific things
below.

---

## 2. Reduced motion & the playhead — the part that matters for your health

The playhead has three modes (`PlayheadAnimations` enum: `Animated`, `Block`,
`DottedLine`, plus a `None` that appears broken). They are **three independent motion
engines with guard-clause early-returns scattered across four functions**, not a clean
strategy — i.e. bolted on.

- **`Animated`** (`TranscriptionLayer.vue:1830–1862`): a `requestAnimationFrame` loop
  that exponentially smooths the playhead toward the audio clock
  (`currentX += (targetX - currentX) * 0.7`, `:1855`) and translates it every frame.
  This is genuine ~60fps continuous motion — the exact trigger to avoid.
- **`Block`** (`:1385`, `:2007`): updates **only on integer-second boundaries**
  (`Math.floor(currentTime) > currentSec`, `:1387`), snapping a one-second-wide
  half-opacity rect. No rAF, no smoothing. **Genuinely motion-free between jumps —
  this is the one done right.**
- **`DottedLine`** (`:1933–1964`): drops a static line every 0.5s but *every frame*
  recomputes a continuous opacity fade for up to 20 lines (`opacity = 1 - elapsed/500`,
  `:1923`) and reassigns the reactive array, re-rendering each frame. **Per Jon (the
  repo owner): this opacity fade is tolerable to his vestibular condition** — i.e. the
  trigger is positional *translation*, not change-over-time. So DottedLine and Block are
  both acceptable for him; only the smoothly *sliding* `Animated` playhead is the
  problem. (The fade is still wasted CPU when idle — see the self-rescheduling leak in
  §5 — but it is not an accessibility defect for this user.) **Key design constraint
  going forward: the reduced-motion requirement is specifically "no smooth positional
  motion," not "no animation."**

**Three concrete problems for the accessibility requirement:**

1. **The accommodation is hardcoded to your user ID.** `EditorComponent.vue:895`
   forces `playheadAnimation = Block` and `Renderer.vue:874–885` suppresses
   wheel/touch motion — both gated on *your specific userID*, not a preference. Anyone
   else with vestibular sensitivity gets the `Animated` default (`EditorComponent.vue:824`).
   This should be a real per-user reduced-motion setting (and respect the OS
   `prefers-reduced-motion`).
2. **No `prefers-reduced-motion` anywhere in the editor.** The only hit in the whole
   codebase is `NavBar.vue:264`. The browser/OS already exposes the user's stated
   preference; the editor ignores it.
3. **Residual motion leaks even when you're not playing:** `dottedLineAnimationLoop`
   re-schedules itself via rAF forever once started, even when stopped and the line
   array is empty (`:1939`); and a separate `dragDot` smoothing loop (`:4421`) runs
   interpolated motion during control-point drags, ungated by any motion preference.

→ This is the highest-value, lowest-risk work in the whole review for your day-to-day
use of the tool. See the recommended fixes in §6.

---

## 3. Scroll jank — real, but the worst offender is playback, not scroll

Scrolling is native `overflow:scroll` with `scroll-behavior: auto` (good — no CSS
smooth-scroll). The jank comes from three JS mechanisms:

- **Per-frame highlight watcher during PLAYBACK (the biggest one).**
  `watch(() => props.currentTime)` (`TranscriptionLayer.vue:1380`) fires at audio-clock
  rate and, when trajectory highlighting is on, does per-track-per-frame work with **no
  throttle**: `trajFromTime` lookups, a full rebuild of `allDisplayChikaris(idx)` every
  frame (`:1461`), and multiple `d3.selectAll('.uId…')` full-document scans + attribute
  writes (`:1417–1492`). This is O(tracks × chikaris) of DOM mutation every frame. Your
  intuition was "watchers during scroll"; the heavier culprit is watchers during
  *playback*.
- **Scroll cache-buster cascade.** `handleScroll` (`Renderer.vue:868`, throttled 16ms)
  increments `scrollUpdateIdx`, whose only purpose is to defeat Vue's computed caching
  so `displayRange`/`verticalDisplayRange` (`:660`, `:669`) recompute every tick and
  push fresh array props into the 8056-line layer. Bounded by the throttle, but it
  routes reactivity into the heaviest component on every scroll tick.
- **Axes repositioned in JS every 16ms.** Because the axes live outside the scroll
  container, `updateAxesScroll` (`Renderer.vue:788`) mirrors `scrollLeft`/`scrollTop`
  onto them on every scroll event — a read-after-write layout thrash, and they visibly
  lag the graph by up to a frame. Moving the axes *inside* the scroll origin (sticky)
  would delete this whole class of jank with no functional loss.

`d3.selectAll('.uId…')` as the universal element-lookup (re-querying the DOM by class on
every selection/highlight/unload, dozens of sites) is the connective inefficiency
underneath all of the above.

---

## 4. Spectrogram loading — your "funny lazy-loading strategy"

End-to-end, the **live** path is: a Web Worker fetches the **entire recording's** FFT
as one gzipped Float32 blob up front (`spec_data/<id>/spec_data.gz` +
`spec_shape.json`, `spectrogramWorker.ts:259`), inflates it with pako, then scales →
intensifies → colorizes it through a d3 colormap into 1000px-wide column chunks. The
client (`SpectrogramLayer.vue`) creates one `<canvas>` per chunk and uses an
`IntersectionObserver` to render only visible tiles, with a ±10-tile keep window, ±2
preload, and a rAF-paced "2 canvases/frame" queue.

What it costs and what's wrong with it:
- **Whole-recording download & decode regardless of viewport** — a long recording pulls
  a large `.gz` and holds a full `Float32Array(width·height)` plus a full `ImageData`
  in the worker. Only the *rendered canvases* are lazy; the *source data* is not
  windowed.
- **Every zoom/colormap/power change re-runs the entire JS scale+colorize pipeline**
  across all chunks.
- **Two duplicated lazy-load schedulers.** `SpectrogramLayer.vue` (canvas tiles) and
  `TranscriptionLayer.vue` (SVG chunks) each carry a near-identical
  IntersectionObserver + preload-queue + distant-unload + cooldown system
  (`SpectrogramLayer.vue:49–316` vs `TranscriptionLayer.vue:498–885`). That's the real
  maintenance burden — two copies of one subtle scheduler that can drift.
- **Fragile constants:** `maxCanvasWidth = 1000` is hardcoded in *both* the worker
  (`:25`) and the layer (`:41`) with a comment that they must stay in sync.
- **Hardcoded `swara.studio` URL** in the worker (`:266`), bypassing the configurable
  `serverCalls` base.
- **Legacy PNG-tile machinery is vestigial:** the server still serves
  `/spectrograms/<id>/0/*.png` and `getNumberOfSpectrograms`/`verifySpectrogram` exist,
  but `getNumberOfSpectrograms` is imported and **never called** in the editor; the PNG
  path is effectively dead for rendering.

**Modern recommendation:** pre-render server-side into a **tiled image pyramid**
(WebP/AVIF, DZI/IIIF-style) so the client never downloads or recomputes the full FFT;
use one `IntersectionObserver` (drop the preload/cooldown/5-tracking-map apparatus —
browser image cache + `loading="lazy"` covers most of it); for the dynamic
colormap/intensity sliders, do the recolor in a **single WebGL canvas with a colormap
LUT in a fragment shader** instead of re-running JS pixel loops. If staying CPU-side,
at least move to `OffscreenCanvas` + `createImageBitmap` transfers and
`content-visibility:auto`. This is the highest-value spectrogram change but also the
highest-effort (needs a server pipeline change), so it's a roadmap item, not a quick
fix.

---

## 5. Bugs, leaks, and dead code found along the way

**Memory/leak bugs (→ bug-hunt phase):**
- `onBeforeUnmount` (`TranscriptionLayer.vue:7886`) does **not** call
  `observer.disconnect()` (IntersectionObserver leaked) nor
  `cancelAnimationFrame(animationFrameId)` (the Animated playhead rAF keeps running
  against a detached node if unmounted mid-playback).
- `dottedLineAnimationLoop` self-reschedules forever even when stopped/empty (`:1939`)
  — a permanent idle 60fps loop.

**Dead code (safe to delete now, zero risk):**
- The custom D3 `scrollX`/`scrollY` SVG scrollbars in `EditorComponent.vue:587`,
  initialized at `:762`, are **never appended or used** — orphaned scaffolding from an
  abandoned custom-scrollbar attempt.
- Legacy spectrogram image fields (`imgs`, `loadedImgs`, `numSpecs`, `totNaturalWidth`,
  `cumulativeWidths`, `EditorComponent.vue:595`) declared/initialized, never read.
- `TranscriptionLayer.vue`: ~432 commented lines, including a misleading commented-out
  `playing` watcher (`:1645`) — misleading because the live mechanism is the
  imperatively-called `startPlayingTransition`/`stopPlayingTransition`.
- `console.log` left in `MelographLayer.vue:110`.

**Per-layer notes:** `XAxis.vue` has the region-line drawing block **copy-pasted 4×**
(`:222`, `:260`, `:418`, `:453`) and a `deep:true` watch on the entire meter array
(`:206`). `MelographLayer` removes+rebuilds all paths on any size change (no D3
enter/update/exit). `ModeSelector` manages selection via direct `classList`/`querySelectorAll`
in a watcher instead of reactive `:class`. `any` count across the seven layer files is
**0** — the strict-typing discipline in the renderer is genuinely good.

**Maintainability of the 8056-line SFC:** it's essentially one giant `setup()`. Natural
seams to extract as composables: `usePlayhead` (the migraine-critical motion engines,
`:1380–2016`), `useChunkedLazyLoad` (the IntersectionObserver/queue system — shareable
with SpectrogramLayer), `useTrajectoryRenderers` (the ~25 D3 `render*` functions), and
`useInteraction`/`useMeterEditing`/`useRegionEditing`. Isolating `usePlayhead` alone
would make the reduced-motion contract auditable in one place.

---

## 6. The WebGL/WebGPU question — honest verdict

**Don't start there.** Native scroll of static SVG is already GPU-composited, and the
chunked lazy-loader already caps live DOM node count, so the things people reach to
WebGL for are mostly already handled. The genuine upside of a single render loop —
*one authoritative place to forbid sub-second motion* — you can get far more cheaply by
deleting the Animated path and making Block the floor. The cost of a real canvas/WebGL
rewrite is high and lands exactly on the hardest parts: hit-testing (the entire editing
UX is `d3.selectAll('.uId…')` + per-element drag/context-menu handlers — canvas has no
DOM, so you'd build a spatial index and manual hit-testing for every interactive
element), multi-script text (sargam/IPA/Devanagari labels, trivial in SVG, painful in
WebGL), and selection styling/accessibility.

**Do these five surgical fixes first** (address both motion-safety and jank, near-zero
rewrite risk):
1. Make reduced-motion a **real per-user setting + `prefers-reduced-motion`**, generalizing
   beyond the userID hardcodes (`EditorComponent.vue:895`, `Renderer.vue:874`); default
   sensitive users to `Block`. **HARD CONSTRAINT (owner): the current behavior works for Jon
   and must not regress.** This change must be purely *additive* — keep Jon's exact current
   experience (Block playhead + the wheel/touch suppression his userID triggers) byte-for-byte.
   Safest implementation: leave the existing userID path in place and add the general setting
   alongside it, or make the new setting default to precisely Jon's current values for his
   account, verified by him before the userID branch is removed. Do not "clean up" the
   hardcode by deleting it until the replacement is confirmed equivalent for him.
2. (Revised per owner feedback) `DottedLine`'s opacity fade is acceptable to Jon, so
   it need not be made static for accessibility — but stop it self-rescheduling when
   idle (`:1939`) to avoid the wasted 60fps loop. The accessibility line is specifically
   the `Animated` (sliding) playhead.
3. **Throttle the `currentTime` highlight watcher** (`:1399`) to ~100ms and cache
   `allDisplayChikaris` instead of rebuilding per frame — the single biggest playback
   jank win.
4. Fix the unmount leaks: add `observer.disconnect()` + `cancelAnimationFrame` to
   `onBeforeUnmount` (`:7886`).
5. Stop `dottedLineAnimationLoop` self-rescheduling when idle (`:1939`).

**Then, if you want more,** two medium structural wins independent of any rewrite:
move the axes inside the scroll origin (deletes `updateAxesScroll` and a jank class),
and merge the read-only spectrogram+melograph underlays into one canvas/WebGL surface
with shader-based recolor (halves the duplicated lazy-load code and kills the JS
colorize recompute). Keep `TranscriptionLayer` as SVG — its interactivity justifies the
DOM.

---

## Leads handed to later phases

**Bug-hunt:** unmount leaks (observer + rAF, `:7886`); idle dotted-line rAF (`:1939`);
`None` playhead mode appears broken (falls through to a `throw` at `:2014`); XAxis 4×
duplicated region-line code.
**Performance:** unthrottled per-frame `currentTime` highlight watcher (`:1399`);
`d3.selectAll` DOM re-query pattern; whole-recording spectrogram download.
**Accessibility (health-critical):** no `prefers-reduced-motion`; reduced-motion gated
on userID not preference; DottedLine not actually static.
**Modernization:** server-side spectrogram tile pyramid + shader recolor; extract the
shared lazy-load composable; split the 8056-line SFC; delete dead D3 scrollbars/image
fields.
