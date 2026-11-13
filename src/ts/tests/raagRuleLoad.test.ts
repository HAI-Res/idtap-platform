import { expect, test, describe } from 'vitest';
import { raagLoadState } from '@/js/raagRuleLoad';

// RaagEditor review fix: a failed rule fetch for a newly selected raga used
// to leave raga A's rules/loadedRules in place, so save() saw no change and
// wrote A's rules under B's name with no overwrite warning.

const template = {
  sa: true,
  re: { lowered: false, raised: false },
  ga: { lowered: false, raised: false },
  ma: { lowered: false, raised: false },
  pa: true,
  dha: { lowered: false, raised: false },
  ni: { lowered: false, raised: false },
};
const yaman = {
  ...template,
  re: { lowered: false, raised: true },
  ga: { lowered: false, raised: true },
  ma: { lowered: false, raised: true },
  dha: { lowered: false, raised: true },
  ni: { lowered: false, raised: true },
};

describe('raagLoadState', () => {
  test('failed fetch (undefined) → loadFailed, no loadedRules, template rules', () => {
    const st = raagLoadState(undefined, template);
    expect(st.loadFailed).toBe(true);
    expect(st.loadedRules).toBeUndefined();
    expect(st.rules).toEqual(template);
    expect(st.rules).not.toBe(template);
    expect(st.savedMsg).toMatch(/could not load/);
  });

  test('no doc for the name (null) → new raga, saveable', () => {
    const st = raagLoadState(null, template);
    expect(st.loadFailed).toBe(false);
    expect(st.loadedRules).toBeUndefined();
    expect(st.rules).toEqual(template);
    expect(st.savedMsg).toBe('unsaved');
  });

  test('doc without rules → new raga, saveable', () => {
    const st = raagLoadState({ updatedDate: '2025-10-02' }, template);
    expect(st.loadFailed).toBe(false);
    expect(st.loadedRules).toBeUndefined();
  });

  test('loaded doc → rules and loadedRules are independent copies', () => {
    const res = { rules: yaman, updatedDate: '2025-10-02T00:00:00Z' };
    const st = raagLoadState(res, template);
    expect(st.loadFailed).toBe(false);
    expect(st.rules).toEqual(yaman);
    expect(st.loadedRules).toEqual(yaman);
    expect(st.rules).not.toBe(st.loadedRules);
    expect(st.rules).not.toBe(yaman);
    expect(st.savedMsg).toMatch(/^Saved: /);
  });
});
