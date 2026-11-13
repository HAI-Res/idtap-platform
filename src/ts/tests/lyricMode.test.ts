/**
 * Lyric mode, model level (SPEC-provisional §6, §8, §13, §15): the editing
 * operations on Piece and the text parsing in shared/syllableText.ts.
 */
import { describe, it, expect } from 'vitest';
import { Piece } from '../model';
import { PACKS, derivedTone, systemChangeAllowed, checkInvariants, splitViolations } from '@shared/syllables';
import { parseSyllableText, romanizationOf, devanagariOf } from '@shared/syllableText';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const T = (uid: string, extra: any = {}) => ({
  id: 0, durTot: 0.5, durArray: [1], slope: 2, articulations: {}, uniqueId: uid,
  pitches: [{ swara: 0, raised: true, oct: 0, logOffset: 0 }], ...extra,
});
const S = (uid: string) => ({ id: 12, durTot: 0.5, durArray: [1], articulations: {}, uniqueId: uid, pitches: [] });

/** One vocal track, phrases of the given trajectories. */
function piece(phonology: string, phrases: any[][], extra: any = {}) {
  return Piece.fromJSON(clone({
    title: 'lyric mode test', instrumentation: ['Vocal (F)'], system: { phonology },
    durTot: phrases.flat().length * 0.5,
    phraseGrid: [phrases.map((trajs, i) => ({ uniqueId: `p${i}`, durTot: trajs.length * 0.5, trajectoryGrid: [trajs] }))],
    ...extra,
  }));
}
const save = (p: Piece) => JSON.parse(JSON.stringify(p));
const tier = (p: Piece) => p.syllableSpans(0).map(x => ({
  anchor: x.syllable.anchor.traj, n: x.trajs.length, r: x.syllable.romanization ?? null,
}));

describe('text parsing (spec §6.2)', () => {
  it('Hindi: ISO, plain e/o, Devanagari kept as orthography', () => {
    const P = PACKS['hindi-urdu'];
    expect(parseSyllableText(P, 'bā')[0].parts).toMatchObject({ onset: 'ba', nucleus: 'ā' });
    expect(parseSyllableText(P, 'kher')[0].parts).toMatchObject({ onset: 'kha', nucleus: 'ē', coda: 'ra' });
    const d = parseSyllableText(P, 'बा');
    expect(d).toHaveLength(1);
    expect(d[0].parts).toMatchObject({ onset: 'ba', nucleus: 'ā', orthography: 'बा' });
    expect(parseSyllableText(P, 'kamal').map(x => romanizationOf(P, x.parts))).toEqual(['ka', 'mal']); // one consonant between vowels opens the next syllable
    expect(parseSyllableText(P, 'q')[0]?.errors.map(e => e.code) ?? ['key-unknown']).toContain('key-unknown');
    expect(devanagariOf({ onset: 'ba', nucleus: 'ā' })).toBe('बा');
  });

  it('Cantonese: Jyutping with tone digit, syllabic m, characters paired in order', () => {
    const P = PACKS.jyutping;
    expect(parseSyllableText(P, 'si1')[0].parts).toEqual({ onset: 's', nucleus: 'i', tone: '1', wordStart: true });
    expect(parseSyllableText(P, 'sik6')[0].parts).toMatchObject({ onset: 's', nucleus: 'i', coda: 'k', tone: '6' });
    expect(parseSyllableText(P, 'm4')[0].parts).toEqual({ coda: 'm', tone: '4', wordStart: true });
    expect(parseSyllableText(P, 'sii1')[0].errors.map(e => e.code)).toEqual(['final-unknown']);
    expect(parseSyllableText(P, '詩 si1')[0].parts.orthography).toBe('詩');
  });

  it('Kurmanji: Latin as spelled, rr one key, xw a cluster, NFC lookup of ḵ', () => {
    const P = PACKS.kurmanji;
    expect(parseSyllableText(P, 'her')[0].parts).toMatchObject({ onset: 'h', nucleus: 'e', coda: 'r' });
    expect(parseSyllableText(P, 'xwe')[0].parts).toMatchObject({ onset: ['x', 'w'], nucleus: 'e' });
    expect(parseSyllableText(P, 'barr')[0].parts).toMatchObject({ coda: 'rr' });
    // typed decomposed (k + U+0331) finds the pack's NFC key
    expect(parseSyllableText(P, 'ḵa')[0].parts.onset).toBe('ḵ');
    expect(parseSyllableText(P, 'wayê').map(x => romanizationOf(P, x.parts))).toEqual(['wa', 'yê']);
  });
});

describe('create over a run (spec §8.1, acceptance 3-6)', () => {
  it('Kurmanji: h e r over notes 1-5; wordStart; source human; the extent runs on past the run', () => {
    const p = piece('kurmanji', [[T('n1'), T('n2'), T('n3'), T('n4'), T('n5'), T('n6')]]);
    const r = p.setSyllableOnRun(0, 'n1', 'n5', { onset: 'h', nucleus: 'e', coda: 'r' });
    expect(r.ok).toBe(true);
    const syl = (r as any).syllable;
    expect(syl).toMatchObject({
      anchor: { traj: 'n1', t: 0 }, onset: 'h', nucleus: 'e', coda: 'r', wordStart: true,
      romanization: 'her', orthography: 'her', lyric: { vowel: 'e', source: 'human' },
    });
    // nothing starts at n6, so the extent holds on (the lane hatches it)
    expect(tier(p)).toEqual([{ anchor: 'n1', n: 6, r: 'her' }]);
    const out = save(p);
    expect(out.phraseGrid[0][0].syllables).toHaveLength(1);
    // non-Hindi packs project nothing
    expect(out.phraseGrid[0][0].trajectoryGrid[0][0].vowel).toBeUndefined();
  });

  it('Kurmanji cluster: onset [x, w] + e -> romanization xwe (acceptance 4)', () => {
    const p = piece('kurmanji', [[T('n1')]]);
    const r: any = p.setSyllableOnRun(0, 'n1', 'n1', { onset: ['x', 'w'], nucleus: 'e' });
    expect(r.syllable).toMatchObject({ onset: ['x', 'w'], romanization: 'xwe' });
  });

  it('Cantonese sik6: romanization from the keys, tone stored as 6, nine-tone 9 derived (acceptance 5)', () => {
    const p = piece('jyutping', [[T('n1'), T('n2')]]);
    const r: any = p.setSyllableOnRun(0, 'n1', 'n2', { onset: 's', nucleus: 'i' });
    p.setSyllableParts(0, r.syllable, { onset: 's', nucleus: 'i', coda: 'k', tone: '6' });
    expect(r.syllable).toMatchObject({ romanization: 'sik6', tone: '6' });
    expect(derivedTone(r.syllable, PACKS.jyutping)).toBe('9');
  });

  it('Cantonese no vowel: m4 has lyric.vowel null (acceptance 6)', () => {
    const p = piece('jyutping', [[T('n1')]]);
    const r: any = p.setSyllableOnRun(0, 'n1', 'n1', { coda: 'm', tone: '4' });
    expect(r.syllable).toMatchObject({ coda: 'm', romanization: 'm4', lyric: { vowel: null, source: 'human' } });
    expect(r.syllable.nucleus).toBeUndefined();
  });

  it('replaces the syllables that start in the run; one that ran past keeps its text, re-anchored after the run', () => {
    const p = piece('kurmanji', [[T('n1'), T('n2'), T('n3'), T('n4')]]);
    const a: any = p.setSyllableOnRun(0, 'n1', 'n1', { onset: 'b', nucleus: 'a' });
    const b: any = p.setSyllableOnRun(0, 'n2', 'n4', { onset: 'd', nucleus: 'i' });
    expect(p.syllablesStartingInRun(0, 'n1', 'n2')).toEqual([a.syllable, b.syllable]);
    p.setSyllableOnRun(0, 'n1', 'n2', { onset: 'h', nucleus: 'e' });
    expect(tier(p)).toEqual([{ anchor: 'n1', n: 2, r: 'he' }, { anchor: 'n3', n: 2, r: 'di' }]);
  });

  it('stops at a silence and says so; a run of only silence is refused', () => {
    const p = piece('kurmanji', [[T('n1'), S('s'), T('n3')]]);
    const r: any = p.setSyllableOnRun(0, 'n1', 'n3', { nucleus: 'a' });
    expect(r.warning).toBe('“a” stops at the silence at note 2.');
    expect(p.setSyllableOnRun(0, 's', 's', {})).toEqual({ ok: false, reason: 'A syllable cannot start on a silence.' });
  });

  it('crosses a phrase line and re-homes on save', () => {
    const p = piece('kurmanji', [[T('n1'), T('n2')], [T('n3')]]);
    p.setSyllableOnRun(0, 'n2', 'n3', { nucleus: 'a' });
    const out = save(p);
    expect(out.phraseGrid[0][0].syllables.map((x: any) => x.anchor.traj)).toEqual(['n2']);
    expect(out.phraseGrid[0][1].syllables).toEqual([]);
  });

  it('Hindi: typed Devanagari is kept; a pick that changes the keys clears it and says so', () => {
    const p = piece('hindi-urdu', [[T('n1')]]);
    const r: any = p.setSyllableOnRun(0, 'n1', 'n1', { onset: 'ba', nucleus: 'ā', orthography: 'बा' });
    expect(r.syllable.orthography).toBe('बा');
    const c: any = p.setSyllableParts(0, r.syllable, { onset: 'ba', nucleus: 'ī' });
    expect(r.syllable.orthography).toBeUndefined();
    expect(c.warning).toMatch(/Devanagari/);
    // the Hindi tier dual-writes the legacy fields
    expect(save(p).phraseGrid[0][0].trajectoryGrid[0][0]).toMatchObject({ vowel: 'ī', startConsonant: 'ba' });
  });

  it('is refused without a system, on a non-vocal track, and in a frozen phrase', () => {
    const none = Piece.fromJSON(clone({ title: 'x', instrumentation: ['Vocal (F)'], durTot: 0.5,
      phraseGrid: [[{ uniqueId: 'p0', durTot: 0.5, trajectoryGrid: [[T('n1')]] }]] }));
    expect(none.setSyllableOnRun(0, 'n1', 'n1', {}).ok).toBe(false);
    const sitar = piece('kurmanji', [[T('n1')]], { instrumentation: ['Sitar'] });
    expect(sitar.setSyllableOnRun(0, 'n1', 'n1', {})).toEqual({ ok: false, reason: 'Syllables go on vocal tracks only.' });
    const frozen = Piece.fromJSON(clone({ title: 'x', instrumentation: ['Vocal (F)'], durTot: 0.5, system: { phonology: 'kurmanji' },
      phraseGrid: [[{ uniqueId: 'p0', durTot: 0.5, trajectoryGrid: [[T('n1')]],
        syllables: [{ anchor: { traj: 'gone', t: 0 }, nucleus: 'a', lyric: { vowel: 'a', source: 'human' } }] }]] }));
    expect(frozen.frozenSyllablePhraseUids.size).toBe(1);
    expect(frozen.setSyllableOnRun(0, 'n1', 'n1', {}).ok).toBe(false);
    expect(frozen.syllableSpans(0).every(x => x.frozen)).toBe(true);
  });
});

describe('move, split, merge (spec §8.2-8.5, acceptance 8-11)', () => {
  const three = () => {
    const p = piece('kurmanji', [[S('s0'), T('n1'), T('n2'), T('n3'), T('n4'), T('n5'), T('n6')]]);
    const a: any = p.setSyllableOnRun(0, 'n1', 'n3', { nucleus: 'a' });
    const b: any = p.setSyllableOnRun(0, 'n4', 'n6', { nucleus: 'e' });
    return { p, a: a.syllable, b: b.syllable };
  };

  it('Shift+→ on the first syllable after a silence is refused (unanchored-start)', () => {
    const { p, a } = three();
    expect(p.moveSyllableStart(0, a, 1)).toEqual({ ok: false,
      reason: 'The first note after a silence must start a syllable (unanchored-start), so this start cannot move right.' });
  });

  it('moves a start; refuses onto a neighbour and back across a silence', () => {
    const { p, a, b } = three();
    expect(p.moveSyllableStart(0, b, -1).ok).toBe(true);
    expect(tier(p)).toEqual([{ anchor: 'n1', n: 2, r: 'a' }, { anchor: 'n3', n: 4, r: 'e' }]);
    expect(p.moveSyllableStart(0, b, -1).ok).toBe(true); // a shrinks to one note
    expect(p.moveSyllableStart(0, b, -1)).toEqual({ ok: false, reason: 'That note already starts “a”.' });
    expect(p.moveSyllableStart(0, a, -1)).toEqual({ ok: false, reason: 'A syllable cannot reach back across a silence.' });
  });

  it('/ selects the second half as a run and changes nothing; a one-note syllable is refused', () => {
    const p = piece('kurmanji', [[T('n1'), T('n2'), T('n3'), T('n4'), T('n5'), T('n6')], [S('s'), T('m1')]]);
    const a: any = p.setSyllableOnRun(0, 'n1', 'n6', { nucleus: 'a' });
    const before = JSON.stringify(save(p));
    expect(p.splitRunFor(0, a.syllable)).toEqual({ ok: true, firstUid: 'n4', lastUid: 'n6' });
    expect(p.splitRunFor(0, a.syllable, 'n2')).toEqual({ ok: true, firstUid: 'n2', lastUid: 'n6' });
    expect(JSON.stringify(save(p))).toBe(before);
    const one: any = p.setSyllableOnRun(0, 'm1', 'm1', { nucleus: 'e' });
    expect(p.splitRunFor(0, one.syllable)).toEqual({ ok: false, reason: 'A one-note syllable cannot be split. Use split note here.' });
  });

  it('merge removes the syllable into the previous one; refused after a silence', () => {
    const { p, a, b } = three();
    expect(p.mergeSyllableIntoPrevious(0, a)).toEqual({ ok: false,
      reason: 'This syllable follows a silence, so it has no previous syllable to join (unanchored-start).' });
    const r: any = p.mergeSyllableIntoPrevious(0, b);
    expect(r.syllable).toBe(a);
    expect(tier(p)).toEqual([{ anchor: 'n1', n: 6, r: 'a' }]);
  });

  it('split note here: a held note splits in two, the syllable anchors on the second part at t 0 (acceptance 9)', () => {
    const { p, b } = three();
    const r = p.splitNoteHere(0, b, 'n3', 0.5);
    expect(r.ok).toBe(true);
    const row = p.phraseGrid[0][0].trajectoryGrid[0];
    expect(row.map(t => t.uniqueId).slice(0, 4)).toEqual(['s0', 'n1', 'n2', 'n3']);
    const second = row[4];
    expect(second.durTot).toBeCloseTo(0.25);
    expect(row[3].durTot).toBeCloseTo(0.25);
    expect(b.anchor).toEqual({ traj: second.uniqueId, t: 0 });
    const [errors] = splitViolations(checkInvariants(save(p)));
    expect(errors).toEqual([]);
  });

  it('split note here refuses a glide', () => {
    const p = piece('kurmanji', [[T('n1'), T('g', { id: 1, pitches: [{ swara: 0, raised: true, oct: 0 }, { swara: 1, raised: true, oct: 0 }] })]]);
    const r: any = p.setSyllableOnRun(0, 'n1', 'g', { nucleus: 'a' });
    expect(p.splitNoteHere(0, r.syllable, 'g', 0.5).ok).toBe(false);
  });
});

describe('Edit Tradition rule (spec §3, Q1/Q2)', () => {
  const doc = (vowel?: string, extra: any = {}) => ({
    instrumentation: ['Vocal (F)'],
    phraseGrid: [[{ trajectoryGrid: [[{ id: 0, uniqueId: 'a', ...(vowel ? { vowel } : {}) }]] }]], ...extra,
  });
  it('no system -> hindi-urdu always; -> jyutping/kurmanji only without Hindi phonetics', () => {
    expect(systemChangeAllowed(doc('ā'), { phonology: 'hindi-urdu' })).toEqual({ ok: true });
    expect(systemChangeAllowed(doc(), { phonology: 'kurmanji' })).toEqual({ ok: true });
    const no = systemChangeAllowed(doc('ā'), { phonology: 'jyutping' });
    expect(no.ok).toBe(false);
    expect((no as any).reason).toMatch(/erase/);
    // phonetics on an instrumental track do not count
    expect(systemChangeAllowed(doc('a', { instrumentation: ['Sitar'] }), { phonology: 'kurmanji' })).toEqual({ ok: true });
  });
  it('a tradition cannot be removed; unknown packs and bad shapes are refused', () => {
    expect(systemChangeAllowed(doc(), null).ok).toBe(false);
    expect(systemChangeAllowed(doc(), { phonology: 'klingon' }).ok).toBe(false);
    expect(systemChangeAllowed(doc(), { phonology: 'kurmanji', display: [1] as any }).ok).toBe(false);
  });
});
