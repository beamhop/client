# `@beamhop/lib`

Pure utility functions for the Beamhop client. Zero framework dependencies at runtime — React is a peer dep only for the gesture and hook helpers.

## Install

```ts
// package.json — consumed by workspace siblings automatically
"@beamhop/lib": "workspace:*"
```

## API

### Format

```ts
import { formatDate, truncate, niceNumber } from "@beamhop/lib";

formatDate(1700000000);    // "Nov 14, 2023"
truncate("long text", 20); // "long text…"
niceNumber(12345);         // "12.3K"
```

### Mute rules

```ts
import { createRule, compileMutes, matchesMute } from "@beamhop/lib";
import type { MuteRule, MuteSettings } from "@beamhop/lib";

const settings: MuteSettings = {
  rules: [createRule("word", "spam")],
  flags: { hideReposts: false, hideReplies: false },
};

const compiled = compileMutes(settings);
matchesMute(compiled, event); // true | false
```

### Theme

```ts
import { buildCssVars, PALETTES } from "@beamhop/lib";
import type { Palette, ColorMode } from "@beamhop/lib";

const css = buildCssVars("violet" as Palette, "dark" as ColorMode);
document.documentElement.style.cssText = css;
```

### Markdown

```ts
import { parseMarkdown, extractToc } from "@beamhop/lib";

const html = parseMarkdown("# Hello\n\nWorld");
const toc = extractToc("# H1\n## H2");
```

### Haptics

```ts
import { haptic, setHapticsEnabled, isHapticsEnabled } from "@beamhop/lib";
import type { HapticIntent } from "@beamhop/lib";

setHapticsEnabled(true);
haptic("like");   // fires the system haptic for a like action
haptic("post");
haptic("repost");
```

### Gestures (React hook)

```ts
import { useSwipe } from "@beamhop/lib";

function Card() {
  const handlers = useSwipe({ onSwipeLeft: () => dismiss() });
  return <div {...handlers}>…</div>;
}
```

### Virtual scroll hook

```ts
import { useVirtualScroll } from "@beamhop/lib";

const { visibleItems, containerProps, itemProps } = useVirtualScroll({
  items,
  itemHeight: 80,
});
```

## Testing

```bash
bun test src
```
