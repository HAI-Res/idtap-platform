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
 * legacy fields that cannot rebuild it. Reasons come from legacySafe().
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
 * Decide whether a save may overwrite `stored` (the document as it is in the
 * database). Logs every refusal with the client value and the reasons; the
 * rollout watches those lines.
 */
export function checkWriteGuard(stored: any, clientHeader: string | undefined, id?: unknown): GuardResult {
  if (clientKnowsSyllables(clientHeader)) return { ok: true };
  if (!stored || !Array.isArray(stored.phraseGrid)) return { ok: true };
  let safe: boolean;
  let reasons: string[];
  try {
    [safe, reasons] = legacySafe(stored);
  } catch (err) {
    // A document the reference rules cannot read (e.g. a row-0 trajectory with
    // no uniqueId in a tiered phrase). Refusing would block a save for a reason
    // the contract does not define, so let it through and say so.
    console.warn(`write-guard: could not evaluate ${String(id)} (client=${clientHeader ?? '-'}):`, err);
    return { ok: true };
  }
  if (safe) return { ok: true };
  console.warn(`write-guard: refused save of ${String(id)} client=${clientHeader ?? '-'} reasons=${reasons.join(',')}`);
  return {
    ok: false,
    status: 409,
    body: { error: 'write-guard', reasons, minContract: MIN_TIER_CONTRACT },
  };
}
