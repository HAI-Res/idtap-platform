/**
 * Syllable tier in the TS model (idtap-contract 0.3.0, PROP-7/8/9): behaviour the
 * contract fixtures do not reach (contract-conformance.test.ts runs those).
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Piece, Phrase, Trajectory } from '../model';
import {
  parseClientHeader, clientKnowsSyllables, legacySafe, legacyOfTraj, trackFlat, Syllable,
} from '@shared/syllables';
import { checkWriteGuard, validClientHeader } from '../../../server/writeGuard';
import packRoutes from '../../../server/packRoutes';
import apiRoutes from '../../../server/apiRoutes';

vi.mock('../../../server/mediaConfig', () => ({
  mediaPath: (...segs: string[]) => ['mocked-media', ...segs].join('/'),
  PYTHON_PATH: 'echo',
  pythonEnv: () => ({ ...process.env }),
}));

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const SILENCE = 12;

type T = { uid: string; v?: string | null; s?: string | null; e?: string | null; id?: number; extra?: any };

function traj({ uid, v, s, e, id = 0, extra = {} }: T) {
  const t: any = {
    id, durTot: 0.5, durArray: [1], slope: 2, articulations: {}, uniqueId: uid,
    pitches: id === SILENCE ? [] : [{ swara: 0, raised: true, oct: 0, logOffset: 0 }],
    ...extra,
  };
  if (v !== undefined) t.vowel = v;
  if (s !== undefined) t.startConsonant = s;
  if (e !== undefined) t.endConsonant = e;
  return t;
}

function phrase(uid: string, trajs: any[], syllables?: Syllable[]) {
  const ph: any = { trajectoryGrid: [trajs], uniqueId: uid, durTot: trajs.length * 0.5 };
  if (syllables !== undefined) ph.syllables = syllables;
  return ph;
}

function pieceJson(phrases: any[], extra: any = {}) {
  return {
    title: 'syllable tier test',
    instrumentation: ['Vocal (F)'],
    phraseGrid: [phrases],
    durTot: phrases.reduce((a, p) => a + p.durTot, 0),
    ...extra,
  };
}

const syl = (traj: string, nucleus: string | null, more: Partial<Syllable> = {}): Syllable => {
  const s: any = { anchor: { traj, t: 0 } };
  if (more.onset !== undefined) s.onset = more.onset;
  if (nucleus !== null) s.nucleus = nucleus;
  Object.assign(s, more);
  s.lyric = more.lyric ?? { vowel: nucleus, source: 'pack' };
  return s;
};

const save = (p: Piece) => JSON.parse(JSON.stringify(p));
const row0 = (json: any, pi = 0) => json.phraseGrid[0][pi].trajectoryGrid[0];

describe('tier disabled (no system): preserve, never create', () => {
  it('a legacy piece saves with no syllables key and its legacy fields untouched', () => {
    const src = pieceJson([phrase('p0', [
      traj({ uid: 'a', v: 'ā', s: 'ba', extra: { startConsonantHindi: 'X-stale' } }),
      traj({ uid: 'b', v: 'ā' }),
    ])]);
    const piece = Piece.fromJSON(clone(src));
    expect(piece.syllableTierEnabled).toBe(false);
    expect(piece.syllablesByPhrase()[0][0].map(s => s.anchor.traj)).toEqual(['a']); // healed in memory
    const out = save(piece);
    expect('syllables' in out.phraseGrid[0][0]).toBe(false);
    expect('system' in out).toBe(false);
    // a stale stored display copy survives as today (only the tier's own phrases are projected)
    expect(row0(out)[0].startConsonantHindi).toBe('X-stale');
  });

  it('stored syllables are re-emitted byte-identical', () => {
    const stored = [
      { lyric: { source: 'model', vowel: 'ā' }, anchor: { t: 0, traj: 'a' }, nucleus: 'ā', onset: 'ba' },
    ] as any;
    const src = pieceJson([phrase('p0', [
      traj({ uid: 'a', v: 'ā', s: 'ba' }), traj({ uid: 'b', v: 'ā' }),
    ], stored)]);
    const out = save(Piece.fromJSON(clone(src)));
    expect(JSON.stringify(out.phraseGrid[0][0].syllables)).toBe(JSON.stringify(stored));
  });

  it('a phrase that arrived without the key leaves without it, next to one that had it', () => {
    const src = pieceJson([
      phrase('p0', [traj({ uid: 'a', v: 'ā' })], [syl('a', 'ā')]),
      phrase('p1', [traj({ uid: 'b', v: 'ī' })]),
    ]);
    const out = save(Piece.fromJSON(clone(src)));
    expect(out.phraseGrid[0][0].syllables).toHaveLength(1);
    expect('syllables' in out.phraseGrid[0][1]).toBe(false);
  });
});

describe('tier enabled (system present)', () => {
  it('persists the healed tier and keeps system and lyricsText verbatim', () => {
    const system = { phonology: 'hindi-urdu', 'x-future': 'kept' };
    const src = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'a', s: 'ka' })])],
      { system, lyricsText: ['का', null] });
    const piece = Piece.fromJSON(clone(src));
    expect(piece.syllableTierEnabled).toBe(true);
    const out = save(piece);
    expect(out.system).toEqual(system);
    expect(out.lyricsText).toEqual(['का', null]);
    expect(out.phraseGrid[0][0].syllables).toEqual([
      { anchor: { traj: 'a', t: 0 }, onset: 'ka', nucleus: 'a', lyric: { vowel: 'a', source: 'pack' } },
    ]);
  });

  it('a non-Hindi pack projects nothing: legacy fields and consonant articulations cleared', () => {
    const src = pieceJson([phrase('p0', [
      traj({ uid: 'y', v: 'ā', s: 'ba', extra: { articulations: { '0.00': { name: 'consonant', stroke: 'ba' } } } }),
    ], [syl('y', 'i', { onset: 's', tone: '1' })])], { system: { phonology: 'jyutping' } });
    const out = save(Piece.fromJSON(clone(src)));
    expect(legacyOfTraj(row0(out)[0])).toEqual({ art0: null, art1: null });
  });
});

describe('SYL-1: null == absent', () => {
  it('stored null phonetic fields load (no throw), do not start a syllable, and are not re-emitted', () => {
    const src = pieceJson([phrase('p0', [
      traj({ uid: 'a', v: 'ā', s: 'ba' }),
      traj({ uid: 'b', v: 'ā', s: null, e: null }),
    ])]);
    const piece = Piece.fromJSON(clone(src));
    expect(piece.syllablesByPhrase()[0][0].map(s => s.anchor.traj)).toEqual(['a']);
    const out = save(piece);
    expect(row0(out)[1].startConsonant).toBeUndefined();
    expect(row0(out)[1].articulations['0.00']).toBeUndefined();
  });

  it('a stored null uniqueId gets an id before healing', () => {
    const t = traj({ uid: 'x', v: 'a' });
    t.uniqueId = null;
    const piece = Piece.fromJSON(clone(pieceJson([phrase('p0', [t])])));
    expect(typeof piece.phraseGrid[0][0].trajectories[0].uniqueId).toBe('string');
    expect(piece.syllableViolations.map(v => v[0])).toContain('traj-uid-missing');
  });
});

describe('legacy dropdown edits reach the tier', () => {
  const tiered = () => Piece.fromJSON(clone(pieceJson([phrase('p0', [
    traj({ uid: 'a', v: 'ā', s: 'ba' }), traj({ uid: 'b', v: 'ā' }), traj({ uid: 'c', v: 'ā', e: 'la' }),
  ], [{ ...syl('a', 'ā', { onset: 'ba', coda: 'la' }), orthography: 'बाल' }])])));

  it('a vowel change keeps the syllable, its orthography and source becomes human', () => {
    const piece = tiered();
    piece.phraseGrid[0][0].trajectories.forEach(t => t.updateVowel('ī'));
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables).toEqual([{
      anchor: { traj: 'a', t: 0 }, onset: 'ba', nucleus: 'ī', coda: 'la', orthography: 'बाल',
      lyric: { vowel: 'ī', source: 'human' },
    }]);
    expect(row0(out).map((t: any) => t.vowel)).toEqual(['ī', 'ī', 'ī']);
  });

  it('a start consonant added mid-melisma splits the syllable', () => {
    const piece = tiered();
    piece.phraseGrid[0][0].trajectories[1].addConsonant('ma');
    const out = save(piece);
    const syls = out.phraseGrid[0][0].syllables;
    expect(syls.map((s: any) => [s.anchor.traj, s.onset ?? null, s.coda ?? null]))
      .toEqual([['a', 'ba', null], ['b', 'ma', 'la']]);
    expect(syls[0].orthography).toBe('बाल'); // kept on its anchor
    expect(syls[1].lyric.source).toBe('human');
  });

  it('a key the legacy fields cannot show (ṇa) survives a vowel edit', () => {
    const piece = Piece.fromJSON(clone(pieceJson([phrase('p0', [traj({ uid: 'a', v: 'a' })],
      [syl('a', 'a', { onset: 'ṇa' })])])));
    // the projection shows no consonant (ṇa has no legacy form)
    expect(piece.phraseGrid[0][0].trajectories[0].startConsonant).toBeUndefined();
    piece.phraseGrid[0][0].trajectories[0].updateVowel('ā');
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables[0]).toMatchObject({ onset: 'ṇa', nucleus: 'ā' });
  });
});

describe('re-homing through the pool (editor-style in-memory edits)', () => {
  const twoSyllables = () => Piece.fromJSON(clone(pieceJson([phrase('p0', [
    traj({ uid: 'a', v: 'ā', s: 'ba' }), traj({ uid: 'b', v: 'ā' }), traj({ uid: 'c', v: 'a', s: 'ga' }),
  ], [syl('a', 'ā', { onset: 'ba' }), { ...syl('c', 'a', { onset: 'ga' }), orthography: 'ग' }])])));

  it('split: the syllable follows its trajectory and both halves keep the key', () => {
    const piece = twoSyllables();
    const p0 = piece.phraseGrid[0][0];
    const moved = p0.trajectoryGrid[0].splice(2);
    p0.reset();
    const p1 = new Phrase({ trajectories: moved, uniqueId: 'p1' });
    piece.phraseGrid[0].push(p1);
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables.map((s: any) => s.anchor.traj)).toEqual(['a']);
    expect(out.phraseGrid[0][1].syllables).toEqual([{ ...syl('c', 'a', { onset: 'ga' }), orthography: 'ग' }]);
  });

  it('merge: a deleted phrase does not take its syllables with it', () => {
    const src = pieceJson([
      phrase('p0', [traj({ uid: 'a', v: 'ā', s: 'ba' })], [syl('a', 'ā', { onset: 'ba' })]),
      phrase('p1', [traj({ uid: 'c', v: 'a', s: 'ga' })], [{ ...syl('c', 'a', { onset: 'ga' }), orthography: 'ग' }]),
    ]);
    const piece = Piece.fromJSON(clone(src));
    const [p0, p1] = piece.phraseGrid[0];
    p0.trajectoryGrid[0].push(...p1.trajectoryGrid[0]);
    p0.reset();
    piece.phraseGrid[0].splice(1, 1);
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables.map((s: any) => [s.anchor.traj, s.orthography ?? null]))
      .toEqual([['a', null], ['c', 'ग']]);
  });

  it('deleting an anchor trajectory moves its syllable to the next note of its extent (spec §13)', () => {
    const piece = twoSyllables();
    piece.phraseGrid[0][0].trajectoryGrid[0].splice(0, 1);
    piece.phraseGrid[0][0].reset();
    const { dropped } = piece.syncSyllables();
    expect(dropped).toEqual([]);
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables.map((s: any) => [s.anchor.traj, s.nucleus]))
      .toEqual([['b', 'ā'], ['c', 'a']]);
    expect(row0(out)[0].vowel).toBe('ā'); // b keeps its vowel, not c's
  });
});

describe('X-IDTAP-Client', () => {
  it('parses <client>/<semver> and bare web', () => {
    expect(parseClientHeader('web')).toEqual({ client: 'web', version: null });
    expect(parseClientHeader('web/0.3.0')).toEqual({ client: 'web', version: '0.3.0' });
    expect(parseClientHeader('swift/0.3.1')).toEqual({ client: 'swift', version: '0.3.1' });
    expect(parseClientHeader('curl/0.3.0')).toBeNull();
    expect(parseClientHeader('web/0.3')).toBeNull();
    expect(parseClientHeader(undefined)).toBeNull();
  });
  it('only a >= 0.3.0 client knows the tier', () => {
    for (const h of [undefined, 'web', 'web/0.2.9', 'garbage']) expect(clientKnowsSyllables(h)).toBe(false);
    for (const h of ['web/0.3.0', 'python/0.3.0', 'swift/0.10.0', 'web/1.0.0']) expect(clientKnowsSyllables(h)).toBe(true);
  });
  it('the CSRF check accepts bare web and well-formed values only', () => {
    expect(validClientHeader('web')).toBe(true);
    expect(validClientHeader('python/0.3.0')).toBe(true);
    expect(validClientHeader(undefined)).toBe(false);
    expect(validClientHeader('evil')).toBe(false);
  });
});

describe('write guard', () => {
  const unsafe = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'a' })],
    [{ ...syl('a', 'a'), orthography: 'अ' }])]);
  const untiered = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'a' })])]);

  it('refuses a pre-0.3.0 save of an unsafe stored piece with 409 and the reasons', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(checkWriteGuard(unsafe, 'web', 'id1')).toEqual({
      ok: false, status: 409, body: { error: 'write-guard', reasons: ['orthography'], minContract: '0.3.0' },
    });
    expect(warn.mock.calls[0][0]).toContain('client=web reasons=orthography');
    warn.mockRestore();
  });
  it('lets a 0.3.0 client through, and anyone through on a never-tiered piece', () => {
    expect(checkWriteGuard(unsafe, 'web/0.3.0').ok).toBe(true);
    expect(checkWriteGuard(untiered, undefined).ok).toBe(true);
    expect(legacySafe(untiered)).toEqual([true, []]);
  });
  it('an untiered piece whose trajectories lack uniqueIds does not throw', () => {
    const t = traj({ uid: 'x', v: 'a' });
    delete t.uniqueId;
    expect(legacySafe(pieceJson([phrase('p0', [t])]))).toEqual([true, []]);
  });

  it('POST /api/transcription returns 409 for a pre-0.3.0 client on an unsafe piece', async () => {
    const DOC = '64b7f0f0f0f0f0f0f0f0f0f0';
    let updated = false;
    const collections = {
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: 'actor', ...unsafe }),
        updateOne: () => { updated = true; return Promise.resolve({ acknowledged: true }); },
      },
      users: { findOne: () => Promise.resolve({ _id: { toString: () => 'actor' } }) },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { id: 'sub' }; next(); });
    app.use(apiRoutes(collections as any));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = await request(app).post('/transcription').send({ _id: DOC, title: 't' });
    expect(old.status).toBe(409);
    expect(old.body).toEqual({ error: 'write-guard', reasons: ['orthography'], minContract: '0.3.0' });
    expect(updated).toBe(false);
    const ok = await request(app).post('/transcription').set('X-IDTAP-Client', 'python/0.3.0').send({ _id: DOC, title: 't' });
    expect(ok.status).toBe(200);
    expect(updated).toBe(true);
    warn.mockRestore();
  });
});

describe('packs API', () => {
  const app = express();
  app.use('/api/packs', packRoutes());
  it('lists the bundled packs and serves each one', async () => {
    const list = await request(app).get('/api/packs');
    expect(list.body.ids).toEqual(['hindi-urdu', 'jyutping', 'kurmanji']);
    const hu = await request(app).get('/api/packs/hindi-urdu');
    expect(hu.status).toBe(200);
    expect(hu.body.consonants.ka.legacy.iso).toBe('ka');
    expect((await request(app).get('/api/packs/nope')).status).toBe(404);
  });
});

describe('derived values', () => {
  it('stored legacy shape helper reads consonant articulations only', () => {
    const t = traj({ uid: 'a', extra: { articulations: { '0.00': { name: 'pluck', stroke: 'd' } } } });
    expect(legacyOfTraj(t)).toEqual({ art0: null, art1: null });
    expect(trackFlat([{ trajectoryGrid: [[t]] }]).length).toBe(1);
  });
});

describe('insertFixedTrajLeft (editor)', () => {
  it('re-anchoring keeps the syllable fields when a new trajectory takes the start consonant', () => {
    const piece = Piece.fromJSON(clone(pieceJson([phrase('p0', [traj({ uid: 'a', v: 'ā', s: 'ba' })],
      [{ ...syl('a', 'ā', { onset: 'ba' }), orthography: 'बा' }])])));
    const ph = piece.phraseGrid[0][0];
    const old = ph.trajectories[0];
    // what insertFixedTrajLeft does to the legacy fields
    const fresh = Piece.fromJSON(clone(pieceJson([phrase('q', [traj({ uid: 'n', v: 'ā', s: 'ba' })])])))
      .phraseGrid[0][0].trajectories[0];
    old.removeConsonant(true);
    ph.trajectoryGrid[0].unshift(fresh);
    ph.reset();
    piece.reanchorSyllable('a', 'n');
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables).toEqual([{ ...syl('n', 'ā', { onset: 'ba' }), orthography: 'बा' }]);
  });
});

describe('vocal tracks only (Jon, 2026-11-13)', () => {
  it('an instrumental track gets no tier, even with the flag on, and its legacy fields stand', () => {
    const src = pieceJson([phrase('p0', [
      traj({ uid: 's1', v: 'a' }), traj({ uid: 's2', v: 'a', s: 'ka' }),
    ])], { instrumentation: ['Sitar'], system: { phonology: 'hindi-urdu' } });
    const piece = Piece.fromJSON(clone(src));
    piece.phraseGrid[0][0].trajectories[0].updateVowel('ā'); // a dropdown-style edit
    const out = save(piece);
    expect('syllables' in out.phraseGrid[0][0]).toBe(false);
    expect(row0(out).map((t: any) => [t.vowel, t.startConsonant ?? null])).toEqual([['ā', null], ['a', 'ka']]);
  });

  it('a tier stored on an instrumental track is kept verbatim, not projected, and warned about', () => {
    const stored = [syl('s1', 'ī')];
    const src = pieceJson([phrase('p0', [traj({ uid: 's1', v: 'a' })], stored)], { instrumentation: ['Sitar'] });
    const piece = Piece.fromJSON(clone(src));
    expect(piece.syllableViolations.map(v => v[0])).toEqual(['track-not-vocal']);
    const out = save(piece);
    expect(out.phraseGrid[0][0].syllables).toEqual(stored);
    expect(row0(out)[0].vowel).toBe('a');
    expect(legacySafe(out)).toEqual([false, ['boundary']]);
  });
});

describe('robustness: malformed stored tiers (review of #64)', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('a stored syllable without an anchor loads, is reported, carried through unchanged, and does not overwrite legacy fields', () => {
    const w = quiet();
    const bad = [{ nucleus: 'a', lyric: { vowel: 'a', source: 'human' } }];
    const src = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'ā', s: 'ba' })], bad as any)]);
    const piece = Piece.fromJSON(clone(src)); // must not throw
    expect(piece.syllableViolations.map(v => v[0])).toContain('syllable-malformed');
    const out = save(piece); // must not throw
    expect(out.phraseGrid[0][0].syllables).toEqual(bad);
    // the stored values stand (the loader fills display copies from the tables, as main does)
    expect([row0(out)[0].vowel, row0(out)[0].startConsonant, row0(out)[0].articulations['0.00']?.stroke]).toEqual(['ā', 'ba', 'ba']);
    w.mockRestore();
  });

  it('a non-array or null-entry tier loads and saves without throwing', () => {
    const w = quiet();
    for (const bad of [{ oops: true }, [null], ['x'], [{ anchor: null, lyric: { vowel: null, source: 'pack' } }]]) {
      const src = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'ā' })], bad as any)]);
      const piece = Piece.fromJSON(clone(src));
      expect(piece.syllableViolations.map(v => v[0])).toContain('syllable-malformed');
      expect(save(piece).phraseGrid[0][0].syllables).toEqual(bad);
    }
    w.mockRestore();
  });

  it('PROVISIONAL: a phrase whose stored tier has a dangling anchor keeps its stored legacy fields', () => {
    const w = quiet();
    const src = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'ā', s: 'ba' }), traj({ uid: 'b', v: 'ā' })],
      [syl('gone', 'ī')])]);
    const piece = Piece.fromJSON(clone(src));
    expect(piece.syllableViolations.map(v => v[0])).toContain('anchor-missing');
    const out = save(piece);
    expect(row0(out).map((t: any) => [t.vowel, t.startConsonant ?? null])).toEqual([['ā', 'ba'], ['ā', null]]);
    expect(out.phraseGrid[0][0].syllables).toEqual([syl('gone', 'ī')]);
    w.mockRestore();
  });

  it('the write guard fails closed on an unreadable tiered document and stays open on an untiered one', () => {
    const w = quiet();
    // a Jyutping piece with a stored syllable that has no anchor
    const noAnchor = pieceJson([phrase('p0', [traj({ uid: 'a' })], [{ nucleus: 'i', lyric: { vowel: 'i', source: 'human' } }] as any)],
      { system: { phonology: 'jyutping' } });
    expect(checkWriteGuard(noAnchor, 'web')).toEqual({
      ok: false, status: 409, body: { error: 'write-guard', reasons: ['unreadable'], minContract: '0.3.0' } });
    // a null track next to a tiered one
    const nullTrack = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'a' })], [{ ...syl('a', 'a'), orthography: 'अ' }])]);
    (nullTrack.phraseGrid as any).push(null);
    expect(checkWriteGuard(nullTrack, 'web')).toMatchObject({ ok: false, body: { reasons: ['unreadable'] } });
    // a null track with nothing tiered anywhere: nothing to protect
    const untiered = pieceJson([phrase('p0', [traj({ uid: 'a', v: 'a' })])]);
    (untiered.phraseGrid as any).push(null);
    expect(checkWriteGuard(untiered, 'web').ok).toBe(true);
    // a non-Hindi phonology with no tier is still refused when unreadable
    const nonHindi = { ...untiered, system: { phonology: 'kurmanji' } };
    expect(checkWriteGuard(nonHindi, 'web')).toMatchObject({ ok: false, body: { reasons: ['unreadable'] } });
    expect(checkWriteGuard(noAnchor, 'web/0.3.0').ok).toBe(true);
    expect(w.mock.calls.some(c => String(c[0]).includes('reasons=unreadable'))).toBe(true);
    w.mockRestore();
  });
});

describe('Swift review cases, in TS (flag on)', () => {
  const HINDUSTANI = { phonology: 'hindi-urdu' };
  const silence = (dur: number) => new Trajectory({ id: 12, durTot: dur, pitches: [] });

  it('1. deleting the trajectory that anchors the only syllable keeps the rest of it (ā ā la)', () => {
    const piece = Piece.fromJSON(clone(pieceJson([phrase('p0', [
      traj({ uid: 't1', v: 'ā', s: 'ba' }), traj({ uid: 't2', v: 'ā' }), traj({ uid: 't3', v: 'ā', e: 'la' }),
    ])], { system: HINDUSTANI })));
    const ph = piece.phraseGrid[0][0];
    ph.trajectoryGrid[0].splice(0, 1);
    ph.reset();
    const out = save(piece);
    expect(row0(out).map((t: any) => [t.vowel ?? null, t.startConsonant ?? null, t.endConsonant ?? null]))
      .toEqual([['ā', null, null], ['ā', null, 'la']]);
    // the syllable moved to t2 (spec §13) and kept its vowel and source; its
    // onset went with t1, the trajectory that carried it
    expect(out.phraseGrid[0][0].syllables).toEqual([
      { anchor: { traj: 't2', t: 0 }, nucleus: 'ā', coda: 'la', lyric: { vowel: 'ā', source: 'pack' } }]);
  });

  it('2. a trajectory drawn onto the end of a sounding one starts its own syllable (i ka), t1 keeps la', () => {
    const piece = Piece.fromJSON(clone(pieceJson([phrase('p0', [
      traj({ uid: 't1', v: 'ā', s: 'ba', e: 'la' }), traj({ uid: 's', id: 12 }), traj({ uid: 't5', v: 'ī' }),
    ])], { system: HINDUSTANI })));
    const ph = piece.phraseGrid[0][0];
    // what drawing at 0.5-0.8 s does: the silence after t1 becomes [new, shorter silence]
    const drawn = new Trajectory({ id: 0, durTot: 0.3, pitches: ph.trajectories[0].pitches, vowel: 'i', startConsonant: 'ka' });
    ph.trajectoryGrid[0].splice(1, 1, drawn, silence(0.2));
    ph.reset();
    const out = save(piece);
    const r = row0(out);
    expect([r[0].vowel, r[0].startConsonant, r[0].endConsonant]).toEqual(['ā', 'ba', 'la']);
    expect([r[1].vowel, r[1].startConsonant, r[1].endConsonant ?? null]).toEqual(['i', 'ka', null]);
    expect(out.phraseGrid[0][0].syllables.map((x: any) => [x.anchor.traj === 't1' ? 't1' : x.anchor.traj === drawn.uniqueId ? 'drawn' : x.anchor.traj,
      x.onset ?? null, x.nucleus, x.coda ?? null]))
      .toEqual([['t1', 'ba', 'ā', 'la'], ['drawn', 'ka', 'i', null], ['t5', null, 'ī', null]]);
  });

  for (const [phonology, nucleus] of [['jyutping', 'i'], ['kurmanji', 'e']] as const) {
    it(`3. routine edits on a ${phonology} piece never block or break a save; errors are reported`, () => {
      const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tier = [syl('y1', nucleus)];
      const piece = Piece.fromJSON(clone(pieceJson([phrase('p0', [
        traj({ uid: 'y1' }), traj({ uid: 'y2' }), traj({ uid: 's', id: 12 }), traj({ uid: 'y4' }),
      ], [...tier, syl('y4', nucleus)])], { system: { phonology } })));
      expect(piece.syllableViolations).toEqual([]);
      const ph = piece.phraseGrid[0][0];
      // draw into the silence (no phonemes: the dropdowns are hidden here)
      ph.trajectoryGrid[0].splice(2, 1, new Trajectory({ id: 0, durTot: 0.2, pitches: ph.trajectories[0].pitches }), silence(0.3));
      // insert a silence inside the melisma y1-y2
      ph.trajectoryGrid[0].splice(1, 0, silence(0.1));
      ph.reset();
      const out = save(piece); // must not throw
      expect(out.phraseGrid[0][0].syllables.map((x: any) => x.anchor.traj)).toEqual(['y1', 'y4']);
      // the next load reports the gaps the edits opened, as violations, and saves again
      const again = Piece.fromJSON(clone(out));
      expect([...new Set(again.syllableViolations.map(v => v[0]))]).toEqual(['unanchored-start']);
      expect(again.frozenSyllablePhraseUids.size).toBe(0);
      expect(save(again).phraseGrid[0][0].syllables.map((x: any) => x.anchor.traj)).toEqual(['y1', 'y4']);
      w.mockRestore();
    });
  }
});
