# Review Section: Audio Playback & Synthesis

**Scope:** `src/comps/editor/audioPlayer/*` (EditorAudioPlayer 3044, Synths 1406,
SpectrogramControls 1503, MeterControls 1024, SynthesisControls, InstrumentControl,
PulseTapDetect), `src/comps/editor/SarangiSynth.vue`, `src/audioWorklets/*`,
`src/synths/woodblock.ts`, and the playback-position path into the playhead.

**Bottom line:** The **live synthesis path is genuinely good** — well-structured around
`Synths.vue`, near-zero `any`, physically-modeled worklets (Karplus-Strong sitar+jor,
sarangi, Klatt vocal, 4-string chikari) driven cleanly from trajectory envelopes. The
rot is concentrated in three places: (a) **versioned/orphaned worklet cruft** — roughly
half the `.worklet.js` files are dead, some with name collisions and global-state bugs;
(b) the **transport layer's seek/clock edge cases** (seeking while playing desyncs the
synths from the recorded audio); and (c) **misplaced, leaky control components**
(`MeterControls` has zero Web Audio yet lives in `audioPlayer/`; `SpectrogramControls`
leaks its reference oscillator). Two of my going-in assumptions were wrong and are
corrected below.

> Corrections to premises: `rubberband-processor.worklet.js` and `klattSynth2.worklet.js`
> are **not** stubs/empty — they're 612 KB and 17 KB *minified onto a single physical
> line* (hence `wc -l` = 1 / 0). Both are live. And there are **two** time-stretch
> engines, not one abandoned one (SoundTouch for tempo, rubberband for pitch).

---

## 1. Web Audio graph

One shared `AudioContext({sampleRate:48000})` created in
`EditorAudioPlayer.initializeAudio()` (`:1386`), passed down to `Synths`,
`SpectrogramControls`, `PulseTapDetect`. Two independent graphs meet only at
`ac.destination`:
- **Recorded audio:** `audioBuffer` → fresh `AudioBufferSourceNode` per play (`:2071`) →
  `recGain` → destination (rerouted through the rubberband node when pitch-shift is on).
- **Synths:** every synth converges on a shared `mixNode` → destination
  (`Synths.vue:86`). Because the two graphs never cross-mix, region time-stretch (which
  stretches only the recorded buffer) has to separately ramp `mixNode` to 0 to mute
  synths (`:1810`).

Per-synth subgraphs are wide (~20 nodes/sitar track: internal/external gains, DC-offset
highpass, a `captureAudio` tap + loop nodes, a `sonifyNode` mute). Teardown: `resetAudio`
closes+rebuilds the AC and bumps `synthsKey` to remount `Synths`; `beforeUnmount` ramps
gains and schedules `ac.close()`.

**Leaks (→ bug-hunt):** `stretchWorker` never `.terminate()`d (`:1790`);
`SpectrogramControls` reference oscillator never `stop()`/`disconnect()`ed on unmount;
`rubberBandNode` orphaned and **re-created on every `toggleShift`** (`:2478`) so repeated
toggling accumulates worklet processors; the `beforeUnmount` disconnect list (`:1152-1172`)
targets **legacy single-synth fields that are never populated** anymore (the real nodes
live in the `Synths` child array) — misleading dead maintenance that relies on `ac.close()`.

---

## 2. Transport & playhead position (priority)

**Clock = `AudioContext.currentTime`** — the single source of truth, no manual timer
drift. `play()` records `startedAt = now() - offset` (`:2089`); position is *derived*
(`now() - startedAt`).

**Propagation is a two-stage rAF system:**
1. The player's own rAF loop `loopPlayAnimation` (`:2209`) samples `ac.currentTime` each
   frame and `$emit('currentTimeEmit', curTime)` → `EditorComponent.currentTime` → prop to
   `TranscriptionLayer`.
2. In **Animated** mode the playhead runs a *second, independent* rAF loop
   (`TranscriptionLayer.vue:1830`) that **re-samples the audio clock directly** via
   `props.audioPlayerRef.getCurTime()` (not the prop) and critically-damps position
   (`currentX += (targetX-currentX)*0.7`) — so visual jitter from the prop pipeline is
   filtered. This is the smooth path. **Block/DottedLine modes ignore the smooth follower**
   and consume only the discretized `props.currentTime` (Block jumps once per whole
   second). So the cadence/jitter of `currentTimeEmit` matters only for the progress bar
   and time readouts in reduced-motion modes — relevant to the vestibular-migraine
   constraint (see `renderer.md`).

Clock drift is minimal by design (everything reads the same `ac.currentTime`); the one
exception is region/stretch mode, where position is re-derived from `stretchedBuffer.duration`
and `2**regionSpeed` each frame (`:2152`), so stretch-ratio rounding can introduce small
position error.

**Transport bugs (→ bug-hunt):**
- **Seek-while-playing desyncs synths.** Every scrub path (`:2353`, `:1619`, `:2440`,
  `back_15 :2969`) does `stop(); pausedAt = newTime; play()`, but `play()` only restarts
  the recorded `sourceNode` — `s.playAllTrajs()`/metronome are scheduled only from
  `togglePlay` (`:2242`). So after any seek the synths and metronome don't re-schedule and
  drift out of sync with the recorded audio.
- `dragEnd`/`handleCircleMouseUp` don't clamp `newTime` to `[0,duration]` (unlike
  `back_15`) → out-of-range `start()` offset on overshoot.
- **`transposition` watcher assumes rubberband exists:** `:1190` calls
  `this.rubberBandNode!.setPitch()` but the node is only created in `toggleShift` →
  changing transposition before enabling pitch-shift throws.
- `pausedAt === 0` is falsy-ambiguous in all three time getters (`:1279`, `:2129`, `:2154`)
  — a genuine paused-at-start is indistinguishable from "not paused."
- `curPlayTime` is a **computed with side effects** (mutates `loopTime`, `:1288`).

---

## 3. Synthesis engines (priority)

Params driven from `Trajectory.compute(t)` sampled at 0.02s into `Float32Array` envelopes
applied via `setValueCurveAtTime`.
- **Karplus-Strong sitar (main + jor):** live worklet `karplusStrong2.worklet.js` (registers
  `'karplusStrong'`). Two nodes/track (`sitarNode`, `jorNode`) = polyphonic dual-string;
  jor bypasses the main string's filters; independent per-string gain
  (`intSitarGainNode`/`intJorGainNode`), jor activates only with non-silent content.
- **Chikari drone:** live `chikaris4.worklet.js` — 4-string delay bank, per-string gains,
  strum-delay ordering.
- **Sarangi (main + second):** live `sarangi.worklet.js` — bowed-string model (dual delay
  lines, bandpass bow excitation, resonant body filter bank, notch). Two nodes/track,
  per-string gain.
- **Klatt vocal:** live `klattSynth2.worklet.js` (`'klatt-synth'`) — full formant synth
  (~40 params) driven from a 15-vowel table.
- **Capture/loop:** each synth has a `captureAudio` tap recording rendered output into a
  looping buffer (the loop-region feature).

**Versioned-worklet dead/live map:**
| File | Status |
|---|---|
| `karplusStrong2` | LIVE (`karplusStrong`) |
| `karplusStrong` v1 | DEAD — global-mutable-state-across-instances bug v2 fixed |
| `extendedKarplusStrong` | DEAD STUB — `process()` returns no output |
| `chikaris4` | LIVE |
| `chikaris2` | loaded but UNUSED (`'chikaris'` name never instantiated) |
| `chikaris` v1 | DEAD — global state + **`registerProcessor('chikaris')` name collision** with chikaris2 |
| `sarangi` | LIVE |
| `sarangi2` | DEAD |
| `klattSynth2` | LIVE (`klatt-synth`) — the "2" is vestigial naming, no v1 exists |
| `captureAudio`, `rubberband-processor` | LIVE |
| `SarangiSynth.vue` | DEAD — entire component orphaned; the real sarangi is in `Synths.vue` |

---

## 4. Time-stretching — two engines, both live

- **SoundTouch (tempo):** `src/js/bundledStretcherWorker.js` (full WSOLA SoundTouch) runs
  in a Web Worker; `stretch()` (`:1761`) batch-stretches the selected region offline and
  `playStretched()` plays it. Note: **offline region stretch only — no real-time full-track
  tempo change.**
- **Rubberband (pitch):** the 612 KB `rubberband-processor.worklet.js` is genuinely wired
  via `createRBNode` in `toggleShift`; used **only for pitch transposition**, never tempo.

The `soundtouchjs` audio-worklet variant appears unused (only the bundled worker is wired);
`this.soundtouch: any` (`:573`) is dead.

---

## 5. Misplaced / heavy control components

- **`SpectrogramControls.vue` (1503)** — ~95% a *display-settings* panel (colormaps,
  intensity, pitch range, presets) whose only audio is a Sa reference tone. **Belongs with
  display/transcription controls, not the audio player.** Leaks its Sa oscillator on
  unmount.
- **`MeterControls.vue` (1024)** — **zero Web Audio**; pure tala/meter editing. Clearly
  misplaced in `audioPlayer/`. Dead `d3` imports.
- **`PulseTapDetect.vue` (56)** — headless tempo tapper using `ac.currentTime` +
  `ac.outputLatency` to map taps into recording time; correctly placed, clean teardown.
- `SynthesisControls`/`InstrumentControl` — UI-only param surfaces, correctly placed.

---

## 6. Health summary

`any` count across the subsystem is **1** (the dead `soundtouch` field) — but the code
leans heavily on `!` non-null assertions, which is where the real type risk sits (e.g.
`rubberBandNode!.setPitch`). Dead code: ~5 dead worklets + `SarangiSynth.vue` +
`bufferSourceNodes` (write-only) + the legacy single-synth node fields + large commented
blocks.

**Bug-hunt leads:** seek-while-playing synth desync (§2); `rubberBandNode!` pre-shift
throw (`:1190`); missing `newTime` clamp (`:1613`, `:2433`); `pausedAt===0` ambiguity;
side-effecting `curPlayTime` computed; dead worklet name collision (`'chikaris'`);
`stretchWorker.onmessage` reassigned per call (`:1772`).
**Leaks:** `stretchWorker` (`:1790`), Sa oscillator, accumulating rubberband nodes.
**Cleanup/modernization:** delete the ~half-dozen dead worklets + `SarangiSynth.vue`; move
`MeterControls`/`SpectrogramControls` out of `audioPlayer/`; consider real-time tempo
stretch (current slow-playback is offline region-only).
