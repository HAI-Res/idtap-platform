import { expect, test } from 'vitest';
import { valueCurveSampleCount } from '../utils';

const valueDur = 0.02;

// `setValueCurveAtTime` needs at least two points, and synth code samples the
// trajectory at `i / (count - 1)`, which is NaN when the count is one.
test('valueCurveSampleCount never returns fewer than two points', () => {
  const durations = [
    0,
    1e-12,
    0.005,
    0.01,
    0.02,
    0.029,
    0.03,           // 0.03 / 0.02 === 1.4999999999999998, rounds down to 1
    0.03 + 1e-15,   // ...while the same nominal length can round up to 2
  ];
  durations.forEach(dur => {
    const ct = valueCurveSampleCount(dur, valueDur);
    expect(ct).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < ct; i++) {
      expect(Number.isFinite(i / (ct - 1))).toBe(true);
    }
  });
});

test('valueCurveSampleCount is unchanged for longer durations', () => {
  expect(valueCurveSampleCount(0.1, valueDur)).toBe(5);
  expect(valueCurveSampleCount(1, valueDur)).toBe(50);
  expect(valueCurveSampleCount(0.05, valueDur)).toBe(3);
});
