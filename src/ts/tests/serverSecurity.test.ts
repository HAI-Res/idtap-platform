import { describe, test, expect } from 'vitest';
import {
  isValidObjectId,
  isAdmin,
  adminIds,
  isNonEmptyString,
  isIndex,
  isSafePathSegment,
  stripProtectedKeys,
  toUserDirectoryEntry,
  USER_DIRECTORY_PROJECTION,
  runToCompletion,
} from '../../../server/security';

describe('isValidObjectId', () => {
  test('accepts 24 hex chars in either case', () => {
    expect(isValidObjectId('634d9506a6a3647e543b7641')).toBe(true);
    expect(isValidObjectId('634D9506A6A3647E543B7641')).toBe(true);
  });

  test('rejects path traversal, 12-byte strings, operators and non-strings', () => {
    expect(isValidObjectId('../../etc/passwd')).toBe(false);
    expect(isValidObjectId('../../../etc')).toBe(false); // 12 chars: new ObjectId() would take it
    expect(isValidObjectId('634d9506a6a3647e543b764')).toBe(false); // 23
    expect(isValidObjectId('634d9506a6a3647e543b76411')).toBe(false); // 25
    expect(isValidObjectId('634d9506a6a3647e543b764g')).toBe(false);
    expect(isValidObjectId('634d9506a6a3647e543b7641/')).toBe(false);
    expect(isValidObjectId({ $ne: null })).toBe(false);
    expect(isValidObjectId(['634d9506a6a3647e543b7641'])).toBe(false);
    expect(isValidObjectId(undefined)).toBe(false);
    expect(isValidObjectId(0)).toBe(false);
  });
});

describe('isNonEmptyString', () => {
  test('only plain non-empty strings pass', () => {
    expect(isNonEmptyString('abc')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString({ $ne: null })).toBe(false);
    expect(isNonEmptyString({ $regex: '.*' })).toBe(false);
    expect(isNonEmptyString(['a'])).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
  });
});

describe('isIndex', () => {
  test('non-negative integers as numbers or digit strings', () => {
    expect(isIndex(0)).toBe(true);
    expect(isIndex(3)).toBe(true);
    expect(isIndex('12')).toBe(true);
    expect(isIndex(-1)).toBe(false);
    expect(isIndex(1.5)).toBe(false);
    expect(isIndex('1.userID')).toBe(false);
    expect(isIndex('')).toBe(false);
    expect(isIndex(undefined)).toBe(false);
  });
});

describe('isSafePathSegment', () => {
  test('rejects dots, operators and empties', () => {
    expect(isSafePathSegment('Asia')).toBe(true);
    expect(isSafePathSegment('United States')).toBe(true);
    expect(isSafePathSegment('Asia.India')).toBe(false);
    expect(isSafePathSegment('$where')).toBe(false);
    expect(isSafePathSegment('')).toBe(false);
    expect(isSafePathSegment({})).toBe(false);
  });
});

describe('isAdmin / adminIds', () => {
  test('defaults to the client-side admin list', () => {
    expect(isAdmin('634d9506a6a3647e543b7641', {})).toBe(true);
    expect(isAdmin('000000000000000000000000', {})).toBe(false);
    expect(isAdmin(undefined, {})).toBe(false);
  });

  test('IDTAP_ADMIN_IDS replaces the list and drops malformed ids', () => {
    const env = { IDTAP_ADMIN_IDS: ' 000000000000000000000001 , junk ,' };
    expect(adminIds(env)).toEqual(['000000000000000000000001']);
    expect(isAdmin('000000000000000000000001', env)).toBe(true);
    expect(isAdmin('634d9506a6a3647e543b7641', env)).toBe(false);
  });
});

describe('stripProtectedKeys', () => {
  test('drops ownership/sharing roots, including dotted paths under them', () => {
    const out = stripProtectedKeys({
      _id: 'x',
      userID: 'attacker',
      permissions: 'Public',
      explicitPermissions: { edit: ['attacker'] },
      'explicitPermissions.edit': ['attacker'],
      name: 'kept',
      'recordings.0.musicians': { a: 1 },
    });
    expect(out).toEqual({ name: 'kept', 'recordings.0.musicians': { a: 1 } });
  });

  test('custom roots and non-object input', () => {
    expect(stripProtectedKeys({ userID: 'u', explicitPermissions: {} }, ['userID']))
      .toEqual({ explicitPermissions: {} });
    expect(stripProtectedKeys(undefined)).toEqual({});
    expect(stripProtectedKeys('x')).toEqual({});
    expect(stripProtectedKeys([1, 2])).toEqual({});
  });
});

describe('user directory projection', () => {
  test('keeps only what the share pickers need', () => {
    const fullDoc = {
      _id: 'u1', name: 'A B', email: 'a@b.c', given_name: 'A', family_name: 'B',
      picture: 'p', sub: 'google-sub', savedSettings: [{}], transcriptionsViewed: {},
      multiQueries: [], waiverAgreed: true, transcriptions: [],
    };
    expect(toUserDirectoryEntry(fullDoc)).toEqual({
      _id: 'u1', name: 'A B', email: 'a@b.c', given_name: 'A', family_name: 'B', picture: 'p',
    });
    expect(Object.keys(USER_DIRECTORY_PROJECTION)).not.toContain('sub');
  });
});

describe('runToCompletion', () => {
  test('resolves with the exit code', async () => {
    expect(await runToCompletion(process.execPath, ['-e', 'process.exit(0)'])).toBe(0);
    expect(await runToCompletion(process.execPath, ['-e', 'process.exit(3)'])).toBe(3);
  });

  test('resolves -1 when the command cannot start', async () => {
    expect(await runToCompletion('/nonexistent/definitely-not-a-binary', [])).toBe(-1);
  });
});
