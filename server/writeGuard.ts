/**
 * PROP-8 write guard (idtap-contract 0.3.0) and the X-IDTAP-Client header.
 *
 * X-IDTAP-Client is `<client>/<contract-semver>` with client one of web, python,
 * swift (e.g. `web/0.3.0`); the version is the CONTRACT version the client
 * implements, not its package version. Bare `web` is what pre-0.3.0 web tabs
 * (and earlier Swift builds) send. No header, bare `web`, an unparseable value
 * or a version below 0.3.0 all count as a pre-0.3.0 client.
 *
 * A save from a pre-0.3.0 client is refused (HTTP 409) when the STORED piece is
 * not legacy-safe: that client would drop the syllable tier, or keep only
 * legacy fields that cannot rebuild it. Reasons come from legacySafe(), plus
 * 'unreadable' when the stored tier cannot be read at all (fail closed).
 */
import { legacySafe, clientKnowsSyllables, parseClientHeader } from '../shared/syllables';

export const MIN_TIER_CONTRACT = '0.3.0';

/** The CSRF header check: bare `web` or any well-formed `<client>/<semver>`. */
export function validClientHeader(h: string | undefined): boolean {
  return parseClientHeader(h) !== null;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 409; body: { error: 'write-guard'; reasons: string[]; minContract: string } };

/**
 * Whether a stored document carries anything a pre-0.3.0 save could destroy:
 * a non-empty (or unreadable) syllable list on any phrase, or a phonology
 * other than hindi-urdu. Tolerates any shape (null tracks, null phrases).
 */
export function storedTierPresent(stored: any): boolean {
  const ph = stored?.system?.phonology;
  if (ph !== undefined && ph !== null && ph !== 'hindi-urdu') return true;
  const grid = Array.isArray(stored?.phraseGrid) ? stored.phraseGrid : [];
  return grid.some((track: any) => Array.isArray(track) && track.some((p: any) => {
    const syl = p && typeof p === 'object' ? p.syllables : undefined;
    if (syl === undefined || syl === null) return false;
    return !Array.isArray(syl) || syl.length > 0;
  }));
}

const refuse = (reasons: string[]): GuardResult => ({
  ok: false,
  status: 409,
  body: { error: 'write-guard', reasons, minContract: MIN_TIER_CONTRACT },
});

/**
 * Decide whether a save may overwrite `stored` (the document as it is in the
 * database). Logs every refusal with the client value and the reasons; the
 * rollout watches those lines.
 *
 * Fails CLOSED: when the stored document cannot be read by the rules (a
 * syllable without an anchor, a null track, ...), the save is refused with
 * reason 'unreadable' unless the document is truly untiered.
 */
export function checkWriteGuard(stored: any, clientHeader: string | undefined, id?: unknown): GuardResult {
  if (clientKnowsSyllables(clientHeader)) return { ok: true };
  if (!stored) return { ok: true };
  const client = clientHeader ?? '-';
  if (!Array.isArray(stored.phraseGrid)) {
    if (!storedTierPresent(stored)) return { ok: true };
    console.warn(`write-guard: refused save of ${String(id)} client=${client} reasons=unreadable (no phraseGrid)`);
    return refuse(['unreadable']);
  }
  let safe: boolean;
  let reasons: string[];
  try {
    [safe, reasons] = legacySafe(stored);
  } catch (err) {
    if (!storedTierPresent(stored)) {
      console.warn(`write-guard: could not evaluate ${String(id)} (client=${client}); untiered, allowed:`, String(err));
      return { ok: true };
    }
    console.warn(`write-guard: refused save of ${String(id)} client=${client} reasons=unreadable (${String(err)})`);
    return refuse(['unreadable']);
  }
  if (safe) return { ok: true };
  console.warn(`write-guard: refused save of ${String(id)} client=${client} reasons=${reasons.join(',')}`);
  return refuse(reasons);
}
