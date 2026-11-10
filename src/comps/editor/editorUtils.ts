// Small pure helpers shared by the editor components. Kept free of Vue/D3 so
// they can be unit tested (src/ts/tests/editorUtils.test.ts).

// ---------------------------------------------------------------------------
// Keyboard shortcuts vs. text entry
// ---------------------------------------------------------------------------

// <input> types that take typed text (Backspace, digits and Space mean
// something to them). Checkboxes, ranges, buttons etc. are not text entry.
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range',
  'reset', 'submit',
]);

type MaybeElement = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
} | null | undefined;

// True when the event target is somewhere the user types: a text-like input,
// a textarea, a select, or a contenteditable element.
export const isTextEntryTarget = (target: EventTarget | MaybeElement): boolean => {
  const el = target as MaybeElement;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
};

// Keys that keep working while typing: Escape (close/deselect) and the bare
// modifier keys (so shift/alt/meta tracking stays in sync with keyup).
const TEXT_ENTRY_PASSTHROUGH_KEYS = ['Escape', 'Shift', 'Alt', 'Meta', 'Control'];

// One guard for every global editor keydown handler: returns true when the
// event belongs to a text field and the editor shortcut must not run.
export const isTypingInField = (
  e: { target: EventTarget | MaybeElement | null; key: string },
  alsoAllow: string[] = []
): boolean => {
  if (!isTextEntryTarget(e.target)) return false;
  return !TEXT_ENTRY_PASSTHROUGH_KEYS.includes(e.key) && !alsoAllow.includes(e.key);
};

// ---------------------------------------------------------------------------
// Go-to-time modal (MM:SS)
// ---------------------------------------------------------------------------

// Parses one time field; empty or garbage is 0, never NaN or negative.
export const parseTimeField = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

// Minutes and seconds fields -> seconds, clamped to [0, maxSeconds].
export const goToTimeSeconds = (
  minutes: string | number | null | undefined,
  seconds: string | number | null | undefined,
  maxSeconds = Infinity
): number => {
  const t = parseTimeField(minutes) * 60 + parseTimeField(seconds);
  return Math.min(Math.max(0, t), maxSeconds);
};

// ---------------------------------------------------------------------------
// Progress bar seek
// ---------------------------------------------------------------------------

// Fraction 0..1 along a bar for a pointer at clientX.
export const seekFraction = (clientX: number, left: number, width: number): number => {
  if (!(width > 0) || !Number.isFinite(clientX) || !Number.isFinite(left)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
};

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

// Zoomed size of the transcription along one axis. Zooming in never shrinks
// and zooming out never grows, so a size that is already outside the bounds
// (e.g. from saved display settings) is not snapped the wrong way.
export const clampZoomedSize = (
  current: number,
  factor: number,
  min: number,
  max: number
): number => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const target = current * factor;
  let out: number;
  if (factor >= 1) {
    out = Math.max(current, Math.min(target, hi));
  } else {
    out = Math.min(current, Math.max(target, lo));
  }
  return Math.round(out);
};

// Most pixels per second of audio the X zoom allows, and a hard cap on the
// total width (browsers stop laying out elements past roughly 16-33M px).
export const MAX_X_PX_PER_SEC = 2000;
export const MAX_TRANSCRIPTION_WIDTH = 15_000_000;
// Most pixels per octave the Y zoom allows (~6.7 px per cent).
export const MAX_Y_PX_PER_OCTAVE = 8000;

// ---------------------------------------------------------------------------
// Keeping the playhead in view
// ---------------------------------------------------------------------------

// If `t` is outside [start, end], the new view start time that puts the
// playhead `lead` of the way into the view (what the old "page flip" at the
// right edge did with 0.85 → 15%). Returns undefined when already in view.
export const playheadViewStart = (
  t: number,
  range: [number, number] | number[],
  lead = 0.15
): number | undefined => {
  const [start, end] = range;
  if (!Number.isFinite(t) || !Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  if (t >= start && t <= end) return undefined;
  const dur = end - start;
  return Math.max(0, t - lead * dur);
};
