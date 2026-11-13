/**
 * Lyric mode controller: SPEC-provisional §15 acceptance checks 3-11, driven
 * through the gestures and keys (no DOM).
 */
import { describe, it, expect } from 'vitest';
import { Piece } from '../model';
import { LyricController } from '@/comps/editor/lyric/lyricController';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const T = (uid: string) => ({ id: 0, durTot: 0.5, durArray: [1], slope: 2, articulations: {}, uniqueId: uid,
  pitches: [{ swara: 0, raised: true, oct: 0, logOffset: 0 }] });
const S = (uid: string) => ({ id: 12, durTot: 0.5, durArray: [1], articulations: {}, uniqueId: uid, pitches: [] });
function setup(phonology: string, trajs: any[]) {
  const piece = Piece.fromJSON(clone({ title: 't', instrumentation: ['Vocal (F)'], system: { phonology },
    durTot: trajs.length * 0.5, phraseGrid: [[{ uniqueId: 'p0', durTot: trajs.length * 0.5, trajectoryGrid: [trajs] }]] }));
  let changes = 0;
  const c = new LyricController(piece, () => 0, () => { changes++; });
  return { piece, c, changes: () => changes };
}
const key = (k: string, mods: Partial<{ shiftKey: boolean, altKey: boolean }> = {}) =>
  ({ key: k, shiftKey: false, altKey: false, ...mods });
const notes = (n: number, from = 1) => Array.from({ length: n }, (_, i) => T(`n${i + from}`));

describe('lyric controller (acceptance 3-11)', () => {
  it('3. L, click note 1, shift-click note 5, pick h e r; hatched after note 5; Next selects note 6', () => {
    const { c, piece, changes } = setup('kurmanji', notes(7));
    expect(c.available(true)).toEqual({ ok: true });
    c.clickTraj('n1', false);
    c.clickTraj('n5', true);
    expect(c.sel).toMatchObject({ t: 'run', first: 'n1', last: 'n5' });
    c.pick('onset', 'h'); c.pick('nucleus', 'e'); c.pick('coda', 'r');
    expect(c.sel.t).toBe('syllable');
    const syl = (c.sel as any).syl;
    expect(syl).toMatchObject({ anchor: { traj: 'n1', t: 0 }, onset: 'h', nucleus: 'e', coda: 'r',
      lyric: { vowel: 'e', source: 'human' } });
    const span = piece.syllableSpans(0)[0];
    expect(c.runOnStart(span)).toBeCloseTo(2.5); // note 6 starts at 2.5 s
    expect(changes()).toBe(3);
    c.nextSyllable();
    expect(c.sel).toMatchObject({ t: 'run', first: 'n6', last: 'n6' });
    expect(c.status).toBe('Note 6 selected. Shift-click to the last note of the next syllable.');
  });

  it('4. cluster switch: x, w, then e -> onset [x, w], romanization xwe', () => {
    const { c } = setup('kurmanji', notes(1));
    c.clickTraj('n1', false);
    c.cluster = true;
    c.pick('onset', 'x'); c.pick('onset', 'w');
    expect(c.openSlot).toBe('onset'); // picks don't advance while the switch is on
    c.cluster = false;
    c.pick('nucleus', 'e');
    expect((c.sel as any).syl).toMatchObject({ onset: ['x', 'w'], romanization: 'xwe' });
  });

  it('5. Cantonese s, i: ending i disabled (no final ii); k, tone 6 -> sik6, nine-tone 9', () => {
    const { c } = setup('jyutping', notes(1));
    c.clickTraj('n1', false);
    c.pick('onset', 's'); c.pick('nucleus', 'i');
    expect(c.disabledReason('coda', 'i')).toBe('no final ii');
    c.pick('coda', 'k'); c.pick('tone', '6');
    const syl = (c.sel as any).syl;
    expect(syl).toMatchObject({ romanization: 'sik6', tone: '6' });
    expect(c.displayRomanization(syl)).toEqual({ body: 'sik', tone: '6', nine: '9' });
  });

  it('6. Cantonese no vowel: onset cleared, ending m, lyric.vowel null', () => {
    const { c } = setup('jyutping', notes(1));
    c.clickTraj('n1', false);
    c.pick('onset', 's');
    c.pick('nucleus', null);
    expect((c.sel as any).syl).toMatchObject({ coda: 'm', lyric: { vowel: null } });
    expect((c.sel as any).syl.onset).toBeUndefined();
  });

  it('7. typing si1 presses s, i, none, 1; picking tone 3 turns the box into si3', () => {
    const { c } = setup('jyutping', notes(1));
    c.clickTraj('n1', false);
    c.input('si1');
    expect(c.currentParts()).toMatchObject({ onset: 's', nucleus: 'i', tone: '1' });
    expect(c.currentParts().coda).toBeUndefined();
    expect(c.commitText()).toBe(true);
    c.pick('tone', '3');
    expect(c.text).toBe('si3');
  });

  it('7b. more than one syllable, or a hard error, writes nothing', () => {
    const { c, piece } = setup('kurmanji', notes(2));
    c.clickTraj('n1', false); c.clickTraj('n2', true);
    c.input('wa yê');
    expect(c.textError).toBe('That is 2 syllables. Type one, or select fewer notes.');
    c.input('q!');
    expect(c.textError).toMatch(/^key-unknown/);
    expect(c.commitText()).toBe(false);
    expect(piece.syllableSpans(0)).toEqual([]);
  });

  it('8. Shift+→ on the first syllable after a silence is refused', () => {
    const { c } = setup('kurmanji', [S('s0'), ...notes(3)]);
    c.clickTraj('n1', false); c.clickTraj('n3', true); c.pick('nucleus', 'a');
    c.key(key('ArrowRight', { shiftKey: true }));
    expect(c.statusIsError).toBe(true);
    expect(c.status).toBe('The first note after a silence must start a syllable (unanchored-start), so this start cannot move right.');
  });

  it('9. Alt+Shift+→ twice, then Enter: the note splits, the syllable anchors on its second part', () => {
    const { c, piece } = setup('kurmanji', notes(3));
    c.clickTraj('n1', false); c.clickTraj('n1', true); c.pick('nucleus', 'a');
    c.clickTraj('n2', false); c.clickTraj('n3', true); c.pick('nucleus', 'e');
    const syl = (c.sel as any).syl;
    // from the start note n2: ¼, then ½
    c.key(key('ArrowLeft', { shiftKey: true, altKey: true })); // into n1 at ¾
    c.key(key('ArrowRight', { shiftKey: true, altKey: true })); // back into n2 at ¼
    c.key(key('ArrowRight', { shiftKey: true, altKey: true })); // n2 at ½
    expect(c.marker).toEqual({ trajUid: 'n2', frac: 0.5 });
    c.key(key('Enter'));
    const row = piece.phraseGrid[0][0].trajectoryGrid[0];
    expect(row).toHaveLength(4);
    expect(syl.anchor).toEqual({ traj: row[2].uniqueId, t: 0 });
    expect(row[1].uniqueId).toBe('n2');
  });

  it('10. / on a 6-note syllable selects the second half, nothing changes; Esc keeps it whole; a pick creates it', () => {
    const { c, piece } = setup('kurmanji', notes(6));
    c.clickTraj('n1', false); c.clickTraj('n6', true); c.pick('nucleus', 'a');
    const before = JSON.stringify(piece.syllableSpans(0).map(x => x.syllable));
    c.key(key('/'));
    expect(c.sel).toMatchObject({ t: 'run', first: 'n4', last: 'n6' });
    expect(JSON.stringify(piece.syllableSpans(0).map(x => x.syllable))).toBe(before);
    c.key(key('Escape'));
    expect(c.sel.t).toBe('syllable');
    c.key(key('/'));
    c.pick('nucleus', 'e');
    expect(piece.syllableSpans(0).map(x => [x.syllable.anchor.traj, x.trajs.length])).toEqual([['n1', 3], ['n4', 3]]);
    expect(c.confirm).toBeNull(); // no start inside the run, so no confirmation
  });

  it('11. Backspace asks first; Cancel changes nothing; Merge merges', () => {
    const { c, piece } = setup('kurmanji', notes(4));
    c.clickTraj('n1', false); c.clickTraj('n2', true); c.pick('nucleus', 'a');
    c.clickTraj('n3', false); c.clickTraj('n4', true); c.pick('nucleus', 'e');
    c.key(key('Backspace'));
    expect(c.confirm?.confirmLabel).toBe('Merge');
    expect(c.confirm?.message).toMatch(/^Merge “e” into “a”\?/);
    c.key(key('Escape'));
    expect(piece.syllableSpans(0)).toHaveLength(2);
    c.key(key('Backspace'));
    c.confirmYes();
    expect(piece.syllableSpans(0).map(x => [x.syllable.anchor.traj, x.trajs.length])).toEqual([['n1', 4]]);
  });

  it('a pick over a run that holds starts asks first (Replace)', () => {
    const { c, piece } = setup('kurmanji', notes(2));
    c.clickTraj('n1', false); c.pick('nucleus', 'a');
    c.clickTraj('n2', false); c.pick('nucleus', 'e');
    c.clickTraj('n1', false); c.clickTraj('n2', true);
    c.pick('nucleus', 'o');
    expect(c.confirm?.confirmLabel).toBe('Replace');
    expect(piece.syllableSpans(0)).toHaveLength(2);
    c.confirmYes();
    expect(piece.syllableSpans(0).map(x => x.syllable.nucleus)).toEqual(['o']);
  });

  it('Esc ladder: marker, then selection, then leave', () => {
    const { c } = setup('kurmanji', notes(2));
    c.clickTraj('n1', false);
    expect(c.key(key('Escape'))).toBe(true);
    expect(c.sel.t).toBe('none');
    expect(c.key(key('Escape'))).toBe('leave');
  });

  it('is unavailable without a system, on read-only pieces, and off vocal tracks', () => {
    const { c } = setup('kurmanji', notes(1));
    expect(c.available(false)).toEqual({ ok: false, reason: 'Read only' });
    const p2 = Piece.fromJSON(clone({ title: 't', instrumentation: ['Vocal (F)'], durTot: 0.5,
      phraseGrid: [[{ uniqueId: 'p0', durTot: 0.5, trajectoryGrid: [[T('n1')]] }]] }));
    expect(new LyricController(p2, () => 0).available(true)).toEqual({ ok: false, reason: 'Set a tradition first' });
    const p3 = Piece.fromJSON(clone({ title: 't', instrumentation: ['Sitar'], durTot: 0.5, system: { phonology: 'kurmanji' },
      phraseGrid: [[{ uniqueId: 'p0', durTot: 0.5, trajectoryGrid: [[T('n1')]] }]] }));
    expect(new LyricController(p3, () => 0).available(true)).toEqual({ ok: false, reason: 'Lyrics go on vocal tracks' });
  });

  it('checks list unanchored-start and Cantonese tone-missing as warnings', () => {
    const { c } = setup('jyutping', [T('n1'), S('s'), T('n3')]);
    c.clickTraj('n1', false); c.pick('onset', 's'); c.pick('nucleus', 'i');
    const codes = c.checks().map(x => x.code).sort();
    expect(codes).toEqual(['tone-missing', 'unanchored-start']);
  });
});

import { optionsFor, cycleBeforeCaret } from '@/comps/editor/lyric/pickerOptions';
import { PACKS } from '@shared/syllables';

describe('picker options (spec §5.2-5.3)', () => {
  it('Hindi onsets: none + 33 consonants in six groups, Devanagari script, key without the a, unverified hints', () => {
    const g = optionsFor(PACKS['hindi-urdu'], 'onset');
    expect(g.map(x => x.name)).toEqual([undefined, 'Back of the mouth', 'Middle of the tongue', 'Tongue tip curled back', 'Tongue on the teeth', 'Lips', 'Others']);
    const all = g.flatMap(x => x.options);
    expect(all.length).toBe(34);
    expect(all.find(o => o.key === 'ka')).toMatchObject({ script: 'क', roman: 'k', ipa: 'k', unverified: true });
    expect(g[6].options.map(o => o.key)).toEqual(['ya', 'ra', 'la', 'va', 'śa', 'ṣa', 'sa', 'ha']);
  });
  it('Hindi vowels: no vowel + 10 (not _), with the vowel sign', () => {
    const o = optionsFor(PACKS['hindi-urdu'], 'nucleus')[0].options;
    expect(o.length).toBe(11);
    expect(o.find(x => x.key === 'ā')).toMatchObject({ script: 'आ', sub: '◌ा' });
  });
  it('Cantonese: example character as script; endings grouped; checked tones show short contours and 7/8/9', () => {
    const P = PACKS.jyutping;
    expect(optionsFor(P, 'onset').flatMap(x => x.options).find(o => o.key === 'b')).toMatchObject({ script: '爸', sub: 'baa1' });
    expect(optionsFor(P, 'coda').map(x => x.name)).toEqual([undefined, 'Glides and nasals', 'Stopped (checked) endings']);
    const t6 = optionsFor(P, 'tone', true)[0].options.find(o => o.key === '6')!;
    expect(t6).toMatchObject({ chao: '2 short', nine: '= tone 9', script: '食' });
    expect(optionsFor(P, 'tone', true)[0].options.find(o => o.key === '2')!.nine).toBeUndefined();
  });
  it("Kurmanji: no 'no vowel'; Thackston's extra letters last, in their own group", () => {
    const P = PACKS.kurmanji;
    expect(optionsFor(P, 'nucleus')[0].options.some(o => o.key === null)).toBe(false);
    const g = optionsFor(P, 'onset');
    expect(g[1].name).toMatch(/^Thackston/);
    expect(g[1].options.map(o => o.key).sort()).toEqual(['ç̱', 'ḥ', 'ḵ', 'p̱', 'ṯ', 'x̱', 'ʿ'].map(x => x.normalize('NFC')).sort());
  });
  it('` cycles the letter before the caret', () => {
    expect(cycleBeforeCaret('hindi-urdu', 'ba', 2)).toEqual({ text: 'bā', caret: 2 });
    expect(cycleBeforeCaret('kurmanji', 'c', 1)).toEqual({ text: 'ç', caret: 1 });
    expect(cycleBeforeCaret('kurmanji', 'ç', 1)!.text).toBe('ç̱'.normalize('NFC'));
  });
});

describe('review of #68 (controller)', () => {
  it('3. picking "none" first on a new run creates nothing', () => {
    const { c, piece, changes } = setup('kurmanji', notes(2));
    c.clickTraj('n1', false);
    c.pick('onset', null);
    expect(piece.syllableSpans(0)).toEqual([]);
    expect(c.sel.t).toBe('run');
    expect(changes()).toBe(0);
    c.pick('nucleus', 'a');
    expect(piece.syllableSpans(0)).toHaveLength(1);
  });
  it('Esc in the inline box restores exactly: no source flip, nothing new to save', () => {
    const { c, changes } = setup('kurmanji', notes(1));
    c.clickTraj('n1', false); c.pick('nucleus', 'a');
    const syl = (c.sel as any).syl;
    syl.lyric.source = 'model'; // as if a model had written it
    const snap = JSON.stringify(syl);
    const before = changes();
    c.openInline();
    c.input('e');
    expect(syl.nucleus).toBe('e');
    c.cancelInline();
    expect(JSON.stringify(syl)).toBe(snap);
    expect(changes()).toBe(before + 1); // only the typed edit marked the piece; the restore did not
  });
});
