import type { Raga } from '@/ts/model';
import type { BoolObj } from '@shared/types';

export type PlayerTuning = {
  /** One frequency per rule-set pitch, in sargam order. Always finite. */
  freqs: number[];
  /** True when `raga.ratios` lines up with the rule set one-to-one. */
  aligned: boolean;
};

// Same walk as `Raga.sargamLetters` / `Raga.stratifiedRatios`.
const SARGAM = ['sa', 're', 'ga', 'ma', 'pa', 'dha', 'ni'];

/**
 * Frequencies for the editor's tuning table / tuning sines, one per pitch in
 * the raga's rule set, in the same order as `raga.sargamLetters` (callers zip
 * the two by index).
 *
 * The aligned/misaligned decision lives in the model: `raga.stratifiedRatios`
 * uses `raga.ratios` positionally when `ratios.length ===
 * ruleSetNumPitches`, and otherwise falls back to the raga's tuning table
 * (synced from those same ratios at save time, so existing pitches keep their
 * frequencies). We walk it in rule-set order rather than using
 * `getPitches`/`getFrequencies`, which sort by frequency: a variant tuned
 * above its neighbour (tivra ma above pa) would otherwise permute the table.
 * PROP-1: `raga.ratios` itself is left untouched.
 */
export const playerTuningFreqs = (raga: Raga): PlayerTuning => {
  const fund = raga.fundamental;
  const aligned = raga.ratios.length === raga.ruleSetNumPitches &&
    raga.ratios.every(Number.isFinite);
  if (!aligned) {
    console.warn(
      `tuningTable: raga "${raga.name}" has ${raga.ratios.length} stored ` +
      `ratio(s) but its rule set has ${raga.ruleSetNumPitches} pitch(es); ` +
      `tuning falls back to the raga tuning table (stored ratios are ` +
      `preserved, not regenerated)`,
    );
  }
  const stratified = raga.stratifiedRatios;
  const ratios: number[] = [];
  SARGAM.forEach((s, sIdx) => {
    const rule = raga.ruleSet[s];
    const r = stratified[sIdx];
    if (typeof rule === 'boolean') {
      if (rule) ratios.push(r as number);
    } else if (rule) {
      const [lowered, raised] = r as number[];
      if ((rule as BoolObj).lowered) ratios.push(lowered);
      if ((rule as BoolObj).raised) ratios.push(raised);
    }
  });
  const freqs = ratios.map(r => {
    const f = fund * r;
    return Number.isFinite(f) ? f : fund;
  });
  return { freqs, aligned };
};
