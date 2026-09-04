# IDTAP editor audit — 2026-09-04

Scope: editor load time, scroll/motion behaviour in the main editor window, bugs and
cleanup. Builds on `review/codebase-audit-2026` (July 2026); everything below was
re-verified against `main` at e4e83479. Worktree: `../idtap-audit`, branch
`audit/editor-perf-2026`. Nothing has been changed yet.

## 1. Why loading feels slower

### 1a. It is bandwidth-bound, and nothing is cached

One editor open for the default piece (Yaman sitar, 1834 s, 3521 trajectories,
audioID 62fa903990b9ba8cdae9d251) transfers, measured against production:

| Request                              | Bytes on wire | Compressed? | Cache-Control                       |
|--------------------------------------|--------------:|-------------|-------------------------------------|
| `spec_data/<id>/spec_data.gz`        |    27,284,365 | (gz at rest)| `no-cache, no-store, must-revalidate` |
| `EditorComponent-*.js`               |     1,545,000 | **no**      | `public, max-age=0`                 |
| `melographs/<id>/melograph.json` ×2  |   695,864 ×2  | **no**      | `no-cache, no-store, must-revalidate` |
| `getOneTranscription` (POST)         |       609,620 | yes (as text/html) | none                          |
| `index-*.js` + other chunks          |      ~500,000 | **no**      | `public, max-age=0`                 |
| audio `.opus` (full file, decoded)   |     tens of MB| n/a         | `no-cache, no-store`                |

* The box itself is fast: 80 MB/s through nginx on localhost, 31 MB/s upload to
  Cloudflare. The path from the box to a client is what's slow; from my link today
  it ranged 50–700 KB/s, so the 27 MB spectrogram alone took 3 minutes. Jon should
  measure from his own connection:
  `curl -o /dev/null -w "%{speed_download}\n" https://swara.studio/spec_data/62fa903990b9ba8cdae9d251/spec_data.gz`
* `server.ts:2501` `setNoCache` puts `no-store` on `/audio`, `/peaks`, `/spec_data`,
  `/spectrograms`, `/melographs`. `no-store` forbids caching outright, so every editor
  open re-downloads ~30 MB even though these files are immutable per audioID and
  express.static already emits ETag/Last-Modified. Added 2025-05 (d4b44a6f).
* nginx (`/etc/nginx/nginx.conf`) has `gzip on` but `gzip_types` commented out, so
  only `text/html` is compressed. JS, CSS, JSON API responses and melograph JSON go
  uncompressed. (`getOneTranscription` is compressed only by accident: it uses
  `res.send(JSON.stringify(...))`, which sets text/html.)
* Vite's hashed `/assets/*` are served by `express.static('dist')` with `max-age=0`,
  so every visit revalidates 3.3 MB of JS.

### 1b. The load is a serial waterfall (~9 round trips before first paint)

`EditorComponent.mounted` (`:890`) awaits in sequence: `pieceExists` → `getPiece` →
`getAudioRecording` → `getMelographJSON` → `getRaagRule` (inside `getPieceFromJson`)
→ `updateTranscriptionViewed` → `getEditableCollections`. Then `SpectrogramControls`
mounts and awaits `getSavedSettings` → `getDefaultSettings` before it even asks the
worker to start the 27 MB fetch (`SpectrogramControls.vue:1274-1285`). Meanwhile
`MelographLayer` fetches `melograph.json` a second time (`MelographLayer.vue:144`).

* **Bug:** the `melographJSON` fetched in `EditorComponent.vue:941` is stored and never
  read anywhere. A 700 KB uncompressed, uncached, serial `await` for nothing.
* `pieceExists` + `getPiece` are two RTTs for one answer (getPiece 403/404 would do).
* Everything after `getPiece` that only needs the audioID / user could run in one
  `Promise.all`.

### 1c. Main-thread cost: the model is read through Vue reactive proxies

`piece` lives in Options-API `data()` (`EditorComponent.vue:677`), so every property
access in the model goes through a `Proxy` trap. Benchmarked on the real default piece
(vitest, node):

| Operation                                  | raw    | through `reactive()` |
|--------------------------------------------|-------:|---------------------:|
| `Piece.fromJSON`                           | 67 ms  | n/a                  |
| `chunkedDisplaySargam(0, 30)`              | 3.4 ms | 41 ms                |
| one chunk load (6 `chunked*` calls)        | 7 ms   | 68 ms                |
| initial view ≈ 5 chunks                    | ~35 ms | **324 ms**           |
| `trajFromTime` (per frame during playback) | 0.1 ms | 1.0 ms               |

And each `chunked*` call (`piece.ts:963-1278`) walks *all* trajectories, builds the
display list for the *whole piece*, splits it into *all* chunks, and then the caller
indexes `[idx]` and throws the rest away. `manuallyLoadChunk`
(`TranscriptionLayer.vue:498`) makes 6–10 such calls per chunk per instrument, on
every chunk that scrolls into view. `unloadChunk` (`:690`) is O(N²)
(`trajRenderStatus.find` inside a per-traj loop).

## 2. Why scrolling triggers symptoms — sources of independent motion

Scrolling is native `overflow: scroll` with no smooth-scroll, which is right. But four
things move on their own schedule relative to the content:

1. **Axes lag the graph.** The X and Y axes sit *outside* the scroll container and are
   repositioned by JS: `scroll` → `handleScroll` (throttle 16 ms) → `updateAxesScroll`
   (throttle 16 ms again) → `xAxisContainer.scrollLeft = …` (`Renderer.vue:789, 869`).
   Two stacked lodash throttles with trailing calls mean the axis strip trails the
   content by 1–2 frames and then catches up in a step. Time labels and phrase labels
   shearing against the transcription is exactly a positional-translation trigger.
   *Fix:* put the axes inside the scroll container as `position: sticky` children
   (CSS only, no JS mirroring), or at minimum drop both throttles and assign
   directly on the scroll event (browsers already fire `scroll` once per frame).

2. **Chunk pop-in stalls.** When a chunk enters the viewport, the
   `IntersectionObserver` callback synchronously does the ~70 ms model read above *plus*
   the D3 rendering of every trajectory/sargam/bol in it, on the main thread, mid-scroll.
   The page freezes and then jumps to where the scroll position already is. Same for
   the spectrogram tiles (worker → `putImageData`, cheaper). *Fix:* read the model via
   `toRaw(props.piece)` (10× cheaper, no semantic change), cache the chunk tables once
   per `resetTranscription()`, and render chunks from a rAF budget rather than inside
   the observer callback.

3. **Nested scroll containers (hypothesis, verify in browser).** `.tranContainer` and
   `.melContainer` are both `overflow-x: auto` (`TranscriptionLayer.vue` style,
   `MelographLayer.vue:179`) *inside* the main scroller. If either's content overflows
   by even a subpixel (SVG `width` attr vs CSS `--width` rounding), it becomes its own
   scroller and captures wheel/trackpad deltas: the transcription layer moves while the
   spectrogram doesn't. Check in devtools: `el.scrollWidth > el.clientWidth`. Neither
   should be a scroll container at all (`overflow: visible` or `clip`).

4. **The scroll-cache-buster plumbing is half dead.** `scrollX`
   (`Renderer.vue:556`) is a `computed` over non-reactive DOM reads, so it evaluates
   once and never changes; the `watch(() => props.scrollX)` in both layers never fires.
   Unload/preload only happens from observer callbacks. `displayRange` works only
   because `scrollUpdateIdx` is bumped as a cache-buster. Not a motion cause, but
   dead/misleading plumbing that should go.

Playback (unchanged since the July review, still present): the per-frame
`currentTime` watcher (`TranscriptionLayer.vue:1393`) does unthrottled
`trajFromTime` + `d3.selectAll` + a full `allDisplayChikaris` rebuild per track per
frame when highlighting is on.

**Guardrail:** Jon's motion accommodation (`motionPrefs.ts`: Block playhead +
wheel/touch suppression for his two userIDs) is untouched by all of the above and
must stay byte-for-byte.

## 3. Bugs found (new this pass)

| # | Where | What |
|---|-------|------|
| B1 | `EditorComponent.vue:941` | `melographJSON` fetched, stored, never used; duplicate of the MelographLayer fetch |
| B2 | `TranscriptionLayer.vue` `<style scopred>` | Typo since 2024-07-24: the component's CSS is global, not scoped |
| B3 | `spectrogramWorker.ts:402` | `debugger;` statement shipped in the production worker |
| B4 | `spectrogramWorker.ts:277` | `new Float32Array(uint8)` inflates the 44 MB uint8 spectrogram to 175 MB, plus scaled + intensified Float32 copies + RGBA ImageData ≈ 0.5 GB in the worker for a 1-hour recording; the values are 0–255 LUT indices and never need floats |
| B5 | `Renderer.vue:923` | `removeEventListener('click', () => …)` passes a fresh closure; the mounted listener is never removed (leaks per editor visit) |
| B6 | `TranscriptionLayer.vue:7923` | unmount does not `observer.disconnect()` nor cancel the Animated-playhead rAF (from July review, still open) |
| B7 | `TranscriptionLayer.vue:1946-1956` | DottedLine rAF loop self-reschedules forever when stopped (still open) |
| B8 | `TranscriptionLayer.vue:690` | `unloadChunk` is O(N²) via `trajRenderStatus.find` per trajectory |
| B9 | `server.ts:722` | `getOneTranscription` returns JSON as `text/html` |
| B10 | `AutomationWindow.vue:241` | `this.trajectories.values.length` (arrays have no `.values`) — last-point detection always false (still open) |
| B11 | `TrajSelectPanel.vue:264,288` | read-only vibrato inputs bound to `periods` instead of `extent`/`offset` (still open) |
| B12 | `EditorComponent.vue:589-601, 764-776` | dead D3 scrollbars, legacy spectrogram image fields, unregistered `handleKeyup`/`resize` (still open) |
| B13 | `EditorComponent.vue:927`, `main.ts` | hardcoded fallback transcription id |
| B14 | `spectrogramWorker.ts:41` / `SpectrogramLayer.vue:41` | `maxCanvasWidth` duplicated by hand in two files |

Baseline: `pnpm vitest run` → 22 files, 418 passed, 1 skipped.

## 4. Recommended plan (for approval)

**Phase A — infra, zero app-code risk, biggest win for repeat opens**
1. nginx: enable `gzip_types` (json, javascript, css, svg), `gzip_min_length 1024`,
   `gzip_vary on`. One-line uncomment in `nginx.conf`.
2. Replace `setNoCache` on `/spec_data`, `/melographs`, `/peaks`, `/spectrograms`
   with `Cache-Control: public, max-age=604800` (files are immutable per audioID;
   ETag revalidation stays). Keep `/audio` as is if you want, or same treatment.
3. Serve `/assets/*` with `maxAge: '1y', immutable` (express.static option or nginx
   `location /assets/`).
Expected: repeat opens go from ~30 MB to a few KB of revalidation; first open JS
1.5 MB → ~0.4 MB, JSON ~2 MB → ~0.4 MB.

**Phase B — load waterfall (small PR)**
4. Delete the unused `melographJSON` fetch (B1).
5. Parallelize: `getPiece` + `getAudioRecording` + `getRaagRule` +
   `getEditableCollections` + `updateTranscriptionViewed` in one `Promise.all`; drop
   `pieceExists` (handle 403/404 from `getPiece`).
6. Kick off the spectrogram worker fetch at mount, before settings load (the settings
   only affect colour/intensity, which are applied after the data arrives anyway).
~9 serial RTTs → ~3.

**Phase C — scroll and motion (the one you'll feel)**
7. Axes: sticky inside the scroller, delete `updateAxesScroll` and the double throttle.
8. `toRaw(piece)` for all read-only model calls in `TranscriptionLayer`, and cache
   the per-chunk tables per `resetTranscription()`; render newly visible chunks from a
   rAF budget (e.g. ≤8 ms/frame) instead of inside the observer callback.
9. Fix `scopred`, make `.tranContainer`/`.melContainer` non-scrollers, and verify in
   the browser that no nested scroller exists.
10. Remove the inert `scrollX` prop/watchers; fix B5–B8.
11. Throttle the playback highlight watcher (~100 ms) and cache `allDisplayChikaris`.
Motion prefs untouched; you verify Block playhead + wheel suppression still behave.

**Phase D — spectrogram memory/bandwidth (bigger, later)**
12. Keep the data as uint8 end-to-end in the worker (4× less memory), send tiles as
    transferable `ImageBitmap`s.
13. Serve the spectrogram as per-1000-column gz chunks (or uncompressed + Range) so
    the worker fetches the visible window first and the rest in the background;
    optionally a 4× downsampled preview file for the first paint.

**Phase E — cleanup**
14. B10–B14 and the dead code from the July review.

Suggested PR order: A (nginx edit is a manual step on the box + one server PR), then
B+C together on `audit/editor-perf-2026`, then D, then E.

## 5. Status (2026-09-04, later the same day)

Jon approved starting on A/B/C. Each phase is its own branch off main and its own PR:

| Phase | Branch | PR | Contents |
|-------|--------|----|----------|
| A | `perf/static-caching` | #48 | compression middleware; media `no-store` → `no-cache` (ETag revalidation); `/assets` immutable 1y; getOneTranscription as JSON |
| B | `perf/editor-load-waterfall` | #46 | parallel load, no pieceExists, unused melograph fetch removed, spectrogram `prefetch` message, worker keeps uint8, `debugger` removed |
| C | `perf/editor-scroll-motion` | #47 | sticky axes inside the scroller (verified over CDP), per-chunk Piece queries + toRaw display lists + per-frame chunk rendering (67 → 7.5 ms per chunk), nested scrollers and `scopred` fixed, leaks B5–B8, inert scrollX removed, playback highlight at 10 Hz |
| D | `explore/adaptive-spectrogram` (worktree `../idtap-spec-adaptive`, fleet pane `idtap-spec`) | — | Lukin & Todd adaptive-resolution prototype, in progress |
| E | — | — | not started (B10–B14, dead code) |

nginx `gzip_types` on the box is now optional (Express compresses); still worth uncommenting.
Jon must verify on his own machine that Block playhead + wheel suppression behave exactly as before (PR #47).
