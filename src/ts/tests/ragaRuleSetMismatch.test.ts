import { expect, test, describe, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Piece, Raga } from '@model';
import { healLegacyRuleSet, hasStoredRuleSet } from '@/js/ruleSetHeal';
import { playerTuningFreqs } from '@/js/tuningTable';

// The DB rule set for a raga NAME can change after a piece was saved. On
// 2025-10-02 the DB's Yaman gained komal (lowered) ma → 8 pitches, while every
// saved Yaman piece (and every code default) has 7 ratios. Grafting the DB
// rules onto a stored piece misaligns ratios ↔ rule set and used to crash the
// editor's audio player (`setValueAtTime(undefined)`). These tests pin the
// two halves of the fix: never overwrite a stored ruleSet, and never throw
// when the counts disagree anyway.

const yaman7 = {
  sa: true,
  re: { lowered: false, raised: true },
  ga: { lowered: false, raised: true },
  ma: { lowered: false, raised: true },
  pa: true,
  dha: { lowered: false, raised: true },
  ni: { lowered: false, raised: true },
};
// What the DB has served for "Yaman" since 2025-10-02.
const yaman8 = { ...yaman7, ma: { lowered: true, raised: true } };

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'serialization_test.json');
const loadFixture = () => JSON.parse(readFileSync(fixturePath, 'utf8'));

// Non-ET ratios so we can tell "preserved" from "regenerated".
const storedRatios = [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 27 / 16, 15 / 8];

describe('healLegacyRuleSet', () => {
  test('a stored ruleSet is never overwritten by the DB rules', async () => {
    const piece = loadFixture();
    piece.raga = {
      name: 'Yaman', fundamental: 246, ruleSet: yaman7, ratios: storedRatios,
    };
    const fetchRules = vi.fn(async () => ({ rules: yaman8 }));

    await healLegacyRuleSet(piece, fetchRules);

    expect(fetchRules).not.toHaveBeenCalled();
    expect(piece.raga.ruleSet).toEqual(yaman7);
    const loaded = Piece.fromJSON(piece);
    expect(loaded.raga.ratios).toEqual(storedRatios);
    expect(loaded.raga.ruleSetNumPitches).toBe(7);
    expect(loaded.raga.sargamLetters).toHaveLength(7);
  });

  test('a legacy piece with no ruleSet gets the DB rules (heal)', async () => {
    const piece = loadFixture();
    piece.raga = { name: 'Yaman', fundamental: 246, ratios: storedRatios };
    delete piece.raga.ruleSet;
    const fetchRules = vi.fn(async (name: string) => {
      expect(name).toBe('Yaman');
      return { rules: yaman8 };
    });

    await healLegacyRuleSet(piece, fetchRules);

    expect(fetchRules).toHaveBeenCalledTimes(1);
    expect(piece.raga.ruleSet).toEqual(yaman8);
  });

  test('legacy heal warns when the DB rules no longer match the ratio count', async () => {
    const piece = loadFixture();
    piece.raga = { name: 'Yaman', fundamental: 246, ratios: storedRatios }; // 7
    delete piece.raga.ruleSet;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await healLegacyRuleSet(piece, async () => ({ rules: yaman8 }));      // 8
    expect(piece.raga.ruleSet).toEqual(yaman8);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/7 ratio/);
    expect(warn.mock.calls[0][0]).toMatch(/8 pitch/);
    // ...and the piece still loads with its ratios intact.
    const loaded = Piece.fromJSON(piece);
    expect(loaded.raga.ratios).toEqual(storedRatios);
    warn.mockRestore();
  });

  test('empty / null ruleSet counts as missing', () => {
    expect(hasStoredRuleSet({ name: 'x', ruleSet: {} })).toBe(false);
    expect(hasStoredRuleSet({ name: 'x', ruleSet: null })).toBe(false);
    expect(hasStoredRuleSet({ name: 'x' })).toBe(false);
    expect(hasStoredRuleSet({ name: 'x', ruleSet: yaman7 })).toBe(true);
  });

  test('DB knows nothing about the raga → no throw, ruleSet left absent', async () => {
    const piece = loadFixture();
    piece.raga = { name: 'Nonexistent', fundamental: 246, ratios: storedRatios };
    delete piece.raga.ruleSet;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(healLegacyRuleSet(piece, async () => null)).resolves.toBe(piece);
    await expect(healLegacyRuleSet(piece, async () => undefined)).resolves.toBe(piece);
    expect(piece.raga.ruleSet).toBeUndefined();
    warn.mockRestore();
  });
});

describe('playerTuningFreqs (audio player tuning table)', () => {
  test('aligned raga: one frequency per ratio, straight from ratios', () => {
    const raga = new Raga({ name: 'Yaman', fundamental: 246, ruleSet: yaman7, ratios: storedRatios });
    const { freqs, aligned } = playerTuningFreqs(raga);
    expect(aligned).toBe(true);
    expect(freqs).toEqual(storedRatios.map(r => 246 * r));
  });

  test('7 stored ratios against an 8-pitch rule set: degrades, does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // This is exactly what a piece looked like after the old DB-overwrite.
    const raga = new Raga({ name: 'Yaman', fundamental: 246, ruleSet: yaman8, ratios: storedRatios });
    expect(raga.ratios).toEqual(storedRatios);          // PROP-1: untouched
    expect(raga.sargamLetters).toHaveLength(8);

    const { freqs, aligned } = playerTuningFreqs(raga);
    expect(aligned).toBe(false);
    expect(freqs).toHaveLength(8);                       // one per sargam letter
    freqs.forEach(f => expect(Number.isFinite(f)).toBe(true));
    // ascending within the fundamental octave, sa first
    expect(freqs[0]).toBeCloseTo(246, 6);
    for (let i = 1; i < freqs.length; i++) expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Yaman/);
    expect(warn.mock.calls[0][0]).toMatch(/7 stored/);
    expect(warn.mock.calls[0][0]).toMatch(/8 pitch/);
    warn.mockRestore();
  });

  test('misaligned raga with a saved tuning table keeps its tuned frequencies', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A saved piece carries `tuning` (Raga.toJSON emits it), synced from the
    // ratios at save time. Round-trip a 7-pitch raga, then load its JSON
    // against the 8-pitch rules: the 7 original pitches must keep their
    // exact frequencies; only komal ma comes from the ET default.
    const saved = new Raga({ name: 'Yaman', fundamental: 246, ruleSet: yaman7, ratios: storedRatios });
    const json = JSON.parse(JSON.stringify(saved.toJSON()));
    json.ruleSet = yaman8; // the old overwrite
    const reloaded = Raga.fromJSON(json);
    const { freqs } = playerTuningFreqs(reloaded);
    const original = storedRatios.map(r => 246 * r);
    const withoutKomalMa = freqs.filter((_, i) => i !== 3);
    withoutKomalMa.forEach((f, i) => expect(f).toBeCloseTo(original[i], 9));
    expect(freqs[3]).toBeCloseTo(246 * 2 ** (5 / 12), 9);
    warn.mockRestore();
  });
});
