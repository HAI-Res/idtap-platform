// On-screen motion suppression (non-animated playhead, no wheel/touch
// scrolling, no eased dragging) for motion-sensitive users.
//
// Motion is suppressed when either
//  - the OS/browser asks for it (`prefers-reduced-motion: reduce`, e.g.
//    macOS "Reduce motion"), or
//  - the signed-in user is on the list below (useful when the OS setting is
//    off, e.g. on a borrowed machine).
//
// Both inputs can change after the editor mounts: the media query fires a
// change event, and `store.state.userID` is filled in later by NavBar's async
// session lookup. Use `suppressMotionReactive` inside a computed (or
// `useSuppressMotion`) so callers re-evaluate when either one changes.
import { ref, computed, type ComputedRef } from 'vue';
import { PlayheadAnimations } from '@shared/enums';

const motionSensitiveUserIDs = [
  '634d9506a6a3647e543b7641', // jbmyers@ucsc.edu
  '67bcba9496f2cea9ceb736c2', // jon.myers.sound@gmail.com
];

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const reducedMotionQuery = (): MediaQueryList | undefined => {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    return window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return undefined;
  }
};

const prefersReducedMotion = (): boolean => reducedMotionQuery()?.matches ?? false;

const isMotionSensitiveUser = (userID?: string | null): boolean => {
  return !!userID && motionSensitiveUserIDs.includes(userID);
};

// Non-reactive: reads the media query right now.
const suppressMotion = (userID?: string | null): boolean => {
  return prefersReducedMotion() || isMotionSensitiveUser(userID);
};

// Reactive mirror of the media query, kept current by one app-wide listener.
const reducedMotionPreferred = ref(false);
let listening = false;
const ensureListening = () => {
  if (listening) return;
  const mql = reducedMotionQuery();
  if (!mql) return;
  listening = true;
  reducedMotionPreferred.value = mql.matches;
  const onChange = (e: MediaQueryListEvent) => {
    reducedMotionPreferred.value = e.matches;
  };
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
  } else if (typeof mql.addListener === 'function') {
    // Safari < 14
    mql.addListener(onChange);
  }
};

// Reactive: reading this inside a computed/watch tracks both the media query
// and whatever reactive source `userID` came from.
const suppressMotionReactive = (userID?: string | null): boolean => {
  ensureListening();
  return reducedMotionPreferred.value || isMotionSensitiveUser(userID);
};

const useSuppressMotion = (
  getUserID: () => string | null | undefined
): ComputedRef<boolean> => {
  ensureListening();
  return computed(() => suppressMotionReactive(getUserID()));
};

// The one rule for the playhead style. While motion is suppressed the smoothly
// sliding `Animated` playhead is never allowed; any other saved choice (Block,
// DottedLine, None) is respected, and the default is Block.
const resolvePlayheadAnimation = (
  requested: PlayheadAnimations | undefined,
  suppressed: boolean
): PlayheadAnimations => {
  if (!suppressed) return requested ?? PlayheadAnimations.Animated;
  if (requested === undefined || requested === PlayheadAnimations.Animated) {
    return PlayheadAnimations.Block;
  }
  return requested;
};

const isPlayheadAnimationAllowed = (
  animation: PlayheadAnimations,
  suppressed: boolean
): boolean => !(suppressed && animation === PlayheadAnimations.Animated);

export {
  motionSensitiveUserIDs,
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  isMotionSensitiveUser,
  suppressMotion,
  suppressMotionReactive,
  useSuppressMotion,
  resolvePlayheadAnimation,
  isPlayheadAnimationAllowed,
};
