// beamhop theme boot (runs before first paint; kept in sync with src/lib/appearance.ts).
(() => {
  var s = {};
  try {
    s = JSON.parse(localStorage.getItem('bh.appearance') || '{}') || {};
  } catch (_e) {}
  var mq = (q) => window.matchMedia?.(q).matches;
  var theme =
    s.theme && s.theme !== 'system' ? s.theme : mq('(prefers-color-scheme: dark)') ? 'dark' : 'light';
  var contrast =
    s.contrast && s.contrast !== 'system' ? s.contrast : mq('(prefers-contrast: more)') ? 'more' : 'normal';
  var motion =
    s.motion && s.motion !== 'system'
      ? s.motion
      : mq('(prefers-reduced-motion: reduce)')
        ? 'reduced'
        : 'full';
  var r = document.documentElement;
  r.dataset.theme = theme;
  r.dataset.contrast = contrast;
  r.dataset.motion = motion;
})();
