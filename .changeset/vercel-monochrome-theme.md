---
"@beamhop/lib": minor
"@beamhop/state": patch
---

feat(theme): Vercel/Geist-inspired monochrome refresh

Retune the design system toward a strict black-and-white "elite" aesthetic
(à la Vercel's Geist): neutral grayscale surfaces and type instead of the prior
blue-tinted glass.

- `PALETTES.White` is now canonical monochrome — ink `#171717` accent on light,
  pure `#ffffff` on dark, neutral soft tints, and an ink banner swatch. It is now
  the **default palette** (`loadPalette()` + initial store state), so the app
  opens in the monochrome look out of the box.
- `BG_BY_MODE` status-bar/`theme-color` tint follows the new `--bg-base`
  (`#fafafa` light, `#0a0a0a` dark).

The client tokens (`tokens.css`) move to a neutral Geist ramp — `#fafafa`
canvas, `#171717` ink, `#666`/`#8f8f8f` secondary text, `#eaeaea` hairlines,
soft neutral shadows — and inline card shadows drop their blue cast. Other
accent palettes (Ember/Crimson/Pine/Cobalt) ride the same neutral base.
