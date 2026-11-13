/**
 * Body keys that must never reach a MongoDB update. The save routes copy body
 * keys into $set and exclude owner-only fields by exact name, so a dotted key
 * ("explicitPermissions.edit") or an operator ("$rename") would get past that
 * and let an editor change what only the owner may. Refuse them outright.
 */
export function unsafeUpdateKeys(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter(k => k.includes('.') || k.startsWith('$') || k.includes('\0'));
}

export const UNSAFE_KEYS_ERROR = (keys: string[]) =>
  ({ error: `field names may not contain "." or start with "$": ${keys.slice(0, 5).join(', ')}` });

/** Fields no recording save may set; ownership and parent links have their own routes. */
const RECORDING_LOCKED = ['_id', 'userID', 'parentID', 'parentTrackNumber'];
/** Sharing fields only the recording's owner may change. */
const RECORDING_OWNER_ONLY = ['permissions', 'explicitPermissions'];

/**
 * The `updates` of an /updateAudioRecording body, minus what this actor may not
 * set. An editor who is not the owner keeps every metadata change but cannot
 * touch sharing, even though the edit form round-trips explicitPermissions.
 */
export function recordingUpdates(updates: unknown, owner: boolean): Record<string, unknown> {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return {};
  const drop = owner ? RECORDING_LOCKED : [...RECORDING_LOCKED, ...RECORDING_OWNER_ONLY];
  return Object.fromEntries(Object.entries(updates).filter(([k]) => !drop.includes(k)));
}
