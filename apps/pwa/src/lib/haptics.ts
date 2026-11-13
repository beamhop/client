/**
 * haptic(kind) — DESIGN §8.5. Best effort, never on scroll/streaming, at most once per 120ms.
 * Android/Chromium: navigator.vibrate. iOS Safari 18+: the hidden `<input type=checkbox switch>`
 * toggle technique (must be called inside a user gesture). Respects the in-app Haptics setting.
 */
import { getAppearance } from './appearance.ts';

export type HapticKind = 'tick' | 'confirm' | 'reject' | 'warn' | 'error';

export const HAPTIC_PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 8,
  confirm: 12,
  reject: [6, 40, 6],
  warn: [20, 60, 20],
  error: [30, 50, 30],
};

let last = 0;
let iosSwitch: HTMLLabelElement | null = null;

const iosToggle = () => {
  if (typeof document === 'undefined') return;
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText =
      'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  iosSwitch.click();
};

const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in globalThis));

export const haptic = (kind: HapticKind): boolean => {
  if (!getAppearance().haptics) return false;
  const now = Date.now();
  if (now - last < 120) return false;
  last = now;
  const pattern = HAPTIC_PATTERNS[kind];
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' && !isIOS()) {
    try {
      return navigator.vibrate(pattern);
    } catch {
      return false;
    }
  }
  if (isIOS()) {
    iosToggle();
    return true;
  }
  return false;
};

/** Test hook. */
export const __resetHaptics = () => {
  last = 0;
};
