/**
 * One side of the PROP-8 dry run, bundled twice by run.sh: against origin/main's
 * model (A) and against this branch's model (B). Both expose the same function.
 */
import { Piece } from '@model';

export type Mode = 'A' | 'B' | 'B-flag-off';

/** Load a stored document and save it again, as the given client would. */
export function loadSave(doc: any, mode: Mode): { out: any; violations: [string, string][] | null } {
  const piece = Piece.fromJSON(doc);
  // B: the full 0.3.0 save (heal persisted, dual-write), as the gate defines it.
  // B-flag-off: what the web app will actually do while the flag is off.
  if (mode === 'B') (piece as any).persistSyllables = 'all';
  const out = JSON.parse(JSON.stringify(piece));
  return { out, violations: (piece as any).syllableViolations ?? null };
}
