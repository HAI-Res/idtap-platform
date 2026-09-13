/**
 * Vibrato v2 golden values (idtap-contract PROP-6).
 *
 * `fixtures/vibrato-v2-golden.json` is produced by `pnpm genVibratoGolden` from the
 * reference model. The Swift and Python ports reproduce it; this test guards the
 * reference itself against drift. If id13 changes on purpose, regenerate the file
 * in the same commit and tell the downstream ports.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Trajectory } from '../model/trajectory';

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures/vibrato-v2-golden.json'), 'utf-8'));

describe('vibrato v2 golden (PROP-6)', () => {
  expect(golden.cases.length).toBe(8);
  for (const c of golden.cases) {
    test(c.name, () => {
      const t = Trajectory.fromJSON(c.input, golden.ratios, golden.fundamental);
      expect(t.vibObj).toEqual(c.vibObj);
      expect('periods' in t.vibObj).toBe(false);
      expect(t.durTot).toBe(c.durTot);
      expect(t.logFreqs).toEqual(c.logFreqs);
      golden.xs21.forEach((x: number, i: number) => expect(t.compute(x)).toBe(c.values21[i]));
      golden.xs201.forEach((x: number, i: number) => expect(t.compute(x)).toBe(c.values201[i]));
      expect(JSON.parse(JSON.stringify(t.toJSON()))).toEqual(JSON.parse(JSON.stringify(c.json)));
      // the curve attaches at the notated pitch at both ends
      expect(c.values201[0]).toBeCloseTo(2 ** c.logFreqs[0], 9);
      expect(c.values201[200]).toBeCloseTo(2 ** c.logFreqs[0], 9);
    });
  }
});
