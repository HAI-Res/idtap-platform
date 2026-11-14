/**
 * Typed text <-> syllable keys, per phoneme pack (lyric mode).
 *
 * Ported from the syllable-entry v2 prototype (syllable-ui-design), rewritten
 * against the bundled packs instead of the prototype's own tables. Keys are the
 * source of truth: romanization is regenerated from them (romanizationOf);
 * orthography is whatever the person typed, and is only DERIVED for display
 * (devanagariOf) when nothing was typed.
 *
 * Pure functions: no model objects, no DOM.
 */
import { Pack, PACKS, PhonemeKey, Syllable, codasOf } from './syllables';

export interface SyllableParts {
  onset?: PhonemeKey;
  nucleus?: string;
  coda?: PhonemeKey;
  tone?: string;
  /** typed script (Devanagari, a Han character, Kurmanji spelling); kept as typed */
  orthography?: string;
  wordStart?: boolean;
}

export interface ParseNote { code: string; msg: string }

export interface ParsedSyllable {
  parts: SyllableParts;
  /** problems with the text: the same codes as the invariants where one applies */
  errors: ParseNote[];
  /** information only (a dropped nukta, a pairing note) */
  notes: ParseNote[];
}

const arr = (x: PhonemeKey | undefined): string[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const keyOrCluster = (keys: string[]): PhonemeKey | undefined =>
  keys.length === 0 ? undefined : keys.length === 1 ? keys[0] : keys;

// ---------------------------------------------------------------- hindi-urdu
// Pack consonant keys carry the inherent a (ka, kha, ṇa); the letter is the key
// without it. Longest first, so kha wins over ka.
const HINDI = () => PACKS['hindi-urdu'];
const hindiLetter = (key: string) => key.slice(0, -1);

function hindiTables() {
  const P = HINDI();
  const cons = Object.keys(P.consonants).map(k => [hindiLetter(k), k] as [string, string])
    .sort((a, b) => b[0].length - a[0].length);
  // vowels: pack keys, plus plain e/o for the long ones (typed without macron)
  const vows: [string, string][] = Object.keys(P.vowels).filter(k => k !== '_').map(k => [k, k] as [string, string]);
  vows.push(['e', 'ē'], ['o', 'ō']);
  vows.sort((a, b) => b[0].length - a[0].length);
  return { cons, vows };
}

/**
 * Devanagari vowel signs. The pack has none (it lists independent vowels and
 * consonants only; contract open question "the hindi-urdu pack can't spell
 * Devanagari syllables"), so they are here, used for DISPLAY and for reading
 * typed Devanagari only, never stored.
 */
const MATRA: { [vowel: string]: string } = {
  a: '', 'ā': 'ा', i: 'ि', 'ī': 'ी', u: 'ु', 'ū': 'ू', 'ē': 'े', ai: 'ै', 'ō': 'ो', au: 'ौ',
};
const VIRAMA = '्';
const NUKTA = '़';
const isDeva = (s: string) => /[ऀ-ॿ]/.test(s);

function devaToIso(word: string, notes: ParseNote[]): string {
  const P = HINDI();
  const devC: { [d: string]: string } = {};
  for (const [k, e] of Object.entries(P.consonants)) {
    const d = e.display?.Deva;
    if (d && devC[d] === undefined) devC[d] = hindiLetter(k);
  }
  const devV: { [d: string]: string } = {};
  for (const [k, e] of Object.entries(P.vowels)) if (e.display?.Deva && k !== '_') devV[e.display.Deva] = k;
  const devM: { [m: string]: string } = {};
  for (const [k, m] of Object.entries(MATRA)) if (m) devM[m] = k;
  const ch = Array.from(word);
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    if (devC[c] !== undefined) {
      out += devC[c];
      let j = i + 1;
      if (ch[j] === NUKTA) { notes.push({ code: 'nukta-dropped', msg: 'nukta dropped: the pack has no क़ ज़ फ़ keys' }); j++; }
      if (devM[ch[j]] !== undefined) { out += devM[ch[j]]; i = j; }
      else if (ch[j] === VIRAMA) { i = j; }
      else { i = j - 1; out += 'a'; }
    } else if (devV[c] !== undefined) out += devV[c];
    else if (c === 'ं' || c === 'ँ') notes.push({ code: 'nasal-dropped', msg: 'nasalisation dropped: the pack has no anusvāra or candrabindu' });
    else notes.push({ code: 'not-read', msg: `“${c}” not read` });
  }
  return out;
}

/** Devanagari for display, derived from the keys (never stored). */
export function devanagariOf(syl: Pick<Syllable, 'onset' | 'nucleus' | 'coda'>): string {
  const P = HINDI();
  const cd = (k: string) => P.consonants[k]?.display?.Deva ?? '?';
  const on = arr(syl.onset), co = arr(syl.coda);
  let s = '';
  if (on.length) {
    s += on.map(cd).join(VIRAMA);
    s += syl.nucleus ? (MATRA[syl.nucleus] ?? '') : VIRAMA;
  } else if (syl.nucleus) {
    s += P.vowels[syl.nucleus]?.display?.Deva ?? '?';
  }
  s += co.map(cd).join(VIRAMA);
  return s;
}

// ---------------------------------------------------------------- tokens
type Tok = { t: 'C' | 'V'; key: string; txt: string } | { t: 'B' };

/** Split text into graphemes, keeping combining marks (ç̱, ḵ) on their letter. */
function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const cp of Array.from(s.normalize('NFD'))) {
    if (/[̀-ͯ]/.test(cp) && out.length) out[out.length - 1] += cp;
    else out.push(cp);
  }
  return out.map(x => x.normalize('NFC'));
}

function tokensOf(packId: string, word: string, errors: ParseNote[]): Tok[] {
  const out: Tok[] = [];
  if (packId === 'hindi-urdu') {
    const { cons, vows } = hindiTables();
    let i = 0;
    while (i < word.length) {
      const c = word[i];
      if ('·.'.includes(c)) { out.push({ t: 'B' }); i++; continue; }
      let m: { t: 'C' | 'V'; key: string; txt: string; len: number } | null = null;
      for (const [v, key] of vows) if (word.startsWith(v, i)) { m = { t: 'V', key, txt: key, len: v.length }; break; }
      if (!m) for (const [l, key] of cons) if (word.startsWith(l, i)) { m = { t: 'C', key, txt: l, len: l.length }; break; }
      if (!m) { errors.push({ code: 'key-unknown', msg: `“${c}” is not a hindi-urdu letter` }); i++; continue; }
      out.push({ t: m.t, key: m.key, txt: m.txt });
      i += m.len;
    }
    return out;
  }
  // kurmanji: pack keys are the letters (and rr)
  const P = PACKS[packId];
  const vowels = new Set(Object.keys(P.vowels).map(k => k.normalize('NFC')));
  const consonants = new Set(Object.keys(P.consonants).map(k => k.normalize('NFC')));
  const g = graphemes(word);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if ('·.'.includes(c)) { out.push({ t: 'B' }); continue; }
    if (c === 'r' && g[i + 1] === 'r' && consonants.has('rr')) { out.push({ t: 'C', key: 'rr', txt: 'rr' }); i++; continue; }
    if (vowels.has(c)) out.push({ t: 'V', key: c, txt: c });
    else if (consonants.has(c)) out.push({ t: 'C', key: c, txt: c });
    else errors.push({ code: 'key-unknown', msg: `“${c}” is not a ${packId} letter` });
  }
  return out;
}

/** Tokens -> syllables: one vowel each; between two vowels one consonant goes to the onset (Kurmanji keeps xw together). */
function sylsFromTokens(packId: string, toks: Tok[]) {
  const chunks: Exclude<Tok, { t: 'B' }>[][] = [[]];
  toks.forEach(t => (t.t === 'B' ? chunks.push([]) : chunks[chunks.length - 1].push(t)));
  const res: { on: string[]; nu?: string; co: string[]; txt: string }[] = [];
  for (const ch of chunks) {
    if (!ch.length) continue;
    const vi = ch.map((t, i) => (t.t === 'V' ? i : -1)).filter(i => i >= 0);
    if (!vi.length) { res.push({ on: ch.map(t => t.key), co: [], txt: ch.map(t => t.txt).join('') }); continue; }
    const sy = vi.map(i => ({ on: [] as typeof ch, nu: ch[i], co: [] as typeof ch }));
    sy[0].on = ch.slice(0, vi[0]);
    for (let n = 0; n < vi.length - 1; n++) {
      const cs = ch.slice(vi[n] + 1, vi[n + 1]);
      if (cs.length <= 1) { sy[n + 1].on = cs; continue; }
      // as the prototype: the first consonant closes the syllable, the rest open
      // the next one; Kurmanji keeps a final xw together as the next onset
      let cut = 1;
      if (packId === 'kurmanji' && cs[cs.length - 2].key === 'x' && cs[cs.length - 1].key === 'w') cut = cs.length - 2;
      if (cut < 1 && !(packId === 'kurmanji' && cs.length === 2)) cut = 1;
      sy[n].co = cs.slice(0, cut);
      sy[n + 1].on = cs.slice(cut);
    }
    sy[sy.length - 1].co = ch.slice(vi[vi.length - 1] + 1);
    for (const s of sy) {
      res.push({
        on: s.on.map(t => t.key), nu: s.nu.key, co: s.co.map(t => t.key),
        txt: s.on.map(t => t.txt).join('') + s.nu.txt + s.co.map(t => t.txt).join(''),
      });
    }
  }
  return res;
}

// ---------------------------------------------------------------- jyutping
const JYUTPING_ONSETS = ['gw', 'kw', 'ng', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'w', 'z', 'c', 's', 'j'];

function parseJyutping(tok: string): ParsedSyllable {
  const P = PACKS.jyutping;
  const errors: ParseNote[] = [], notes: ParseNote[] = [];
  const m = /^([a-z]+?)([1-6])?$/.exec(tok);
  if (!m) return { parts: {}, errors: [{ code: 'key-unknown', msg: `“${tok}” is not Jyutping` }], notes };
  const body = m[1];
  const parts: SyllableParts = {};
  if (m[2]) parts.tone = m[2];
  else notes.push({ code: 'tone-missing', msg: 'no tone digit' });
  const finals = P.finals || {};
  let onset = '';
  if (!(finals[body] && finals[body].syllabic)) {
    for (const c of JYUTPING_ONSETS) if (body.startsWith(c) && body.length > c.length) { onset = c; break; }
  }
  const fin = body.slice(onset.length);
  const F = finals[fin];
  if (!F) return { parts, errors: [{ code: 'final-unknown', msg: `“${fin}” is not one of the pack's finals` }], notes };
  if (onset) parts.onset = onset;
  if (F.nucleus) parts.nucleus = F.nucleus;
  if (F.coda) parts.coda = F.coda;
  return { parts, errors, notes };
}

// ---------------------------------------------------------------- public
/**
 * Parse typed text into syllables for a pack. Hindi accepts ISO (bā, kha) or
 * Devanagari (बा); Jyutping accepts romanization with tone digits (si1) and Han
 * characters, paired in order; Kurmanji accepts its Latin spelling. A space,
 * hyphen, · or . separates syllables; within a word, syllables are found by
 * vowels.
 */
export function parseSyllableText(pack: Pack, text: string): ParsedSyllable[] {
  text = text.normalize('NFC').trim();
  if (!text) return [];
  if (pack.id === 'jyutping') {
    const han = Array.from(text.matchAll(/\p{Script=Han}/gu)).map(x => x[0]);
    const words = text.replace(/\p{Script=Han}/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);
    const out: ParsedSyllable[] = [];
    for (const w of words) {
      const toks = w.match(/[a-z]+[1-6]?/g) || [w];
      toks.forEach((t, i) => {
        const p = parseJyutping(t);
        if (i === 0) p.parts.wordStart = true;
        out.push(p);
      });
    }
    if (!out.length && han.length) {
      return han.map(h => ({ parts: { orthography: h, wordStart: true }, errors: [{ code: 'needs-romanization', msg: 'a character without Jyutping' }], notes: [] }));
    }
    out.forEach((o, i) => { if (han[i]) o.parts.orthography = han[i]; });
    if (han.length && han.length !== out.length) {
      out.forEach(o => o.notes.push({ code: 'pairing', msg: `${han.length} characters for ${out.length} syllables; paired in order` }));
    }
    return out;
  }
  const out: ParsedSyllable[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    word.split('-').filter(Boolean).forEach((part, pi) => {
      const errors: ParseNote[] = [], notes: ParseNote[] = [];
      let w = part;
      let typedScript: string | undefined;
      if (pack.id === 'hindi-urdu' && isDeva(w)) { typedScript = w; w = devaToIso(w, notes); }
      if (pack.id !== 'hindi-urdu') { typedScript = part; w = w.toLowerCase(); }
      const syls = sylsFromTokens(pack.id, tokensOf(pack.id, w, errors));
      syls.forEach((s, i) => {
        const parts: SyllableParts = {
          onset: keyOrCluster(s.on), nucleus: s.nu, coda: keyOrCluster(s.co),
        };
        if (pi === 0 && i === 0) parts.wordStart = true;
        // the typed spelling is kept only when it is one syllable
        if (typedScript && syls.length === 1) parts.orthography = typedScript;
        const errs = [...errors];
        if (!s.nu && !pack.flags.nucleusOptional) errs.push({ code: 'nucleus-missing', msg: 'no vowel' });
        if ((s.on.length > 1 && !pack.flags.onsetClusters) || (s.co.length > 1 && !pack.flags.codaClusters)) {
          errs.push({ code: 'cluster-not-allowed', msg: `${pack.id} allows no clusters` });
        }
        out.push({ parts, errors: errs, notes: [...notes] });
      });
    });
  }
  return out;
}

/** Romanization regenerated from the keys (keys are the source of truth). */
export function romanizationOf(pack: Pack, syl: Pick<Syllable, 'onset' | 'nucleus' | 'coda' | 'tone'>): string | undefined {
  if (pack.id === 'jyutping') {
    const fk = (syl.nucleus || '') + (typeof syl.coda === 'string' ? syl.coda : '');
    if (!pack.finals || !pack.finals[fk] || Array.isArray(syl.coda)) return undefined;
    return (typeof syl.onset === 'string' ? syl.onset : '') + fk + (syl.tone || '');
  }
  if (pack.id === 'hindi-urdu') {
    const c = (x: PhonemeKey | undefined) => arr(x).map(hindiLetter).join('');
    const nu = syl.nucleus && syl.nucleus !== '_' ? syl.nucleus : '';
    const r = c(syl.onset) + nu + c(syl.coda);
    return r || undefined;
  }
  const r = arr(syl.onset).join('') + (syl.nucleus || '') + arr(syl.coda).join('');
  return r || undefined;
}

/** The key tables a picker offers per slot, from the pack. */
export function slotOptions(pack: Pack, slot: 'onset' | 'nucleus' | 'coda' | 'tone'): string[] {
  if (slot === 'onset') return Object.keys(pack.consonants);
  if (slot === 'nucleus') return Object.keys(pack.vowels).filter(k => k !== '_');
  if (slot === 'coda') return Object.keys(codasOf(pack));
  return Object.keys(pack.tones || {});
}
