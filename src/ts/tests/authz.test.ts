import { describe, it, expect } from 'vitest';
import { isOwner, canEdit, canView, Permissioned } from '@shared/authz';

const OWNER = 'ownerId';
const EDITOR = 'editorId';
const VIEWER = 'viewerId';
const STRANGER = 'strangerId';

// current-shape document: owner + explicit editor/viewer, not public
const explicitDoc: Permissioned = {
  userID: OWNER,
  explicitPermissions: { edit: [EDITOR], view: [VIEWER], publicView: false },
};

const publicViewDoc: Permissioned = {
  userID: OWNER,
  explicitPermissions: { edit: [], view: [], publicView: true },
};

describe('authz.isOwner', () => {
  it('is true only for the owner', () => {
    expect(isOwner(explicitDoc, OWNER)).toBe(true);
    expect(isOwner(explicitDoc, EDITOR)).toBe(false);
    expect(isOwner(explicitDoc, undefined)).toBe(false);
  });
});

describe('authz.canEdit', () => {
  it('allows owner and explicit editors, denies viewers/strangers/anon', () => {
    expect(canEdit(explicitDoc, OWNER)).toBe(true);
    expect(canEdit(explicitDoc, EDITOR)).toBe(true);
    expect(canEdit(explicitDoc, VIEWER)).toBe(false);
    expect(canEdit(explicitDoc, STRANGER)).toBe(false);
    expect(canEdit(explicitDoc, undefined)).toBe(false);
  });

  it('publicView does NOT grant edit', () => {
    expect(canEdit(publicViewDoc, STRANGER)).toBe(false);
    expect(canEdit(publicViewDoc, undefined)).toBe(false);
  });
});

describe('authz.canView', () => {
  it('allows owner, editors, explicit viewers; denies strangers/anon on private docs', () => {
    expect(canView(explicitDoc, OWNER)).toBe(true);
    expect(canView(explicitDoc, EDITOR)).toBe(true);
    expect(canView(explicitDoc, VIEWER)).toBe(true);
    expect(canView(explicitDoc, STRANGER)).toBe(false);
    expect(canView(explicitDoc, undefined)).toBe(false);
  });

  it('publicView lets anyone (including anon) view', () => {
    expect(canView(publicViewDoc, STRANGER)).toBe(true);
    expect(canView(publicViewDoc, undefined)).toBe(true);
  });
});

describe('authz collection-style permissions (object form)', () => {
  const coll: Permissioned = {
    userID: OWNER,
    permissions: { view: [VIEWER], edit: [EDITOR] },
  };
  it('owner and edit-list can edit; view-list and strangers cannot', () => {
    expect(canEdit(coll, OWNER)).toBe(true);
    expect(canEdit(coll, EDITOR)).toBe(true);
    expect(canEdit(coll, VIEWER)).toBe(false);
    expect(canEdit(coll, STRANGER)).toBe(false);
  });
  it('owner, edit-list, and view-list can view; strangers/anon cannot', () => {
    expect(canView(coll, OWNER)).toBe(true);
    expect(canView(coll, EDITOR)).toBe(true);
    expect(canView(coll, VIEWER)).toBe(true);
    expect(canView(coll, STRANGER)).toBe(false);
    expect(canView(coll, undefined)).toBe(false);
  });
});

describe('authz legacy permissions strings', () => {
  it("'Public' grants view to all but edit to none (except owner)", () => {
    const doc: Permissioned = { userID: OWNER, permissions: 'Public' };
    expect(canView(doc, STRANGER)).toBe(true);
    expect(canView(doc, undefined)).toBe(true);
    expect(canEdit(doc, STRANGER)).toBe(false);
    expect(canEdit(doc, OWNER)).toBe(true);
  });

  it("'Publicly Editable' grants both view and edit to all", () => {
    const doc: Permissioned = { userID: OWNER, permissions: 'Publicly Editable' };
    expect(canView(doc, STRANGER)).toBe(true);
    expect(canEdit(doc, STRANGER)).toBe(true);
    expect(canEdit(doc, undefined)).toBe(true);
  });

  it("'Private' (or absent metadata) grants nothing to non-owners", () => {
    const priv: Permissioned = { userID: OWNER, permissions: 'Private' };
    const bare: Permissioned = { userID: OWNER };
    for (const doc of [priv, bare]) {
      expect(canView(doc, STRANGER)).toBe(false);
      expect(canView(doc, undefined)).toBe(false);
      expect(canEdit(doc, STRANGER)).toBe(false);
      expect(isOwner(doc, OWNER)).toBe(true);
      expect(canView(doc, OWNER)).toBe(true);
    }
  });
});
