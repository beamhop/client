/**
 * Screen-reader announcements (DESIGN §12). Exactly two regions exist, rendered by <LiveRegions/>
 * in the app shell: `#bh-live-polite` (status, toasts, copy confirmations) and `#bh-live-assertive`
 * (panic and approval auto-deny under 60 s only).
 */
export type Politeness = 'polite' | 'assertive';

export const announce = (message: string, politeness: Politeness = 'polite'): void => {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(politeness === 'assertive' ? 'bh-live-assertive' : 'bh-live-polite');
  if (!el) return;
  // Clear then set on the next frame so repeated identical messages are re-announced.
  el.textContent = '';
  window.setTimeout(() => {
    el.textContent = message;
  }, 30);
};
