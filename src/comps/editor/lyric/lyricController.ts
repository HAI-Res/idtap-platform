/**
 * Lyric mode's editor-side state and behaviour (SPEC-provisional §4–§9, §11).
 *
 * Plain TypeScript, no DOM: the editor wraps one in `reactive()` and hands it to
 * TranscriptionLayer (clicks, keys, highlight), SyllablePicker and LyricLane.
 * Data changes go through Piece's lyric-mode operations; this holds only UI
 * state (selection, cursor, split marker, run-on ends, status, confirmations).
 */
import { Piece, Trajectory } from '@/ts/model';
import type { SyllableSpan } from '@/ts/model/piece';
import {
  Pack, PhonemeKey, Syllable, checkInvariants, silent, codasOf, derivedTone,
} from '@shared/syllables';
import { SyllableParts, parseSyllableText, romanizationOf } from '@shared/syllableText';

export type Slot = 'onset' | 'nucleus' | 'coda' | 'tone';
export type LyricSelection =
  | { t: 'none' }
  | { t: 'run'; first: string; last: string; pivot: string }
  | { t: 'syllable'; syl: Syllable };

export interface PendingConfirm {
  message: string;
  confirmLabel: string;
  run: () => void;
}

export interface Check { code: string; text: string; trajUid?: string; syl?: Syllable }

const HARD_ERRORS = new Set(['key-unknown', 'final-unknown', 'cluster-not-allowed']);
const arr = (x: PhonemeKey | undefined): string[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

export class LyricController {
  sel: LyricSelection = { t: 'none' };
  /** note cursor (← / →) and the trajectory last clicked or arrowed to */
  cursor: string | undefined = undefined;
  /** split-note marker: a fraction into `trajUid` (UI only; anchors keep t = 0) */
  marker: { trajUid: string; frac: number } | null = null;
  status = 'Click a note, then shift-click the last note of the syllable.';
  statusIsError = false;
  openSlot: Slot = 'onset';
  cluster = false;
  /** a confirmation the picker shows (Replace / Merge); no undo, so we ask */
  confirm: PendingConfirm | null = null;
  /** set after `/`: the picker's header for the second syllable */
  splitFrom: Syllable | null = null;
  /** typing box text, mirrored by both boxes */
  text = '';
  textError: string | undefined = undefined;
  inlineOpen = false;
  /** bumped on every change, so views recompute */
  version = 0;
  /** session-only: the last note each syllable was created over (spec §7.2) */
  private selectedEnds = new WeakMap<Syllable, string>();
  private inlineSnapshot: string | null = null;

  constructor(
    public piece: Piece,
    public track: () => number,
    private onChange: (structural: boolean) => void = () => {},
  ) {}

  // ------------------------------------------------------------ basics
  get pack(): Pack | undefined { return this.piece.pack; }
  get slots(): Slot[] { return this.pack?.id === 'jyutping' ? ['onset', 'nucleus', 'coda', 'tone'] : ['onset', 'nucleus', 'coda']; }

  available(editable: boolean): { ok: true } | { ok: false; reason: string } {
    if (!editable) return { ok: false, reason: 'Read only' };
    if (!this.piece.syllableTierEnabled) return { ok: false, reason: 'Set a tradition first' };
    const a = this.piece.syllableEditingAllowed(this.track());
    if (!a.ok) return { ok: false, reason: a.reason.startsWith('Syllables go on vocal') ? 'Lyrics go on vocal tracks' : a.reason };
    return { ok: true };
  }

  /** Row-0 trajectories of the editing track, in time order across phrases. */
  flat(): { traj: Trajectory; phraseIdx: number; frozen: boolean; start: number }[] {
    const out: { traj: Trajectory; phraseIdx: number; frozen: boolean; start: number }[] = [];
    (this.piece.phraseGrid[this.track()] || []).forEach((ph, pi) => {
      const frozen = this.piece.frozenSyllablePhraseUids.has(ph.uniqueId);
      (ph.trajectoryGrid[0] || []).forEach(t => out.push({ traj: t, phraseIdx: pi, frozen, start: (ph.startTime ?? 0) + (t.startTime ?? 0) }));
    });
    return out;
  }
  private idx(uid: string | undefined) { return uid === undefined ? -1 : this.flat().findIndex(x => x.traj.uniqueId === uid); }
  spans(track = this.track()): SyllableSpan[] { return this.piece.syllableSpans(track); }
  private editableSpans() { return this.spans().filter(x => !x.frozen); }
  spanOf(syl: Syllable) { return this.spans().find(x => x.syllable === syl); }

  private say(msg: string, error = false) { this.status = msg; this.statusIsError = error; }
  private changed(structural = false) { this.version++; this.onChange(structural); }
  private touch() { this.version++; }

  /** The run's indices (inclusive), or null. */
  runRange(): [number, number] | null {
    if (this.sel.t !== 'run') return null;
    const a = this.idx(this.sel.first), b = this.idx(this.sel.last);
    return a < 0 || b < 0 ? null : [Math.min(a, b), Math.max(a, b)];
  }

  /** uniqueIds drawn as selected in the plot. */
  highlightUids(): string[] {
    const f = this.flat();
    if (this.sel.t === 'run') { const r = this.runRange(); return r ? f.slice(r[0], r[1] + 1).map(x => x.traj.uniqueId!) : []; }
    if (this.sel.t === 'syllable') return this.spanOf(this.sel.syl)?.trajs.map(t => t.uniqueId!) ?? [];
    return [];
  }

  /** The part of a span drawn hatched: after the note it was created over (spec §7.2). -> start time or null. */
  runOnStart(span: SyllableSpan): number | null {
    const end = this.selectedEnds.get(span.syllable);
    if (!end) return null;
    const k = span.trajs.findIndex(t => t.uniqueId === end);
    if (k < 0 || k === span.trajs.length - 1) return null;
    const f = this.flat();
    const x = f.find(y => y.traj.uniqueId === span.trajs[k + 1].uniqueId);
    return x ? x.start : null;
  }

  // ------------------------------------------------------------ selection
  private selectRun(first: string, last: string, pivot = first) {
    this.sel = { t: 'run', first, last, pivot };
    this.marker = null;
    this.confirm = null;
    this.cluster = false;
    this.text = '';
    this.textError = undefined;
    this.openSlot = 'onset';
    this.touch();
  }
  selectSyllable(syl: Syllable) {
    this.sel = { t: 'syllable', syl };
    this.marker = null;
    this.confirm = null;
    this.cluster = false;
    this.splitFrom = null;
    this.text = syl.romanization ?? '';
    this.textError = undefined;
    this.openSlot = this.firstEmptySlot(this.partsOf(syl));
    this.touch();
  }
  clearSelection() {
    this.sel = { t: 'none' };
    this.marker = null;
    this.confirm = null;
    this.splitFrom = null;
    this.text = '';
    this.textError = undefined;
    this.touch();
  }

  clickTraj(uid: string, shift: boolean) {
    const f = this.flat();
    const k = this.idx(uid);
    if (k < 0) return;
    if (f[k].frozen) { this.say(`Phrase ${f[k].phraseIdx + 1} is frozen.`, true); return; }
    this.cursor = uid;
    if (shift && this.sel.t === 'run') {
      const p = this.idx(this.sel.pivot);
      const [a, b] = [Math.min(p, k), Math.max(p, k)];
      if (f.slice(a, b + 1).some(x => x.frozen)) { this.say('That run touches a frozen phrase.', true); return; }
      this.sel = { ...this.sel, first: f[a].traj.uniqueId!, last: f[b].traj.uniqueId! };
      this.splitFrom = null;
      this.touch();
    } else if (shift && this.sel.t === 'syllable') {
      const start = this.idx(this.sel.syl.anchor.traj);
      const [a, b] = [Math.min(start, k), Math.max(start, k)];
      this.selectRun(f[a].traj.uniqueId!, f[b].traj.uniqueId!, f[start].traj.uniqueId!);
    } else {
      this.splitFrom = null;
      this.selectRun(uid, uid);
    }
    this.describeRun();
  }

  clickSyllable(syl: Syllable) {
    if (this.spanOf(syl)?.frozen) { this.say('That syllable is in a frozen phrase and cannot be edited.', true); return; }
    this.selectSyllable(syl);
    this.say(`${Piece.syllableLabel(syl)} selected.`);
  }

  private describeRun() {
    const r = this.runRange();
    if (!r) return;
    const n = this.piece.syllablesStartingInRun(this.track(), this.flat()[r[0]].traj.uniqueId!, this.flat()[r[1]].traj.uniqueId!).length;
    this.say(`Notes ${r[0] + 1}–${r[1] + 1} selected.` + (n ? ` Your first pick replaces ${n} syllable(s).` : ''));
  }

  // ------------------------------------------------------------ picker logic
  partsOf(syl?: Syllable): SyllableParts {
    if (!syl) return {};
    return { onset: syl.onset, nucleus: syl.nucleus, coda: syl.coda, tone: syl.tone };
  }
  /** The parts the picker shows: the selected syllable's, or the typed preview in a run. */
  currentParts(): SyllableParts {
    if (this.sel.t === 'syllable') return this.partsOf(this.sel.syl);
    if (this.sel.t === 'run' && this.text) {
      const p = this.pack ? parseSyllableText(this.pack, this.text) : [];
      if (p.length === 1 && !p[0].errors.some(e => HARD_ERRORS.has(e.code))) return p[0].parts;
    }
    return {};
  }
  firstEmptySlot(parts: SyllableParts): Slot {
    for (const s of this.slots) {
      const v = (parts as any)[s];
      if (v === undefined || (Array.isArray(v) && !v.length)) return s;
    }
    return this.slots[0];
  }
  /** Why an option is disabled (Cantonese endings), or undefined. */
  disabledReason(slot: Slot, key: string | null, parts = this.currentParts()): string | undefined {
    const P = this.pack;
    if (!P || P.id !== 'jyutping' || slot !== 'coda' || !parts.nucleus) return undefined;
    const fk = parts.nucleus + (key ?? '');
    return P.finals && P.finals[fk] ? undefined : `no final ${fk}`;
  }
  /** A slot's value is "needed" (shown in the error colour). */
  needed(slot: Slot, parts = this.currentParts()): boolean {
    const P = this.pack;
    if (!P) return false;
    if (slot === 'nucleus') {
      if (parts.nucleus) return false;
      if (P.flags.nucleusOptional) return false;
      return !(P.id === 'jyutping' && (parts.coda === 'm' || parts.coda === 'ng'));
    }
    if (slot === 'tone') return P.id === 'jyutping' && !parts.tone;
    return false;
  }

  /** Apply a pick to parts (spec §5.3 rules). -> new parts and a note. */
  compose(slot: Slot, key: string | null, parts: SyllableParts): { parts: SyllableParts; note?: string } {
    const P = this.pack!;
    const out: SyllableParts = { ...parts };
    let note: string | undefined;
    if ((slot === 'onset' || slot === 'coda') && P.id === 'kurmanji' && this.cluster && key !== null) {
      out[slot] = [...arr(out[slot]), key];
      return { parts: out };
    }
    if (key === null) delete (out as any)[slot];
    else if ((slot === 'onset' || slot === 'coda') && P.id === 'kurmanji' && JSON.stringify(out[slot]) === JSON.stringify(key)) {
      delete out[slot]; // clicking the current key clears it
    } else (out as any)[slot] = key;
    if (P.id === 'jyutping') {
      if (slot === 'nucleus' && key === null) {
        delete out.onset;
        if (out.coda !== 'm' && out.coda !== 'ng') out.coda = 'm';
      } else if (slot === 'nucleus' && key !== null && out.coda !== undefined && typeof out.coda === 'string') {
        const fk = key + out.coda;
        if (!P.finals || !P.finals[fk]) { note = `No final ${fk}, so the ending was cleared.`; delete out.coda; }
      }
    }
    return { parts: out, note };
  }

  /** A pick in the picker (spec §5.4). */
  pick(slot: Slot, key: string | null) {
    if (!this.pack) return;
    if (this.sel.t === 'none') { this.say('Select a note, then shift-click the last note of the syllable.'); return; }
    const reason = this.disabledReason(slot, key);
    if (reason) { this.say(`(${reason})`, true); return; }
    const { parts, note } = this.compose(slot, key, this.currentParts());
    if (this.sel.t === 'run') {
      this.createOnRun(parts, note);
    } else {
      const r = this.piece.setSyllableParts(this.track(), this.sel.syl, parts);
      if (!r.ok) { this.say(r.reason, true); return; }
      this.text = this.sel.syl.romanization ?? '';
      this.say(note ?? r.warning ?? `${Piece.syllableLabel(this.sel.syl)} updated.`);
      this.changed();
    }
    if (this.cluster && (slot === 'onset' || slot === 'coda')) {
      this.openSlot = slot; // cluster picks don't advance (§5.5)
    } else {
      const i = this.slots.indexOf(slot);
      if (i < this.slots.length - 1) this.openSlot = this.slots[i + 1];
    }
  }

  /** Create the syllable over the selected run, confirming first when it replaces syllables (§8.1). */
  private createOnRun(parts: SyllableParts, note?: string, then?: () => void) {
    const r = this.runRange();
    if (!r) return;
    const f = this.flat();
    const first = f[r[0]].traj.uniqueId!, last = f[r[1]].traj.uniqueId!;
    const doIt = () => {
      this.confirm = null;
      const res = this.piece.setSyllableOnRun(this.track(), first, last, parts);
      if (!res.ok) { this.say(res.reason, true); return; }
      const syl = res.syllable!;
      this.selectedEnds.set(syl, last);
      // our own run -> syllable step is not a new selection: keep the cluster
      // switch, and drop the cursor (those clicks chose the run, not a split point)
      const cluster = this.cluster;
      this.selectSyllable(syl);
      this.cluster = cluster;
      this.cursor = undefined;
      this.say([note, res.warning].filter(Boolean).join(' ') || `${Piece.syllableLabel(syl)} created.`);
      this.changed();
      then?.();
    };
    const replaced = this.piece.syllablesStartingInRun(this.track(), first, last);
    if (replaced.length) {
      this.confirm = {
        message: `This replaces ${replaced.length} syllable(s) (${replaced.map(x => Piece.syllableLabel(x)).join(', ')}). Replace?`,
        confirmLabel: 'Replace',
        run: doIt,
      };
      this.touch();
    } else doIt();
  }

  // ------------------------------------------------------------ typing (§6)
  /** Live sync on every input event. */
  input(text: string) {
    this.text = text;
    this.textError = undefined;
    if (!this.pack) return;
    const p = parseSyllableText(this.pack, text);
    if (!text.trim()) { this.touch(); return; }
    if (p.length > 1) { this.textError = `That is ${p.length} syllables. Type one, or select fewer notes.`; this.touch(); return; }
    const hard = p[0]?.errors.find(e => HARD_ERRORS.has(e.code));
    if (hard) { this.textError = `${hard.code}: ${hard.msg}`; this.touch(); return; }
    if (this.sel.t === 'syllable' && p[0]) {
      const r = this.piece.setSyllableParts(this.track(), this.sel.syl, this.typedParts(p[0].parts));
      if (r.ok) this.changed();
    } else this.touch();
    if (p[0]?.parts.tone) this.openSlot = 'tone';
  }
  /** Cantonese character box. */
  setCharacter(ch: string) {
    if (this.sel.t !== 'syllable') return;
    const r = this.piece.setSyllableParts(this.track(), this.sel.syl, { ...this.partsOf(this.sel.syl), orthography: ch });
    if (r.ok) this.changed();
  }
  private typedParts(parts: SyllableParts): SyllableParts {
    // the character (Cantonese) is set in its own box only; a typed tone-less syllable keeps nothing else
    const out = { ...parts };
    if (this.pack?.id === 'jyutping') delete out.orthography;
    if (this.pack?.id === 'hindi-urdu' && out.orthography === undefined) out.orthography = '';
    delete out.wordStart;
    return out;
  }
  /** Enter in a box (§6.5). -> whether the inline box should close. */
  commitText(): boolean {
    if (!this.pack || this.textError) return false;
    const p = parseSyllableText(this.pack, this.text);
    if (p.length !== 1 || p[0].errors.some(e => HARD_ERRORS.has(e.code))) return false;
    if (this.sel.t === 'run') {
      this.createOnRun(this.typedParts(p[0].parts), undefined, () => this.nextSyllable());
      return true;
    }
    this.inlineSnapshot = null;
    return true;
  }
  openInline() {
    if (this.sel.t === 'none') return;
    this.inlineOpen = true;
    this.inlineSnapshot = this.sel.t === 'syllable' ? JSON.stringify(this.sel.syl) : null;
    this.touch();
  }
  /** Esc in the inline box: restore the syllable as it was when the box opened (not undo). */
  cancelInline() {
    if (this.sel.t === 'syllable' && this.inlineSnapshot) {
      const orig = JSON.parse(this.inlineSnapshot);
      const s = this.sel.syl as any;
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, orig);
      this.piece.setSyllableParts(this.track(), this.sel.syl, { ...this.partsOf(this.sel.syl), wordStart: !!orig.wordStart });
      this.text = this.sel.syl.romanization ?? '';
      this.changed();
    }
    this.inlineSnapshot = null;
    this.inlineOpen = false;
    this.touch();
  }

  // ------------------------------------------------------------ next syllable (§5.6)
  nextSyllable() {
    if (this.sel.t !== 'syllable') return;
    const sp = this.spanOf(this.sel.syl);
    const f = this.flat();
    if (!sp) return;
    const end = this.selectedEnds.get(this.sel.syl);
    const k = end ? sp.trajs.findIndex(t => t.uniqueId === end) : -1;
    if (k >= 0 && k < sp.trajs.length - 1) {
      const L = this.idx(end);
      const nxt = f[L + 1];
      this.selectRun(nxt.traj.uniqueId!, nxt.traj.uniqueId!);
      this.cursor = nxt.traj.uniqueId!;
      this.say(`Note ${L + 2} selected. Shift-click to the last note of the next syllable.`);
      return;
    }
    const spans = this.editableSpans();
    const cur = this.sel.syl;
    const me = spans.findIndex(x => x.syllable === cur);
    if (me >= 0 && me + 1 < spans.length) { this.selectSyllable(spans[me + 1].syllable); this.say(`${Piece.syllableLabel(spans[me + 1].syllable)} selected.`); }
    else {
      // nothing after: offer the next note as a new run, when there is one
      const last = this.idx(sp.trajs[sp.trajs.length - 1].uniqueId);
      let n = last + 1;
      while (n < f.length && silent(f[n].traj)) n++;
      if (n < f.length && !f[n].frozen) {
        this.selectRun(f[n].traj.uniqueId!, f[n].traj.uniqueId!);
        this.say(`Note ${n + 1} selected. Shift-click to the last note of the next syllable.`);
      } else this.say('That was the last syllable.');
    }
  }

  // ------------------------------------------------------------ operations (§8)
  moveStart(dir: -1 | 1) {
    if (this.sel.t !== 'syllable') return;
    const r = this.piece.moveSyllableStart(this.track(), this.sel.syl, dir);
    if (!r.ok) { this.say(r.reason, true); return; }
    const k = this.idx(this.sel.syl.anchor.traj);
    this.say(`${Piece.syllableLabel(this.sel.syl)} now starts on note ${k + 1}.`);
    this.changed();
  }

  slash() {
    if (this.sel.t !== 'syllable') return;
    const syl = this.sel.syl;
    const at = this.cursor && this.spanOf(syl)?.trajs.some(t => t.uniqueId === this.cursor) ? this.cursor : undefined;
    const r = this.piece.splitRunFor(this.track(), syl, at);
    if (!r.ok) { this.say(r.reason, true); return; }
    this.selectRun(r.firstUid, r.lastUid);
    this.splitFrom = syl;
    this.say(`Second syllable: pick or type it. Esc keeps ${Piece.syllableLabel(syl)} whole.`);
  }

  merge() {
    if (this.sel.t !== 'syllable') return;
    const syl = this.sel.syl;
    const spans = this.editableSpans();
    const i = spans.findIndex(x => x.syllable === syl);
    const prev = spans[i - 1]?.syllable;
    const doIt = () => {
      this.confirm = null;
      const r = this.piece.mergeSyllableIntoPrevious(this.track(), syl);
      if (!r.ok) { this.say(r.reason, true); this.touch(); return; }
      if (r.syllable) this.selectSyllable(r.syllable); else this.clearSelection();
      this.say(`Removed ${Piece.syllableLabel(syl)}; its notes are held by ${Piece.syllableLabel(prev)}.`);
      this.changed();
    };
    // refusals first, so the dialog only appears when the merge can happen
    const k = this.idx(syl.anchor.traj);
    const f = this.flat();
    if (k === 0 || silent(f[k - 1].traj)) {
      this.say('This syllable follows a silence, so it has no previous syllable to join (unanchored-start).', true);
      return;
    }
    this.confirm = {
      message: `Merge ${Piece.syllableLabel(syl)} into ${Piece.syllableLabel(prev)}? ${Piece.syllableLabel(syl)} is removed, and its notes are held by ${Piece.syllableLabel(prev)}.`,
      confirmLabel: 'Merge',
      run: doIt,
    };
    this.touch();
  }

  /** Alt+Shift+← / →: move the split-note marker in quarter steps (§8.3). */
  moveMarker(dir: -1 | 1) {
    if (this.sel.t !== 'syllable') return;
    const f = this.flat();
    const start = this.idx(this.sel.syl.anchor.traj);
    const spans = this.editableSpans();
    const me = spans.findIndex(x => x.syllable === (this.sel as any).syl);
    const nextStart = spans[me + 1] ? this.idx(spans[me + 1].syllable.anchor.traj) : f.length;
    const prevStart = spans[me - 1] ? this.idx(spans[me - 1].syllable.anchor.traj) : -1;
    let k = this.marker ? this.idx(this.marker.trajUid) : start;
    let q = this.marker ? Math.round(this.marker.frac * 4) : 0;
    q += dir;
    if (q >= 4) { k += 1; q = 1; }
    if (q <= 0) { k -= 1; q = 3; }
    if (k < 0 || k >= f.length || k >= nextStart || k <= prevStart || silent(f[k].traj) || f[k].frozen) {
      this.say('The marker cannot go further.', true);
      return;
    }
    if (k < start && f.slice(k, start).some(x => silent(x.traj))) { this.say('The marker cannot go past a silence.', true); return; }
    this.marker = { trajUid: f[k].traj.uniqueId!, frac: q / 4 };
    this.say(`Split marker at ${q * 25}% of note ${k + 1}. Enter splits the note there.`);
    this.touch();
  }

  splitNoteHere() {
    if (this.sel.t !== 'syllable' || !this.marker) return;
    const r = this.piece.splitNoteHere(this.track(), this.sel.syl, this.marker.trajUid, this.marker.frac);
    this.marker = null;
    if (!r.ok) { this.say(r.reason, true); this.touch(); return; }
    this.say(`Note split; ${Piece.syllableLabel(this.sel.syl)} starts on the new note.`);
    this.changed(true);
  }

  setWordStart(on: boolean) {
    if (this.sel.t !== 'syllable') return;
    const r = this.piece.setSyllableParts(this.track(), this.sel.syl, { ...this.partsOf(this.sel.syl), wordStart: on });
    if (r.ok) this.changed();
  }

  confirmYes() { const c = this.confirm; if (c) c.run(); }
  confirmNo() { this.confirm = null; this.say('Cancelled.'); this.touch(); }

  // ------------------------------------------------------------ keys (§11)
  /** -> true when lyric mode handled the key. Called only in lyric mode, never from a text box. */
  key(e: { key: string; shiftKey: boolean; altKey: boolean; metaKey?: boolean; ctrlKey?: boolean }): boolean | 'leave' {
    if (e.metaKey || e.ctrlKey) return false; // Cmd/Ctrl shortcuts stay as they are
    const f = this.flat();
    const k = this.idx(this.cursor ?? (this.sel.t === 'syllable' ? this.sel.syl.anchor.traj : this.sel.t === 'run' ? this.sel.last : undefined));
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey && e.altKey) { this.moveMarker(dir); return true; }
        if (e.shiftKey && this.sel.t === 'syllable') { this.moveStart(dir); return true; }
        if (e.shiftKey && this.sel.t === 'run') {
          const nk = this.idx(this.sel.last) + dir;
          if (nk < 0 || nk >= f.length || f[nk].frozen) return true;
          this.clickTraj(f[nk].traj.uniqueId!, true);
          return true;
        }
        let nk = k < 0 ? 0 : k + dir;
        while (nk >= 0 && nk < f.length && f[nk].frozen) nk += dir;
        if (nk < 0 || nk >= f.length) return true;
        this.clickTraj(f[nk].traj.uniqueId!, false);
        return true;
      }
      case 'Enter':
        if (this.marker) { this.splitNoteHere(); return true; }
        if (this.confirm) { this.confirmYes(); return true; }
        this.openInline();
        return true;
      case 'Tab': {
        const spans = this.editableSpans();
        if (!spans.length) return true;
        const cur = this.sel.t === 'syllable' ? spans.findIndex(x => x.syllable === (this.sel as any).syl) : -1;
        const n = e.shiftKey ? (cur <= 0 ? spans.length - 1 : cur - 1) : (cur + 1) % spans.length;
        this.selectSyllable(spans[n].syllable);
        this.say(`${Piece.syllableLabel(spans[n].syllable)} selected.`);
        return true;
      }
      case '/':
        this.slash();
        return true;
      case 'Backspace':
      case 'Delete':
        this.merge();
        return true;
      case 'Escape':
        if (this.confirm) { this.confirmNo(); return true; }
        if (this.marker) { this.marker = null; this.say('Split marker removed.'); this.touch(); return true; }
        if (this.splitFrom) { const s = this.splitFrom; this.splitFrom = null; this.selectSyllable(s); this.say(`${Piece.syllableLabel(s)} kept whole.`); return true; }
        if (this.sel.t !== 'none') { this.clearSelection(); this.say('Selection cleared.'); return true; }
        return 'leave';
      default:
        return false;
    }
  }

  // ------------------------------------------------------------ checks (§9)
  checks(): Check[] {
    const out: Check[] = [];
    const k0 = this.track();
    const view = {
      system: this.piece.system,
      instrumentation: this.piece.instrumentation,
      phraseGrid: this.piece.syllablesByPhrase().map((track, k) => k !== k0 ? [] : track.map((list, pi) => ({
        trajectoryGrid: [this.piece.phraseGrid[k][pi].trajectoryGrid[0] || []],
        syllables: list,
      }))),
    };
    let found: [string, string][] = [];
    try { found = checkInvariants(view as any); } catch { /* unknown pack */ }
    const TEXT: { [c: string]: string } = {
      'unanchored-start': 'a note after a silence (or the first note) has no syllable',
      'nucleus-missing': 'no vowel',
      'key-unknown': 'a key the pack does not have',
      'final-unknown': 'not one of the pack\'s finals',
      'cluster-not-allowed': 'this pack allows no clusters',
      'tone-not-allowed': 'this pack has no tones',
      'nucleus-lyric-mismatch': 'nucleus and lyric vowel disagree',
    };
    const flat = this.flat();
    const spans = this.spans();
    for (const [code, where] of found) {
      if (code === 'track-not-vocal') continue;
      const m = /phrase (\d+) (syllable|traj) (\d+)/.exec(where);
      let syl: Syllable | undefined; let trajUid: string | undefined;
      if (m && m[2] === 'traj') trajUid = this.piece.phraseGrid[k0][+m[1]]?.trajectoryGrid[0]?.[+m[3]]?.uniqueId;
      if (m && m[2] === 'syllable') syl = this.piece.syllablesByPhrase()[k0][+m[1]]?.[+m[3]];
      const note = trajUid ? flat.findIndex(x => x.traj.uniqueId === trajUid) + 1 : 0;
      out.push({ code, text: (TEXT[code] ?? code) + (note ? ` (note ${note})` : syl ? ` (${Piece.syllableLabel(syl)})` : ''), trajUid, syl });
    }
    if (this.pack?.id === 'jyutping') {
      for (const sp of spans) if (!sp.frozen && !sp.syllable.tone) out.push({ code: 'tone-missing', text: `no tone (${Piece.syllableLabel(sp.syllable)})`, syl: sp.syllable });
    }
    return out;
  }
  clickCheck(c: Check) {
    if (c.syl) this.clickSyllable(c.syl);
    else if (c.trajUid) this.clickTraj(c.trajUid, false);
  }

  // ------------------------------------------------------------ display helpers
  /** Romanization with tone as superscript and Cantonese nine-tone marker: e.g. sik⁶·⁹. */
  displayRomanization(syl: Syllable): { body: string; tone?: string; nine?: string } {
    const P = this.pack;
    if (P?.id !== 'jyutping') return { body: syl.romanization ?? (P ? romanizationOf(P, syl) : '') ?? '' };
    const body = (syl.romanization ?? '').replace(/[1-6]$/, '');
    const nine = syl.tone ? derivedTone(syl, P) : undefined;
    return { body, tone: syl.tone, nine: nine && nine !== syl.tone ? nine : undefined };
  }
  codaKeys(): string[] { return this.pack ? Object.keys(codasOf(this.pack)) : []; }
}
