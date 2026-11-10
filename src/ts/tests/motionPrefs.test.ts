import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import { PlayheadAnimations } from '@shared/enums';

const SENSITIVE_ID = '67bcba9496f2cea9ceb736c2';

type Listener = (e: { matches: boolean }) => void;

const fakeMatchMedia = (initial: boolean) => {
  const listeners: Listener[] = [];
  const mql = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, cb: Listener) => listeners.push(cb),
    removeEventListener: () => {},
  };
  const set = (matches: boolean) => {
    mql.matches = matches;
    listeners.forEach(cb => cb({ matches }));
  };
  return { matchMedia: vi.fn(() => mql), set };
};

const load = async () => {
  vi.resetModules();
  return await import('@/js/motionPrefs');
};

describe('motionPrefs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('without a window (SSR / node)', () => {
    test('falls back to the user ID list', async () => {
      const m = await load();
      expect(m.prefersReducedMotion()).toBe(false);
      expect(m.suppressMotion(undefined)).toBe(false);
      expect(m.suppressMotion('someone-else')).toBe(false);
      expect(m.suppressMotion(SENSITIVE_ID)).toBe(true);
    });
  });

  describe('with prefers-reduced-motion', () => {
    let fake: ReturnType<typeof fakeMatchMedia>;
    beforeEach(() => {
      fake = fakeMatchMedia(true);
      vi.stubGlobal('window', { matchMedia: fake.matchMedia });
    });

    test('suppresses motion for any user when the OS asks for it', async () => {
      const m = await load();
      expect(m.suppressMotion(undefined)).toBe(true);
      expect(m.suppressMotion('someone-else')).toBe(true);
    });

    test('reactive value follows media query changes and userID arriving late', async () => {
      const m = await load();
      fake.set(false);
      const userID = ref<string | undefined>(undefined);
      const suppressed = m.useSuppressMotion(() => userID.value);
      expect(suppressed.value).toBe(false);

      // NavBar's async getSession fills in the user later.
      userID.value = SENSITIVE_ID;
      expect(suppressed.value).toBe(true);

      userID.value = 'someone-else';
      expect(suppressed.value).toBe(false);

      // OS "Reduce motion" toggled on while the editor is open.
      const seen: boolean[] = [];
      watch(suppressed, v => seen.push(v));
      fake.set(true);
      await nextTick();
      expect(suppressed.value).toBe(true);
      expect(seen).toEqual([true]);
    });
  });
});

describe('resolvePlayheadAnimation', () => {
  test('never allows Animated while suppressed; default Block', async () => {
    const { resolvePlayheadAnimation } = await load();
    expect(resolvePlayheadAnimation(PlayheadAnimations.Animated, true))
      .toBe(PlayheadAnimations.Block);
    expect(resolvePlayheadAnimation(undefined, true)).toBe(PlayheadAnimations.Block);
  });

  test('respects a saved Block or DottedLine choice while suppressed', async () => {
    const { resolvePlayheadAnimation } = await load();
    expect(resolvePlayheadAnimation(PlayheadAnimations.Block, true))
      .toBe(PlayheadAnimations.Block);
    expect(resolvePlayheadAnimation(PlayheadAnimations.DottedLine, true))
      .toBe(PlayheadAnimations.DottedLine);
    expect(resolvePlayheadAnimation(PlayheadAnimations.None, true))
      .toBe(PlayheadAnimations.None);
  });

  test('leaves the choice alone when motion is not suppressed', async () => {
    const { resolvePlayheadAnimation, isPlayheadAnimationAllowed } = await load();
    expect(resolvePlayheadAnimation(PlayheadAnimations.Animated, false))
      .toBe(PlayheadAnimations.Animated);
    expect(resolvePlayheadAnimation(PlayheadAnimations.DottedLine, false))
      .toBe(PlayheadAnimations.DottedLine);
    expect(isPlayheadAnimationAllowed(PlayheadAnimations.Animated, false)).toBe(true);
    expect(isPlayheadAnimationAllowed(PlayheadAnimations.Animated, true)).toBe(false);
    expect(isPlayheadAnimationAllowed(PlayheadAnimations.Block, true)).toBe(true);
  });
});
