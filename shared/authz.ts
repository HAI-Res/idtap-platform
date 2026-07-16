// Centralized permission logic — the single source of truth for "who can do what"
// with a transcription / audio recording / any owned+shared document.
//
// Lives in shared/ on purpose: the SAME functions run in two places.
//   - Client (UI): disable/hide menu items, buttons, etc. Computed locally from data
//     already in memory — no round trips. This is a convenience for the user.
//   - Server (enforcement): the actual lock. The client checks are trivially bypassed
//     (curl ignores your greyed-out button), so the server must re-check every
//     identity-sensitive request. See migration-2026/A5-web-auth-plan.md.
//
// The permission model has two shapes that both appear in the DB:
//   - current: `explicitPermissions: { edit, view, publicView }`
//   - legacy:  `permissions: 'Public' | 'Publicly Editable' | 'Private' | ...`
// These helpers handle both so old documents remain correctly gated.
//
// `actorId` is a Mongo user `_id` string (what the codebase calls `userID`), or
// undefined for a logged-out visitor.

export interface ExplicitPermissions {
  edit: string[];
  view: string[];
  publicView: boolean;
}

/** Any document that carries ownership + sharing metadata. */
export interface Permissioned {
  /** owner's user _id */
  userID?: string;
  explicitPermissions?: ExplicitPermissions;
  /** legacy visibility string, present on older documents */
  permissions?: string;
}

/** True when `actorId` is the document's owner. */
export function isOwner(doc: Permissioned, actorId?: string): boolean {
  return !!actorId && !!doc.userID && doc.userID === actorId;
}

/** True when `actorId` may edit the document. */
export function canEdit(doc: Permissioned, actorId?: string): boolean {
  if (isOwner(doc, actorId)) return true;
  if (actorId && doc.explicitPermissions?.edit?.includes(actorId)) return true;
  // legacy: "Publicly Editable" means anyone (even logged-out) may edit
  if (doc.permissions === 'Publicly Editable') return true;
  return false;
}

/** True when `actorId` (or the public, when applicable) may view the document. */
export function canView(doc: Permissioned, actorId?: string): boolean {
  // anyone who can edit can view
  if (canEdit(doc, actorId)) return true;
  const ep = doc.explicitPermissions;
  if (ep?.publicView) return true;
  if (actorId && ep?.view?.includes(actorId)) return true;
  // legacy public visibility
  if (doc.permissions === 'Public' || doc.permissions === 'Publicly Editable') return true;
  return false;
}
