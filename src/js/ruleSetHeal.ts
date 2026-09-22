import type { RuleSetType } from '@shared/types';

// Structural: accepts raw piece JSON as well as a (not-yet-hydrated) Piece.
type RagaJson = { name: string; ruleSet?: RuleSetType | null };
type PieceJson = { raga: RagaJson };
type RuleFetcher = (name: string) => Promise<{ rules?: RuleSetType } | null | undefined>;

/**
 * True when the serialized raga already carries a usable rule set (PROP-1:
 * `ruleSet` travels with `ratios` in the piece precisely so the piece is
 * self-describing).
 */
export const hasStoredRuleSet = (raga: RagaJson | undefined | null): boolean => {
  const rs = raga?.ruleSet;
  return !!rs && typeof rs === 'object' && Object.keys(rs).length > 0;
};

const numPitches = (rules: RuleSetType): number =>
  Object.values(rules).reduce<number>((n, v) => {
    if (typeof v === 'boolean') return n + (v ? 1 : 0);
    return n + (v.lowered ? 1 : 0) + (v.raised ? 1 : 0);
  }, 0);

/**
 * Legacy heal for pieces saved before `ruleSet` was serialized: fetch the
 * raga's current DB rule set by name and inject it before `Piece.fromJSON`.
 *
 * A stored rule set is NEVER overwritten. The DB rules for a raga name can
 * change after a piece was saved (Yaman gained komal ma on 2025-10-02); the
 * piece's `ratios` are indexed against the rule set it was saved with, so
 * grafting the current DB rules onto it misaligns every pitch and used to
 * crash the audio player (`setValueAtTime` on an undefined frequency).
 *
 * Mutates and returns `piece`. The fetcher is injected so this is testable
 * without the network.
 */
export const healLegacyRuleSet = async (
  piece: PieceJson,
  fetchRules: RuleFetcher,
): Promise<PieceJson> => {
  if (!piece.raga) return piece;
  if (hasStoredRuleSet(piece.raga)) return piece;
  const rsRes = await fetchRules(piece.raga.name);
  if (rsRes && rsRes.rules) {
    piece.raga.ruleSet = rsRes.rules;
    const ratios = (piece.raga as { ratios?: unknown }).ratios;
    if (Array.isArray(ratios) && ratios.length !== numPitches(rsRes.rules)) {
      // The DB rules for this name changed since the piece was saved. The
      // Raga ctor keeps the ratios (PROP-1) and the audio player degrades to
      // the tuning table; this warning is the breadcrumb for fixing the data.
      console.warn(
        `ruleSetHeal: legacy piece for raga "${piece.raga.name}" has ` +
        `${ratios.length} ratio(s) but the DB rule set has ` +
        `${numPitches(rsRes.rules)} pitch(es); pitches will load from the ` +
        `tuning table. Consider assigning the piece to a raga variant.`,
      );
    }
  } else {
    console.warn(
      `ruleSetHeal: no stored ruleSet on piece and no DB rules for raga ` +
      `"${piece.raga.name}"; Raga will fall back to its default rule set`,
    );
  }
  return piece;
};
