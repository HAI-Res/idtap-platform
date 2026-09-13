// Golden-value generator for vibrato v2 (idtap-contract PROP-6).
//
// Runs the reference TypeScript model (src/ts/model/trajectory.ts) and dumps what every
// port (Swift, Python) must reproduce: for each case, the vibObj the model settles on
// (v1 inputs are healed), compute(x) at 21 and 201 evenly spaced points, and toJSON().
//
//   pnpm genVibratoGolden        (esbuild-bundles this file and writes the JSON below;
//                                 plain tsx trips over lodash's ESM interop)
//   -> src/ts/tests/fixtures/vibrato-v2-golden.json
//
// src/ts/tests/vibratoGolden.test.ts asserts the model still matches the committed file.
// The Swift repo's scripts/gen-trajectory-golden.ts uses the same durTot / pitch
// conventions (Yaman, 246 Hz, 12-TET) so the cases can be copied across verbatim.
import { Trajectory, Pitch, Raga } from '@model';

const raga = new Raga({ name: 'Yaman', fundamental: 246.0 });
const ratios = raga.stratifiedRatios;
const f = raga.fundamental;
const P = (swara: number, oct = 0, raised = true, logOffset = 0) =>
  new Pitch({ swara, oct, raised, fundamental: f, ratios, logOffset });

type Case = { name: string; pitch: Pitch; durTot: number; vibObj?: any; note: string };

const cases: Case[] = [
  // --- v2 ---
  { name: 'vib-v2-default', pitch: P(2), durTot: 2.0,
    note: 'constructor default: 5.5 Hz, 60 c, centred, phase pi (P = 11 cycles)' },
  { name: 'vib-v2-ramp', pitch: P(2), durTot: 2.0,
    vibObj: { rate: 5.5, extentStart: 0.0, extentEnd: 0.08, vertOffset: 0.01, phase: Math.PI },
    note: 'extent blooms 0 -> 96 c; offset clamped to +-A(x) so it fades in with the ramp' },
  { name: 'vib-v2-noninteger-cycles', pitch: P(4, -1), durTot: 0.55,
    vibObj: { rate: 3.7, extentStart: 0.06, extentEnd: 0.03, vertOffset: -0.005, phase: 1.3 },
    note: 'P = 2.035 cycles, arbitrary phase: first extreme after a quarter period, last before' },
  { name: 'vib-v2-subcycle', pitch: P(0), durTot: 0.3,
    vibObj: { rate: 1, extentStart: 0.05, extentEnd: 0.05, vertOffset: 0, phase: Math.PI / 2 },
    note: 'P = 0.3 < 1 computes with P = 1 (not stored)' },
  // --- v1 inputs, healed on load (must equal the pre-PROP-6 renderer) ---
  { name: 'vib-v1-default-heals', pitch: P(2), durTot: 2.0,
    vibObj: { periods: 8, vertOffset: 0, initUp: true, extent: 0.05 },
    note: 'old default -> rate 4 Hz over 2 s' },
  { name: 'vib-v1-custom-heals', pitch: P(2), durTot: 2.0,
    vibObj: { periods: 3, vertOffset: 0.01, initUp: false, extent: 0.08 },
    note: 'same inputs as idtap-swift id13-vibrato-custom' },
  { name: 'vib-v1-clamped-offset-heals', pitch: P(6, -1), durTot: 2.0,
    vibObj: { periods: 5, vertOffset: 0.9, initUp: true, extent: 0.04 },
    note: 'same inputs as idtap-swift id13-vibrato-clamped-offset' },
  { name: 'vib-v1-string-periods-heals', pitch: P(2), durTot: 0.5,
    vibObj: { periods: '3', vertOffset: 0.01, initUp: false, extent: 0.08 },
    note: 'periods stored as a string by the old slider; Number() in the heal' },
];

const xs21 = Array.from({ length: 21 }, (_, i) => i / 20);
const xs201 = Array.from({ length: 201 }, (_, i) => i / 200);

const out = cases.map(c => {
  const json: any = {
    id: 13,
    pitches: [c.pitch.toJSON()],
    durTot: c.durTot,
    uniqueId: `u-${c.name}`,
  };
  if (c.vibObj !== undefined) json.vibObj = c.vibObj;
  // go through fromJSON so the v1 heal is exercised exactly as a stored piece would be
  const t = Trajectory.fromJSON(json, ratios, f);
  return {
    name: c.name,
    note: c.note,
    input: json,
    vibObj: t.vibObj,
    durTot: t.durTot,
    logFreqs: t.logFreqs,
    values21: xs21.map(x => t.compute(x)),
    values201: xs201.map(x => t.compute(x)),
    json: t.toJSON(),
  };
});

console.log(JSON.stringify({
  spec: 'idtap-contract PROPOSALS.md PROP-6',
  reference: 'idtap-platform/src/ts/model/trajectory.ts id13()',
  fundamental: f, ratios, xs21, xs201, cases: out,
}, null, 1));
