/**
 * The picker's option lists (SPEC-provisional §5.2, §5.3), built from the
 * bundled packs: script, romanization, IPA and the pack's `hint` (contract
 * 0.3.1; every hint is 'proposed' until a speaker reviews it). Pure.
 */
import { Pack, PackEntry, codasOf } from '@shared/syllables';
import type { Slot } from './lyricController';

export interface PickerOption {
  /** pack key; null = the empty option (none / no vowel) */
  key: string | null;
  script: string;
  /** a second script line (Hindi vowel sign, Cantonese example romanization) */
  sub?: string;
  roman: string;
  ipa?: string;
  hint?: string;
  example?: string;
  unverified?: boolean;
  /** Cantonese tones: contour points, Chao text, nine-tone note */
  chao?: string;
  glyph?: string;
  nine?: string;
}
export interface PickerGroup { name?: string; options: PickerOption[] }

const MATRA: { [v: string]: string } = { 'ā': 'ा', i: 'ि', 'ī': 'ी', u: 'ु', 'ū': 'ू', 'ē': 'े', ai: 'ै', 'ō': 'ो', au: 'ौ' };
const HINDI_PLACE: { [p: string]: string } = {
  velar: 'Back of the mouth', palatal: 'Middle of the tongue', retroflex: 'Tongue tip curled back',
  dental: 'Tongue on the teeth', labial: 'Lips',
};
const HINDI_OTHERS = new Set(['ya', 'ra', 'la', 'va', 'śa', 'ṣa', 'sa', 'ha']);
const KURMANJI_EXTRA = new Set(['ç̱', 'ḥ', 'ḵ', 'p̱', 'ṯ', 'x̱', 'ʿ'].map(x => x.normalize('NFC')));

function exampleOf(e: PackEntry, pack: Pack, slot: Slot): string | undefined {
  if (pack.id === 'kurmanji' && slot === 'nucleus' && typeof e.example === 'string') return e.example;
  const ex = e.hint?.example;
  if (!ex) return undefined;
  const parts = [ex.text, ex.romanization, ex.gloss ? `‘${ex.gloss}’` : undefined].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function entryOption(pack: Pack, slot: Slot, key: string, e: PackEntry): PickerOption {
  const o: PickerOption = {
    key, roman: key, ipa: e.ipa, hint: e.hint?.en,
    unverified: e.hint ? e.hint.status === 'proposed' : undefined,
    example: exampleOf(e, pack, slot), script: key,
  };
  if (pack.id === 'hindi-urdu') {
    o.script = e.display?.Deva ?? key;
    if (slot === 'nucleus') o.sub = MATRA[key] ? '◌' + MATRA[key] : 'inherent';
    else o.roman = key.slice(0, -1);
  } else if (pack.id === 'jyutping') {
    const ex = e.hint?.example;
    o.script = ex?.text ?? '';
    o.sub = ex?.romanization;
  }
  return o;
}

/** Chao digits ("55", "25") as a 22×16 contour polyline. */
export function contourPoints(chao: string | undefined, w = 22, h = 16): string | undefined {
  if (!chao) return undefined;
  const d = String(chao).replace(/\D/g, '').split('').map(Number);
  if (!d.length) return undefined;
  const y = (l: number) => h - 1 - ((l - 1) * (h - 2)) / 4;
  if (d.length === 1) return `0,${y(d[0])} ${w},${y(d[0])}`;
  return d.map((l, i) => `${(i * w) / (d.length - 1)},${y(l)}`).join(' ');
}

/** The groups and options of one slot. `checked`: the syllable ends in p/t/k (Cantonese tones). */
export function optionsFor(pack: Pack, slot: Slot, checked = false): PickerGroup[] {
  const none = (label: string): PickerOption => ({ key: null, script: '', roman: label });
  if (slot === 'tone') {
    const tones = pack.tones || {};
    const ts = pack.toneSystems?.nine;
    return [{ options: Object.entries(tones).map(([k, t]: [string, any]) => {
      const chk = checked && ts && ts.checked[k];
      const chao = chk ? `${t.checkedChao} short` : (t.chaoAlt && t.chaoAlt !== t.chao ? `${t.chao} / ${t.chaoAlt}` : t.chao);
      const ex = chk ? t.hint?.checkedExample : t.hint?.example;
      return {
        key: k, roman: k, script: ex?.text ?? '', sub: ex?.romanization,
        chao, glyph: contourPoints(chk ? t.checkedChao : t.chao),
        nine: chk ? `= tone ${ts!.checked[k]}` : undefined,
        hint: t.hint?.en, unverified: t.hint ? t.hint.status === 'proposed' : undefined,
      } as PickerOption;
    }) }];
  }
  if (slot === 'nucleus') {
    const opts = Object.entries(pack.vowels).filter(([k]) => k !== '_').map(([k, e]) => entryOption(pack, slot, k, e));
    const allowNone = pack.flags.nucleusOptional || pack.id === 'jyutping';
    return [{ options: allowNone ? [{ ...none('no vowel'), hint: pack.id === 'jyutping' ? 'a hummed m or ng (唔 m4): clears the onset' : 'a consonant on its own' }, ...opts] : opts }];
  }
  const table = slot === 'onset' ? pack.consonants : codasOf(pack);
  const entries = Object.entries(table);
  const lead = none('none');
  if (pack.id === 'hindi-urdu') {
    const order = ['Back of the mouth', 'Middle of the tongue', 'Tongue tip curled back', 'Tongue on the teeth', 'Lips', 'Others'];
    const groups: { [g: string]: PickerOption[] } = {};
    for (const [k, e] of entries) {
      const g = HINDI_OTHERS.has(k) ? 'Others' : (HINDI_PLACE[e.place] ?? 'Others');
      (groups[g] ||= []).push(entryOption(pack, slot, k, e));
    }
    return [{ options: [lead] }, ...order.filter(g => groups[g]).map(name => ({ name, options: groups[name] }))];
  }
  if (pack.id === 'jyutping' && slot === 'coda') {
    const stops = ['p', 't', 'k'];
    return [
      { options: [lead] },
      { name: 'Glides and nasals', options: entries.filter(([k]) => !stops.includes(k)).map(([k, e]) => entryOption(pack, slot, k, e)) },
      { name: 'Stopped (checked) endings', options: entries.filter(([k]) => stops.includes(k)).map(([k, e]) => entryOption(pack, slot, k, e)) },
    ];
  }
  if (pack.id === 'kurmanji') {
    const main = entries.filter(([k]) => !KURMANJI_EXTRA.has(k.normalize('NFC')));
    const extra = entries.filter(([k]) => KURMANJI_EXTRA.has(k.normalize('NFC')));
    return [
      { options: [lead, ...main.map(([k, e]) => entryOption(pack, slot, k, e))] },
      { name: "Thackston's extra letters (not all speakers)", options: extra.map(([k, e]) => entryOption(pack, slot, k, e)) },
    ];
  }
  return [{ options: [lead, ...entries.map(([k, e]) => entryOption(pack, slot, k, e))] }];
}

/** ` cycles the letter before the caret (spec §6.5). */
const CYCLES: { [pack: string]: string[][] } = {
  'hindi-urdu': ['aā', 'iī', 'uū', 'eē', 'oō', 'tṭ', 'dḍ', 'nṇñṅ', 'sśṣ'].map(x => Array.from(x)),
  kurmanji: [['e', 'ê'], ['i', 'î'], ['u', 'û'], ['c', 'ç', 'ç̱'], ['s', 'ş'], ['h', 'ḥ'], ['x', 'x̱'], ['k', 'ḵ'], ['p', 'p̱'], ['t', 'ṯ']]
    .map(c => c.map(x => x.normalize('NFC'))),
  jyutping: [],
};
export const PALETTE: { [pack: string]: string[] } = {
  'hindi-urdu': ['ā', 'ī', 'ū', 'ē', 'ō', 'ṭ', 'ḍ', 'ṇ', 'ñ', 'ṅ', 'ś', 'ṣ'],
  kurmanji: ['ê', 'î', 'û', 'ç', 'ş', 'ḥ', 'ḵ', 'p̱', 'ṯ', 'x̱', 'ç̱', 'ʿ'].map(x => x.normalize('NFC')),
  jyutping: ['1', '2', '3', '4', '5', '6'],
};

/** Replace the letter before `caret` with the next in its cycle. -> new text and caret, or null. */
export function cycleBeforeCaret(packId: string, text: string, caret: number): { text: string; caret: number } | null {
  const before = Array.from(text.slice(0, caret).normalize('NFC'));
  if (!before.length) return null;
  // a combining macron below belongs to its letter
  let last = before.pop()!;
  if (/[̀-ͯ]/.test(last) && before.length) last = before.pop()! + last;
  last = last.normalize('NFC');
  for (const c of CYCLES[packId] || []) {
    const i = c.indexOf(last);
    if (i >= 0) {
      const head = before.join('') + c[(i + 1) % c.length];
      return { text: head + text.slice(caret), caret: head.length };
    }
  }
  return null;
}
