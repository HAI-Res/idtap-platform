/**
 * Syllable tier, system and phoneme packs (idtap-contract 0.3.0: PROP-7, PROP-8,
 * PROP-9).
 *
 * A port of idtap-contract `conformance/syllables.py`, the normative reference.
 * The functions work on plain objects shaped like the wire JSON, so the same code
 * runs on a stored Mongo document (the server's write guard) and on the in-memory
 * model (model Trajectory/Phrase objects carry the same field names). Keep it in
 * step with the reference: each function names its Python counterpart.
 *
 * Terms (as in the reference)
 *   track     phraseGrid[k]: one phrase sequence (one singer).
 *   row0(ph)  ph.trajectoryGrid[0], the melodic row; syllables live there only.
 *   silence   a trajectory with id 12.
 *   absent    a legacy field that is missing OR null (null == absent, SYL-1).
 *             '' is a stored value, not absent.
 */
import hindiUrdu from './packs/hindi-urdu.json';
import jyutping from './packs/jyutping.json';
import kurmanji from './packs/kurmanji.json';

// ------------------------------------------------------------------ types
export type PhonemeKey = string | string[];

export interface SyllableObservation {
  vowel: string | null;
  source: 'human' | 'model' | 'pack' | string;
}

export interface Syllable {
  anchor: { traj: string; t?: number };
  orthography?: string;
  romanization?: string;
  onset?: PhonemeKey;
  nucleus?: string;
  coda?: PhonemeKey;
  tone?: string;
  wordStart?: boolean;
  lyric: SyllableObservation;
  sung?: SyllableObservation;
  [extra: string]: unknown;
}

export interface System {
  pitch?: string;
  phonology?: string;
  rhythm?: string;
  display?: string[];
  [extra: string]: string | string[] | undefined;
}

/** The fields of a trajectory the tier reads. Model Trajectory objects fit. */
export interface TrajLike {
  id?: number;
  uniqueId?: string | null;
  vowel?: string | null;
  startConsonant?: string | null;
  endConsonant?: string | null;
  articulations?: { [k: string]: any } | null;
  [k: string]: any;
}
export interface PhraseLike {
  trajectoryGrid?: TrajLike[][] | null;
  syllables?: Syllable[] | null;
  [k: string]: any;
}
export interface PieceLike {
  phraseGrid: PhraseLike[][];
  system?: System | null;
  instrumentation?: string[] | null;
  [k: string]: any;
}

export interface Pack {
  id: string;
  flags: {
    syllabicNasals: boolean; onsetClusters: boolean; codaClusters: boolean;
    tones: boolean; nucleusOptional: boolean; legacyExact: boolean;
  };
  consonants: { [key: string]: PackEntry };
  codas: 'consonants' | { [key: string]: PackEntry };
  vowels: { [key: string]: PackEntry };
  finals?: { [key: string]: { nucleus: string | null; coda: string | null; ipa: string; syllabic?: boolean } };
  tones?: { [key: string]: any };
  toneSystems?: { [name: string]: { checkedCodas: string[]; checked: { [tone: string]: string } } };
  [k: string]: any;
}
export interface PackEntry {
  ipa?: string;
  legacy?: { iso: string; hindi?: string; ipa?: string; engTrans?: string };
  [k: string]: any;
}

/** One trajectory's legacy fields in project_piece's shape. */
export interface LegacyFields {
  vowel?: string;
  startConsonant?: string; startConsonantHindi?: string;
  startConsonantIpa?: string; startConsonantEngTrans?: string;
  endConsonant?: string; endConsonantHindi?: string;
  endConsonantIpa?: string; endConsonantEngTrans?: string;
  art0: { [k: string]: string } | null;
  art1: { [k: string]: string } | null;
}

// ------------------------------------------------------------------ constants
export const HINDUSTANI: Required<Pick<System, 'pitch' | 'phonology' | 'rhythm' | 'display'>> = {
  pitch: 'raga', phonology: 'hindi-urdu', rhythm: 'tala', display: ['sargam', 'Deva'],
};
export const LEGACY_PACK = 'hindi-urdu';
/** Instrumentation labels that count as a vocal track (same list as Instrument.Vocal_*). */
export const VOCAL_INSTRUMENTS = ['Vocal (M)', 'Vocal (F)'];
/** Invariant codes reported at warn level: shown, never refused. */
export const WARNINGS = new Set(['track-not-vocal']);
export const WIRE_FIELDS = [
  'vowel',
  'startConsonant', 'startConsonantHindi', 'startConsonantIpa', 'startConsonantEngTrans',
  'endConsonant', 'endConsonantHindi', 'endConsonantIpa', 'endConsonantEngTrans',
] as const;
/** Fields the legacy projection can carry; anything else makes a piece unsafe for a pre-0.3.0 writer. */
const LEGACY_HOLDABLE = new Set(['anchor', 'onset', 'nucleus', 'coda', 'lyric']);

/** Bundled packs (PROP-9), as data. Served by the API at /api/packs. */
export const PACKS: { [id: string]: Pack } = {
  'hindi-urdu': hindiUrdu as unknown as Pack,
  'jyutping': jyutping as unknown as Pack,
  'kurmanji': kurmanji as unknown as Pack,
};

export function loadPack(id: string): Pack {
  const p = PACKS[id];
  if (!p) throw new Error(`unknown phoneme pack '${id}'`);
  return p;
}

// ------------------------------------------------------------------ PROP-7
/** resolve_system: absent = Hindustani; missing components take defaults; unknown ones kept. */
export function resolveSystem(piece: { system?: System | null }): System {
  return { ...HINDUSTANI, ...(piece.system || {}) };
}

/** pack_of. Throws for a phonology id no bundled pack has. */
export function packOf(piece: { system?: System | null }): Pack {
  return loadPack(resolveSystem(piece).phonology as string);
}

export function codasOf(pack: Pack): { [key: string]: PackEntry } {
  return pack.codas === 'consonants' ? pack.consonants : pack.codas;
}

// ------------------------------------------------------------------ helpers
export function row0<T extends TrajLike>(ph: { trajectoryGrid?: T[][] | null }): T[] {
  const grid = ph.trajectoryGrid;
  if (!grid || grid.length === 0) return [];
  return grid[0] || [];
}

export const silent = (t: TrajLike) => t.id === 12;

/** val: the stored value, null/undefined -> null (null == absent). */
export function val(t: TrajLike, k: 'vowel' | 'startConsonant' | 'endConsonant'): string | null {
  const v = t[k];
  return v === undefined || v === null ? null : v;
}

export function hasPhonetics(t: TrajLike): boolean {
  return val(t, 'vowel') !== null || val(t, 'startConsonant') !== null || val(t, 'endConsonant') !== null;
}

/** uid_of: heal, projection and re-homing need a uniqueId on every row-0 trajectory. */
export function uidOf(t: TrajLike): string {
  const u = t.uniqueId;
  if (typeof u !== 'string' || !u) {
    throw new Error('trajectory without uniqueId: assign ids before heal/project/rehome');
  }
  return u;
}

/** track_flat: [phraseIdx, trajIdx, traj] over row 0, in order. */
export function trackFlat<T extends TrajLike>(track: { trajectoryGrid?: T[][] | null }[]): [number, number, T][] {
  const out: [number, number, T][] = [];
  track.forEach((ph, pi) => row0(ph).forEach((t, ti) => out.push([pi, ti, t])));
  return out;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/**
 * A stored syllable the rules can read: an object with an anchor naming a
 * trajectory. Anything else (no anchor, a null entry, a string) is carried
 * through unchanged by the model and reported as `syllable-malformed`; it never
 * makes a load throw.
 */
export function wellFormedSyllable(s: unknown): s is Syllable {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const a = (s as any).anchor;
  if (!a || typeof a !== 'object' || typeof a.traj !== 'string' || a.traj === '') return false;
  // as the reference: a lyric that is present must be an object (null is malformed)
  if (!('lyric' in (s as object))) return true;
  const l = (s as any).lyric;
  return !!l && typeof l === 'object' && !Array.isArray(l);
}

// ------------------------------------------------------------------ heal
/** first_traj_idxs (Phrase.firstTrajIdxs with null == absent). */
export function firstTrajIdxs(trajs: TrajLike[]): number[] {
  const idxs: number[] = [];
  let ct = 0;
  let silentTrigger = false;
  let lastVowel: string | null = null;
  let endTrigger = false;
  trajs.forEach((t, i) => {
    if (!silent(t)) {
      const c1 = ct === 0;
      const c3 = val(t, 'startConsonant') !== null;
      const c5 = val(t, 'vowel') !== lastVowel;
      if (c1 || silentTrigger || c3 || endTrigger || c5) idxs.push(i);
      ct += 1;
      endTrigger = val(t, 'endConsonant') !== null;
      lastVowel = val(t, 'vowel');
    }
    silentTrigger = silent(t);
  });
  return idxs;
}

/** heal_phrase: syllables from one phrase's legacy fields. */
export function healTrajs(trajs: TrajLike[]): Syllable[] {
  const idxs = firstTrajIdxs(trajs);
  return idxs.map((i, n) => {
    const stop = n + 1 < idxs.length ? idxs[n + 1] : trajs.length;
    const span: TrajLike[] = [];
    for (const t of trajs.slice(i, stop)) {
      if (silent(t)) break;
      span.push(t);
    }
    const first = span[0];
    const last = span[span.length - 1];
    const syl: Syllable = { anchor: { traj: uidOf(first), t: 0 } } as Syllable;
    if (val(first, 'startConsonant') !== null) syl.onset = first.startConsonant as string;
    const vowel = val(first, 'vowel');
    if (vowel !== null) syl.nucleus = vowel;
    if (val(last, 'endConsonant') !== null) syl.coda = last.endConsonant as string;
    syl.lyric = { vowel, source: 'pack' };
    return syl;
  });
}

export const healPhrase = (ph: PhraseLike) => healTrajs(row0(ph));

/**
 * vocal_track: syllables live on vocal tracks only (Jon, 2026-11-13). A track is
 * vocal when instrumentation[k] is a vocal label; a missing label is not vocal.
 * Non-vocal tracks get no heal and no projection: their legacy fields stand
 * exactly as stored (the editor's default 'a' on instrumental trajectories is
 * not text), and a stored tier there is kept, warned about, never projected.
 */
export function vocalTrack(piece: { instrumentation?: string[] | null }, k: number): boolean {
  const instr = piece.instrumentation || [];
  return k < instr.length && VOCAL_INSTRUMENTS.includes(instr[k]);
}

export function trackIsPhonetic(track: PhraseLike[]): boolean {
  return trackFlat(track).some(([, , t]) => hasPhonetics(t));
}

/** heal_piece: returns a copy; phrases with a `syllables` key keep it (even []). */
export function healPiece<P extends PieceLike>(piece: P): P {
  const pc = clone(piece);
  pc.phraseGrid.forEach((track, k) => {
    if (!vocalTrack(pc, k)) return; // nothing is created on a non-vocal track
    const phonetic = trackIsPhonetic(track);
    for (const ph of track) {
      if (!('syllables' in ph) || ph.syllables === undefined) {
        ph.syllables = phonetic ? healPhrase(ph) : [];
      }
    }
  });
  return pc;
}

// ------------------------------------------------------------------ projection
type LegacyTuple = [string, string | undefined, string | undefined, string | undefined];

/** _legacy_entry: (iso, hindi, ipa, engTrans) for `key`, or null when the legacy fields cannot carry it. */
function legacyEntry(pack: Pack, table: 'consonants' | 'vowels' | 'codas', key: PhonemeKey | null | undefined): LegacyTuple | null {
  if (key === null || key === undefined || Array.isArray(key)) return null;
  if (pack.id === LEGACY_PACK) {
    const map = table === 'codas' ? codasOf(pack) : pack[table];
    const e = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    if (e === undefined) return [key, undefined, undefined, undefined]; // unknown string: kept as-is
    const leg = e.legacy;
    if (!leg) return null; // e.g. ṇa: no legacy form
    return [leg.iso, leg.hindi, leg.ipa, leg.engTrans];
  }
  // Any other pack projects nothing (Jon, 2026-11-12).
  return null;
}

/** The legacy (iso, hindi, ipa, engTrans) a key projects to, or null when the legacy fields cannot carry it. */
export const legacyFormOf = (pack: Pack, table: 'consonants' | 'vowels' | 'codas', key: PhonemeKey | null | undefined) =>
  legacyEntry(pack, table, key);

function clusterHead(key: PhonemeKey | undefined, onset: boolean): string | undefined {
  if (Array.isArray(key)) return onset ? key[0] : key[key.length - 1];
  return key;
}

/** spans: [syllable, its trajectories] over a track, plus uncovered non-silent trajs. */
export function spans<T extends TrajLike>(track: { trajectoryGrid?: T[][] | null; syllables?: Syllable[] | null }[]):
  { spans: [Syllable, T[]][]; uncovered: T[] } {
  const anchors = new Map<string, Syllable>();
  for (const ph of track) {
    for (const s of Array.isArray(ph.syllables) ? ph.syllables : []) if (wellFormedSyllable(s)) anchors.set(s.anchor.traj, s);
  }
  return spansFromAnchors(trackFlat(track).map(x => x[2]), anchors);
}

export function spansFromAnchors<T extends TrajLike>(trajs: T[], anchors: Map<string, Syllable>):
  { spans: [Syllable, T[]][]; uncovered: T[] } {
  const out: [Syllable, T[]][] = [];
  const uncovered: T[] = [];
  let cur: [Syllable, T[]] | null = null;
  for (const t of trajs) {
    if (silent(t)) { cur = null; continue; }
    const uid = uidOf(t);
    const s = anchors.get(uid);
    if (s) { cur = [s, []]; out.push(cur); }
    if (cur === null) uncovered.push(t); else cur[1].push(t);
  }
  return { spans: out, uncovered };
}

/**
 * project_piece over one track's row-0 trajectories and its syllables (a pool;
 * phrase membership does not matter, the anchor uid does). -> {uid: LegacyFields}.
 */
export function projectTrack(pack: Pack, trajs: TrajLike[], syllables: Syllable[]): { [uid: string]: LegacyFields } {
  const res: { [uid: string]: LegacyFields } = {};
  for (const t of trajs) res[uidOf(t)] = { art0: null, art1: null };
  const anchors = new Map<string, Syllable>();
  for (const s of syllables) if (wellFormedSyllable(s)) anchors.set(s.anchor.traj, s);
  const sp = spansFromAnchors(trajs, anchors).spans;
  for (const [syl, ts] of sp) {
    const v = legacyEntry(pack, 'vowels', (syl.lyric || ({} as any)).vowel);
    const on = legacyEntry(pack, 'consonants', clusterHead(syl.onset, true));
    const co = legacyEntry(pack, 'codas', clusterHead(syl.coda, false));
    if (v) for (const t of ts) res[t.uniqueId as string].vowel = v[0];
    const ends: [LegacyTuple | null, TrajLike, 'startConsonant' | 'endConsonant', 'art0' | 'art1'][] =
      [[on, ts[0], 'startConsonant', 'art0'], [co, ts[ts.length - 1], 'endConsonant', 'art1']];
    for (const [c, where, pre, art] of ends) {
      if (!c) continue;
      const r = res[where.uniqueId as string] as any;
      (['', 'Hindi', 'Ipa', 'EngTrans'] as const).forEach((suffix, i) => {
        if (c[i] !== undefined && c[i] !== null) r[pre + suffix] = c[i];
      });
      const a: { [k: string]: string } = { name: 'consonant', stroke: c[0] };
      (['hindi', 'ipa', 'engTrans'] as const).forEach((k, i) => {
        if (c[i + 1] !== undefined && c[i + 1] !== null) a[k] = c[i + 1] as string;
      });
      r[art] = a;
    }
  }
  return res;
}

/** project_piece: normative projection syllables -> legacy fields for every row-0 trajectory. */
export function projectPiece(piece: PieceLike): { [uid: string]: LegacyFields } {
  const pack = packOf(piece);
  const res: { [uid: string]: LegacyFields } = {};
  piece.phraseGrid.forEach((track, k) => {
    const trajs = trackFlat(track).map(x => x[2]);
    if (!vocalTrack(piece, k)) {
      // non-vocal tracks are never projected: the stored fields stand
      for (const t of trajs) res[uidOf(t)] = legacyOfTraj(t);
      return;
    }
    const syls = track.flatMap(ph => ph.syllables || []);
    Object.assign(res, projectTrack(pack, trajs, syls));
  });
  return res;
}

/** legacy_of_traj: the legacy fields as stored on a trajectory, in project_piece's shape. */
export function legacyOfTraj(t: TrajLike): LegacyFields {
  const r: any = {};
  for (const k of WIRE_FIELDS) if (t[k] !== undefined && t[k] !== null) r[k] = t[k];
  const arts = t.articulations || {};
  for (const [key, name] of [['0.00', 'art0'], ['1.00', 'art1']]) {
    const a = arts[key];
    r[name] = a && a.name === 'consonant' ? JSON.parse(JSON.stringify(a)) : null;
  }
  return r;
}

/** apply_projection: write the projection onto a copy of a JSON piece (dual-write). */
export function applyProjection<P extends PieceLike>(piece: P): P {
  const pc = clone(piece);
  const proj = projectPiece(pc);
  pc.phraseGrid.forEach((track, k) => {
    if (!vocalTrack(pc, k)) return; // left exactly as stored
    for (const [, , t] of trackFlat(track)) writeLegacy(t, proj[uidOf(t)]);
  });
  return pc;
}

/** Write one trajectory's projected legacy fields onto a plain JSON trajectory. */
export function writeLegacy(t: TrajLike, p: LegacyFields) {
  for (const k of WIRE_FIELDS) {
    delete t[k];
    if ((p as any)[k] !== undefined) t[k] = (p as any)[k];
  }
  const had = t.articulations;
  const arts: { [k: string]: any } = { ...(had || {}) };
  for (const [key, name] of [['0.00', 'art0'], ['1.00', 'art1']] as const) {
    if ((arts[key] || {}).name === 'consonant') delete arts[key];
    if (p[name]) arts[key] = p[name];
  }
  if (Object.keys(arts).length > 0 || (had && typeof had === 'object')) t.articulations = arts;
}

// ------------------------------------------------------------------ derived
function keys(x: PhonemeKey | undefined | null): string[] {
  return Array.isArray(x) ? x : x !== undefined && x !== null ? [x] : [];
}

/** final_key: key into pack.finals (nucleus + coda), or null for a coda cluster. */
export function finalKey(syl: Syllable): string | null {
  if (Array.isArray(syl.coda)) return null;
  return (syl.nucleus || '') + (syl.coda || '');
}

const own = (m: object | undefined | null, k: string) => !!m && Object.prototype.hasOwnProperty.call(m, k);

/** derive_ipa: onset IPA + the final's (or nucleus + coda) IPA. Never stored. null when a part is unknown. */
export function deriveIpa(syl: Syllable, pack: Pack): string | null {
  const parts: string[] = [];
  for (const k of keys(syl.onset)) {
    if (!own(pack.consonants, k)) return null;
    parts.push(pack.consonants[k].ipa as string);
  }
  if (pack.finals !== undefined && pack.finals !== null) {
    const fk = finalKey(syl);
    const f = fk !== null && own(pack.finals, fk) ? pack.finals[fk] : undefined;
    if (!f) return null;
    parts.push(f.ipa);
  } else {
    if (syl.nucleus !== undefined && syl.nucleus !== null) {
      if (!own(pack.vowels, syl.nucleus)) return null;
      parts.push(pack.vowels[syl.nucleus].ipa ?? '');
    }
    const codas = codasOf(pack);
    for (const k of keys(syl.coda)) {
      if (!own(codas, k)) return null;
      parts.push(codas[k].ipa as string);
    }
  }
  return parts.join('');
}

/** derived_tone: a tone number in one of the pack's toneSystems (Jyutping 'nine'). */
export function derivedTone(syl: Syllable, pack: Pack, system = 'nine'): string | undefined {
  const tone = syl.tone;
  const ts = (pack.toneSystems || {})[system];
  if (tone === undefined || tone === null || !ts) return tone;
  const coda = syl.coda;
  if (typeof coda === 'string' && ts.checkedCodas.includes(coda)) {
    return own(ts.checked, tone) ? ts.checked[tone] : tone;
  }
  return tone;
}

// ------------------------------------------------------------------ invariants
export type Violation = [code: string, location: string];

/** check_invariants -> sorted [code, location]. Codes in WARNINGS are warnings. */
export function checkInvariants(piece: PieceLike): Violation[] {
  const pack = packOf(piece);
  const codas = codasOf(pack);
  const v: Violation[] = [];
  piece.phraseGrid.forEach((track, k) => {
    const listOf = (ph: PhraseLike) => (Array.isArray(ph.syllables) ? ph.syllables : []);
    // Python truthiness of the raw value, as the reference's any(ph.get("syllables"))
    const truthy = (x: unknown) => Array.isArray(x) ? x.length > 0
      : (x && typeof x === 'object') ? Object.keys(x).length > 0 : !!x;
    const anySyl = track.some(ph => truthy(ph.syllables));
    const anchored = new Set<string>();
    track.forEach((ph, pi) => {
      if (ph.syllables !== undefined && ph.syllables !== null && !Array.isArray(ph.syllables)) {
        v.push(['syllable-malformed', `track ${k} phrase ${pi} syllables`]);
        return; // as the reference: nothing else is checked on this phrase
      }
      const idx = new Map<string, [number, TrajLike]>();
      row0(ph).forEach((t, i) => {
        const u = t.uniqueId;
        if (typeof u === 'string' && u) idx.set(u, [i, t]);
        else v.push(['traj-uid-missing', `track ${k} phrase ${pi} traj ${i}`]);
      });
      let last = -1;
      listOf(ph).forEach((s, si) => {
        const where = `track ${k} phrase ${pi} syllable ${si}`;
        if (!wellFormedSyllable(s)) { v.push(['syllable-malformed', where]); return; }
        const a = s.anchor;
        const hit = idx.get(a.traj);
        if (!hit) { v.push(['anchor-missing', where]); return; }
        const [i, t] = hit;
        if (silent(t)) v.push(['anchor-silence', where]);
        if (i <= last) v.push(['anchor-order', where]);
        last = i;
        anchored.add(a.traj);
        if ((a.t ?? 0) !== 0) v.push(['anchor-t', where]);
        for (const [f, table, flag] of [['onset', pack.consonants, 'onsetClusters'], ['coda', codas, 'codaClusters']] as const) {
          const x = s[f];
          if (Array.isArray(x) && !pack.flags[flag]) v.push(['cluster-not-allowed', where]);
          for (const key of keys(x)) if (!own(table, key)) v.push(['key-unknown', where]);
        }
        const nuc = s.nucleus ?? null;
        if (nuc !== null && !own(pack.vowels, nuc)) v.push(['key-unknown', where]);
        const lyricVowel = (s.lyric || ({} as any)).vowel ?? null;
        if (nuc !== lyricVowel) v.push(['nucleus-lyric-mismatch', where]);
        for (const obs of ['lyric', 'sung'] as const) {
          const ov = ((s[obs] || {}) as any).vowel ?? null;
          if (ov !== null && !own(pack.vowels, ov)) v.push(['key-unknown', where]);
        }
        if (s.tone !== undefined && s.tone !== null) {
          if (!pack.flags.tones) v.push(['tone-not-allowed', where]);
          else if (!own(pack.tones, s.tone)) v.push(['key-unknown', where]);
        }
        if (pack.finals !== undefined && pack.finals !== null) {
          const fk = finalKey(s);
          const f = fk !== null && own(pack.finals, fk) ? pack.finals[fk] : undefined;
          if (fk === null) { /* coda cluster: reported as cluster-not-allowed */ }
          else if (!f) v.push(['final-unknown', where]);
          else if (f.syllabic && !pack.flags.syllabicNasals) v.push(['syllabic-not-allowed', where]);
        } else if (nuc === null && !pack.flags.nucleusOptional) {
          v.push(['nucleus-missing', where]);
        }
      });
    });
    const instr = piece.instrumentation || [];
    if (anySyl && k < instr.length && !VOCAL_INSTRUMENTS.includes(instr[k])) {
      v.push(['track-not-vocal', `track ${k} (${instr[k]})`]);
    }
    if (anySyl) {
      let prevSilent = true; // the track start counts as a silence
      for (const [pi, ti, t] of trackFlat(track)) {
        if (!silent(t) && prevSilent && !anchored.has((t.uniqueId || null) as string)) {
          v.push(['unanchored-start', `track ${k} phrase ${pi} traj ${ti}`]);
        }
        prevSilent = silent(t);
      }
    }
  });
  return v.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** split_violations -> [error codes, warning codes], each sorted. */
export function splitViolations(found: Violation[]): [string[], string[]] {
  const codes = found.map(f => f[0]);
  return [codes.filter(c => !WARNINGS.has(c)), codes.filter(c => WARNINGS.has(c))];
}

// ------------------------------------------------------------------ write guard
function comparable(syls: Syllable[]) {
  return syls.map(s => {
    const c: any = { traj: s.anchor.traj, t: s.anchor.t ?? 0 };
    for (const f of ['onset', 'nucleus', 'coda'] as const) {
      if (s[f] !== undefined && s[f] !== null) c[f] = s[f];
    }
    c.vowel = (s.lyric || ({} as any)).vowel ?? null;
    return c;
  });
}

/** strip_syllables: what a pre-0.3.0 client's save leaves. */
export function stripSyllables<P extends PieceLike>(piece: P): P {
  const pc = clone(piece);
  for (const track of pc.phraseGrid) for (const ph of track) delete ph.syllables;
  return pc;
}

/**
 * legacy_safe (PROP-8 write guard), evaluated on the STORED piece. True when a
 * pre-0.3.0 client may save it. -> [safe, sorted reason codes].
 *
 * A phrase whose stored doc has no `syllables` key (or a stored null) is skipped
 * in the boundary check: an old client's save drops nothing there (contract PR #7,
 * case `untiered-legacy`).
 */
export function legacySafe(piece: PieceLike): [boolean, string[]] {
  const reasons = new Set<string>();
  let pack: Pack;
  try { pack = packOf(piece); } catch { return [false, ['pack']]; }
  // As the reference (contract 0.3.1): a tier the rules cannot read is refused
  // rather than let an old client drop it.
  if (checkInvariants(piece).some(([code]) => code === 'syllable-malformed')) return [false, ['unreadable']];
  if (pack.id !== LEGACY_PACK) reasons.add('pack');
  for (const track of piece.phraseGrid || []) {
    for (const ph of track) {
      const syls = ph.syllables;
      for (const s of (Array.isArray(syls) ? syls : [])) {
        for (const f of Object.keys(s)) if (!LEGACY_HOLDABLE.has(f)) reasons.add(f);
        if ((s.anchor.t ?? 0) !== 0) reasons.add('anchorT');
        for (const f of ['onset', 'coda'] as const) if (Array.isArray(s[f])) reasons.add('cluster');
        if (pack.id === LEGACY_PACK) {
          const checks: [unknown, { [k: string]: PackEntry }][] = [
            [s.onset, pack.consonants], [s.coda, codasOf(pack)],
            [s.nucleus, pack.vowels], [(s.lyric || ({} as any)).vowel, pack.vowels]];
          for (const [k, table] of checks) {
            if (typeof k === 'string' && own(table, k) && !('legacy' in table[k])) reasons.add('key');
          }
        }
      }
    }
  }
  if (reasons.size === 0) {
    // heal(strip(piece)) compared phrase by phrase, healing only the phrases that
    // are compared: equal to the reference, and a never-tiered phrase without
    // uniqueIds cannot make the check throw.
    piece.phraseGrid.forEach((track, k) => {
      if (!track.some(ph => Array.isArray(ph.syllables))) return;
      // a stored tier on a non-vocal track is not rebuilt by the heal, so an old
      // client's save would lose it
      if (!vocalTrack(piece, k)) { reasons.add('boundary'); return; }
      const phonetic = trackIsPhonetic(track);
      for (const ph of track) {
        const stored = ph.syllables;
        if (stored === undefined || stored === null) continue;
        const rebuilt = phonetic ? healPhrase(ph) : [];
        if (JSON.stringify(comparable(stored)) !== JSON.stringify(comparable(rebuilt))) {
          reasons.add('boundary');
        }
      }
    });
  }
  return [reasons.size === 0, [...reasons].sort()];
}

// ------------------------------------------------------------------ re-homing
/**
 * rehome over JSON pieces (the reference shape). The model re-homes through its
 * track pool instead (Piece.syncSyllables); this is kept for the harness and tests.
 */
export function rehome<P extends PieceLike>(before: PieceLike, after: P): [P, string[]] {
  const pc = clone(after);
  const dropped: string[] = [];
  pc.phraseGrid.forEach((track, k) => {
    const where = new Map<string, [number, number]>();
    for (const [pi, ti, t] of trackFlat(track)) where.set(uidOf(t), [pi, ti]);
    const old = before.phraseGrid[k] || [];
    const pool = old.flatMap(ph => ph.syllables || []);
    const buckets: [number, Syllable][][] = track.map(() => []);
    for (const s of pool) {
      const loc = where.get(s.anchor.traj);
      if (!loc) { dropped.push(s.anchor.traj); continue; }
      buckets[loc[0]].push([loc[1], s]);
    }
    track.forEach((ph, i) => {
      ph.syllables = buckets[i].sort((a, b) => a[0] - b[0]).map(x => x[1]);
    });
  });
  return [pc, dropped];
}

// ------------------------------------------------------------------ client header
/** Contract version this build implements; sent as `web/<version>` in X-IDTAP-Client. */
export const CONTRACT_VERSION = '0.3.1';
export const KNOWN_CLIENTS = ['web', 'python', 'swift'];

/**
 * Parse X-IDTAP-Client: `<client>/<contract-semver>` with client in
 * web|python|swift, or bare `web` (pre-0.3.0 tabs). -> null when absent or malformed.
 */
export function parseClientHeader(h: string | undefined | null): { client: string; version: string | null } | null {
  if (typeof h !== 'string') return null;
  const s = h.trim();
  if (s === 'web') return { client: 'web', version: null };
  const m = /^([a-z]+)\/(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m || !KNOWN_CLIENTS.includes(m[1])) return null;
  return { client: m[1], version: `${m[2]}.${m[3]}.${m[4]}` };
}

export function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}

/** True when the header names a client that implements contract >= 0.3.0 (the tier). */
export function clientKnowsSyllables(h: string | undefined | null): boolean {
  const p = parseClientHeader(h);
  return !!p && p.version !== null && !semverLt(p.version, '0.3.0');
}

// ------------------------------------------------------------------ tradition switch
/**
 * May a piece's system change to `next`? (Lyric mode's Edit Tradition, Jon's
 * provisional defaults of 2026-11-13.) Reads a stored document or a model piece.
 * - The same phonology (e.g. Hindustani by default -> explicit hindi-urdu, which
 *   turns the tier on) is always allowed: the legacy fields heal as usual.
 * - Any other phonology is refused while a vocal track carries legacy phonetic
 *   fields or a non-empty syllable tier: there is no conversion, and the new
 *   pack's empty projection would erase the Hindi vowels.
 * - Removing a system is not offered (one-way for now).
 */
export function systemChangeAllowed(piece: PieceLike, next: System | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    return { ok: false, reason: 'A tradition cannot be removed once set.' };
  }
  const nextPh = resolveSystem({ system: next }).phonology as string;
  if (!PACKS[nextPh]) return { ok: false, reason: `No phoneme pack '${nextPh}' in this version.` };
  for (const [k, v] of Object.entries(next)) {
    const okShape = typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string'));
    if (!okShape) return { ok: false, reason: `system.${k} must be a string or a list of strings.` };
  }
  const curPh = resolveSystem(piece).phonology as string;
  if (curPh === nextPh) return { ok: true };
  const grid = Array.isArray(piece.phraseGrid) ? piece.phraseGrid : [];
  let phonetic = false;
  grid.forEach((track, k) => {
    if (!Array.isArray(track) || !vocalTrack(piece, k)) return;
    for (const ph of track) {
      if (!ph || typeof ph !== 'object') continue;
      const syl = (ph as PhraseLike).syllables;
      if (syl !== undefined && syl !== null && (!Array.isArray(syl) || syl.length > 0)) phonetic = true;
      for (const t of row0(ph as PhraseLike)) if (t && hasPhonetics(t)) phonetic = true;
    }
  });
  if (phonetic) {
    return {
      ok: false,
      reason: `This piece already has ${curPh} vowels or syllables on a vocal track. Switching to ${nextPh} would erase them, so it is not allowed; there is no conversion between traditions.`,
    };
  }
  return { ok: true };
}
