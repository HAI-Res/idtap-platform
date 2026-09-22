import type { Raga } from '@/ts/model';

export type PlayerTuning = {
  /** One frequency per rule-set pitch, in sargam order. Always finite. */
  freqs: number[];
  /** True when `raga.ratios` lines up with the rule set one-to-one. */
  aligned: boolean;
};

/**
 * Frequencies for the editor's tuning table / tuning sines, one per pitch in
 * the raga's rule set (i.e. one per entry of `raga.sargamLetters`).
 *
 * When `raga.ratios` matches the rule set positionally this is simply
 * `fundamental * ratio`. When it does not — a transcription saved against an
 * older rule set for the same raga name — the stored ratios cannot be mapped
 * onto the current pitches by index, so we fall back to the raga's tuning
 * table via `getPitches`, which holds a value for every variant (and was
 * synced from those same ratios at save time, so existing pitches keep their
 * frequencies). PROP-1: `raga.ratios` itself is left untouched.
 */
export const playerTuningFreqs = (raga: Raga): PlayerTuning => {
  const n = raga.sargamLetters.length;
  const stored = raga.ratios.map(r => raga.fundamental * r);
  const aligned = stored.length === n && stored.every(Number.isFinite);
  if (aligned) return { freqs: stored, aligned: true };

  console.warn(
    `tuningTable: raga "${raga.name}" has ${raga.ratios.length} stored ` +
    `ratio(s) but its rule set has ${n} pitch(es); tuning falls back to the ` +
    `raga tuning table (stored ratios are preserved, not regenerated)`,
  );
  const fund = raga.fundamental;
  const fallback = raga
    .getPitches({ low: fund, high: fund * 1.999 })
    .map(p => p.frequency);
  const freqs = [...Array(n)].map((_, i) => {
    const f = fallback[i];
    return Number.isFinite(f) ? f : fund;
  });
  return { freqs, aligned: false };
};
