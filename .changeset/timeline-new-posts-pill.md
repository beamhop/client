---
"@beamhop/state": minor
---

feat(state): opt-in live-event buffering for `useTimelineFeed`

`useTimelineFeed` accepts a new `{ buffer }` option. When enabled, events that
arrive after the initial load are held in a `pending` buffer instead of being
auto-prepended to `items`, and a new `showPending()` releases them at once. This
powers a Twitter-style "X new posts" pill so a high-traffic feed no longer
scrolls out from under the reader.

The option is off by default, so existing consumers are unaffected. Arrivals are
never buffered while the visible feed is still empty (handles relays that send
EOSE before any stored events).
