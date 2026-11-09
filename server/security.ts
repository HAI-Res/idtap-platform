// Small, dependency-free helpers for input validation and access policy on the web
// routes in server.ts / apiRoutes.ts. Kept pure (no db, no express) so they can be
// unit-tested directly — see src/ts/tests/serverSecurity.test.ts.

import { spawn, SpawnOptions } from 'child_process';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * True only for a 24-hex-character string. Use this before putting a client-supplied
 * id into a filesystem path or a child-process argv: `new ObjectId(x)` alone also
 * accepts 12-byte strings and would not stop `../` segments reaching mediaPath().
 */
export function isValidObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

/**
 * Users who may change shared reference data (e.g. overwrite an existing raga ruleset)
 * and regenerate media for any recording. Mirrors the client-side list in
 * src/comps/analysis/AnalyzerComponent.vue (the only admin notion in the codebase);
 * IDTAP_ADMIN_IDS (comma-separated Mongo user _ids) replaces it when set.
 */
const DEFAULT_ADMIN_IDS = [
  '634d9506a6a3647e543b7641',
  '67bcba9496f2cea9ceb736c2',
  '63595c60a6a3647e54a62853',
];

export function adminIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.IDTAP_ADMIN_IDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ADMIN_IDS;
  return raw.split(',').map(s => s.trim()).filter(isValidObjectId);
}

export function isAdmin(uid: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!uid && adminIds(env).includes(uid);
}

/**
 * The user fields the share/owner pickers need (UserSearch, NewCollectionModal,
 * UploadRecording and FileManager show `name <email>` and search by email; the
 * owner-transfer flow copies name/given_name/family_name; the Swift client decodes
 * picture). Everything else on a user document — sub, savedSettings,
 * transcriptionsViewed, multiQueries, waiverAgreed, ... — stays server-side.
 */
export const USER_DIRECTORY_PROJECTION = {
  _id: 1,
  name: 1,
  email: 1,
  given_name: 1,
  family_name: 1,
  picture: 1,
} as const;

/** Copy only the whitelisted directory fields (defence in depth over the projection). */
export function toUserDirectoryEntry(doc: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(USER_DIRECTORY_PROJECTION)) {
    if (doc[key] !== undefined) out[key] = doc[key];
  }
  return out;
}

/** A non-empty plain string — rejects `{ $ne: null }` style operator objects. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Run a child process to completion. Resolves with the exit code (or -1 when the
 * process could not be started / was killed by a signal); never rejects, so callers
 * can branch on `code === 0` instead of replying success on 'close' regardless.
 */
export function runToCompletion(
  command: string,
  args: string[],
  options: SpawnOptions = {},
  label = args[0] ?? command,
): Promise<number> {
  return new Promise(resolve => {
    let settled = false;
    const done = (code: number) => {
      if (!settled) { settled = true; resolve(code); }
    };
    const child = spawn(command, args, options);
    child.stdout?.on('data', data => console.log(`stdout from ${label}: ${data}`));
    child.stderr?.on('data', data => console.error(`stderr from ${label}: ${data}`));
    child.on('error', err => {
      console.error(`${label} failed to start:`, err);
      done(-1);
    });
    child.on('close', code => {
      console.log(`${label} exited with code ${code}`);
      done(code === null ? -1 : code);
    });
  });
}

/** Ownership/sharing fields that only the owner-gated endpoints may change. */
export const PROTECTED_ROOT_KEYS = ['_id', 'userID', 'permissions', 'explicitPermissions'] as const;

/**
 * Copy a client-supplied `$set` object, dropping every key whose first path segment is
 * protected (so `userID` and `explicitPermissions.edit` are both removed, while
 * `recordings.0.musicians` is kept). Non-objects yield `{}`.
 */
export function stripProtectedKeys(
  updates: unknown,
  protectedRoots: readonly string[] = PROTECTED_ROOT_KEYS,
): Record<string, any> {
  const out: Record<string, any> = {};
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return out;
  for (const [key, value] of Object.entries(updates as Record<string, any>)) {
    if (protectedRoots.includes(key.split('.')[0])) continue;
    out[key] = value;
  }
  return out;
}

/** A non-negative integer (number, or string of digits) — safe inside `recordings.${i}`. */
export function isIndex(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  return typeof value === 'string' && /^\d+$/.test(value);
}

/**
 * A string safe to use as ONE segment of a Mongo field path: non-empty, no `.`
 * (which would add segments), no leading `$` (operator), no NUL.
 */
export function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('.')
    && !value.startsWith('$') && !value.includes('\0');
}
