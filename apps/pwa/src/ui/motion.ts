/** Motion springs (DESIGN §8.2). Frequent actions get no motion at all. */
import type { Transition } from 'motion/react';
import { useReducedMotion } from 'motion/react';
import { useAppearance } from '../lib/appearance.ts';

export const spring = {
  snap: { type: 'spring', visualDuration: 0.18, bounce: 0 }, // toggles, segmented thumb, chip select
  settle: { type: 'spring', visualDuration: 0.32, bounce: 0.12 }, // card snapping back, list reorder
  sheet: { type: 'spring', visualDuration: 0.36, bounce: 0.06 }, // bottom sheet open/close, drawer
  throw: { type: 'spring', visualDuration: 0.42, bounce: 0.18 }, // swipe card fly-out (velocity-inherited)
  push: { type: 'spring', visualDuration: 0.28, bounce: 0 }, // detail pane push/pop
} satisfies Record<string, Transition>;

export const reduced: Transition = { type: 'tween', duration: 0.12, ease: [0.2, 0, 0, 1] };

/** True when the OS asks for reduced motion OR the in-app setting says Reduced. */
export const useReduced = (): boolean => {
  const os = useReducedMotion();
  const [, resolved] = useAppearance();
  return !!os || resolved.motion === 'reduced';
};
