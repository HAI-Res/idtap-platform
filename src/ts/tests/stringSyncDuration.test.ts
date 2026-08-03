import { expect, test, vi } from 'vitest';
import { Piece, Phrase, Trajectory, Pitch, Raga } from '@model';
import { Instrument } from '@shared/enums';

/* ------------------------------------------------------------------
   Regression tests for the polyphonic timeline-stretch bug: a second
   string whose trajectories outlast the phrase must not inflate the
   phrase (and therefore piece) durTot. Main string is authoritative.
------------------------------------------------------------------ */

const silent = (durTot: number) =>
  new Trajectory({ id: 12, durTot, pitches: [new Pitch()] });
const sounding = (durTot: number) =>
  new Trajectory({ id: 0, durTot, pitches: [new Pitch(), new Pitch()] });

const sum = (trajs: Trajectory[]) => trajs.reduce((a, t) => a + t.durTot, 0);

test('phrase durTot comes from the main string, not an overlong second string', () => {
  const phrase = new Phrase({
    trajectoryGrid: [[silent(10)], [silent(4), sounding(2), silent(10)]],
  });
  expect(phrase.durTot).toBeCloseTo(10, 10);
});

test('phrase durTot falls back to longest secondary string when main is empty', () => {
  const phrase = new Phrase({
    trajectoryGrid: [[], [silent(3), sounding(2)]],
  });
  phrase.durTotFromTrajectories();
  expect(phrase.durTot).toBeCloseTo(5, 10);
});

test('ensureStringSynchronization trims trailing second-string silence', () => {
  const raga = new Raga({ fundamental: 240 });
  const phrase = new Phrase({
    trajectoryGrid: [[silent(10)], [silent(4), sounding(2), silent(10)]],
  });
  const piece = new Piece({
    phrases: [phrase],
    raga,
    instrumentation: [Instrument.Sarangi],
  });
  const s2 = piece.phraseGrid[0][0].trajectoryGrid[1];
  expect(sum(s2)).toBeCloseTo(10, 6);
  // sounding content survives the trim
  expect(s2.some(t => t.id === 0 && Math.abs(t.durTot - 2) < 1e-9)).toBe(true);
  expect(piece.durTot).toBeCloseTo(10, 6);
});

test('ensureStringSynchronization pads a short second string with silence', () => {
  const raga = new Raga({ fundamental: 240 });
  const phrase = new Phrase({
    trajectoryGrid: [[silent(10)], [silent(2), sounding(3)]],
  });
  const piece = new Piece({
    phrases: [phrase],
    raga,
    instrumentation: [Instrument.Sarangi],
  });
  const s2 = piece.phraseGrid[0][0].trajectoryGrid[1];
  expect(sum(s2)).toBeCloseTo(10, 6);
  expect(s2[s2.length - 1].id).toBe(12);
});

test('sounding overhang is preserved and warned about, not destroyed', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const raga = new Raga({ fundamental: 240 });
  const phrase = new Phrase({
    trajectoryGrid: [[silent(10)], [silent(2), sounding(14)]],
  });
  const piece = new Piece({
    phrases: [phrase],
    raga,
    instrumentation: [Instrument.Sarangi],
  });
  const s2 = piece.phraseGrid[0][0].trajectoryGrid[1];
  // sounding trajectory untouched
  expect(s2.some(t => t.id === 0 && Math.abs(t.durTot - 14) < 1e-9)).toBe(true);
  // but the timeline stays main-string based
  expect(piece.phraseGrid[0][0].durTot).toBeCloseTo(10, 10);
  expect(piece.durTot).toBeCloseTo(10, 6);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test('healthy dual-string phrases are untouched', () => {
  const raga = new Raga({ fundamental: 240 });
  const phrase = new Phrase({
    trajectoryGrid: [
      [silent(4), sounding(6)],
      [silent(1), sounding(2), silent(7)],
    ],
  });
  const piece = new Piece({
    phrases: [phrase],
    raga,
    instrumentation: [Instrument.Sarangi],
  });
  const s2 = piece.phraseGrid[0][0].trajectoryGrid[1];
  expect(s2.length).toBe(3);
  expect(sum(s2)).toBeCloseTo(10, 10);
  expect(piece.durTot).toBeCloseTo(10, 10);
});
