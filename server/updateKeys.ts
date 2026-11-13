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
