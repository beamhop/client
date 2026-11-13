# PWA (control panel)

The beamhop control panel is an installable Progressive Web App: React 19 + React Aria Components,
mobile-first with a bottom tab bar, swipe gestures with button alternatives, light/dark/high-contrast
themes, and WCAG 2.2 AA as the bar (tested with axe and Playwright on mobile and desktop viewports).
The same UI ships as the [desktop app](desktop.md), with the daemon bundled, for people who do not use the CLI.

## Open it

The daemon serves the built PWA on its local port:

```bash
beamhop ui        # prints http://127.0.0.1:7878/#token=…
```

Open the printed URL. The token in the `#fragment` is saved in the browser and stripped from the address
bar; the page then talks to the daemon over its localhost WebSocket. **The URL contains your API token —
don't share it.** The daemon only accepts requests whose `Host`/`Origin` match its own loopback address,
so other websites can't drive it from your browser.

Use your browser's "Install app" / "Add to Home Screen" to install it.

## Screens

| Tab / screen | What you do there                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Home         | agent cards: status, channel, last activity, budget meters; pull to refresh                         |
| Inbox        | approvals as a card stack: swipe right to approve, left to deny, long-press for details; big Approve/Deny buttons always visible; short undo window |
| Sessions     | live stream of the agent's chat and tool calls (collapsible output), a composer to steer it, swipe between sessions |
| Agents       | create, clone, edit (mounts, profile, budgets, memberships); opens the harness's own `CLAUDE.md` / `AGENTS.md` |
| Channels     | list and the add-channel wizard (the same steps as the CLI), with deep links and live validation    |
| Harnesses    | discovery results: ready / needs login / install                                                    |
| Policy       | profile toggles, domain chips, path pickers, learning-mode suggestions as swipeable cards           |
| Deploy       | provider → size → diff and cost confirmation → live logs                                            |
| Audit        | filterable, exportable log                                                                          |
| Panic        | the global stop button (also always reachable from the shell)                                       |

## Pairing a phone

```bash
beamhop device pair --name "my phone"
```

shows a QR code for the hosted app's pairing URL. Scan it, compare the **safety phrase** on both screens,
and confirm; the phone becomes a device key on the daemon's control allowlist. `beamhop device ls` lists
paired devices and `beamhop device rm <id>` removes a lost one (that is the whole revocation story — no key
rotation needed).

**Status in this build:** pairing, the device allowlist and the daemon's encrypted Nostr control plane are
implemented. The hosted PWA's Nostr transport (so a paired phone can drive the daemon from anywhere, with
no open ports) is still landing; until it does, use the local PWA on the same machine, reply to agents
from any Nostr client, or use the Telegram/Slack/Discord buttons for approvals. Watch
[CHANGELOG.md](../CHANGELOG.md).

## Development

```bash
pnpm --filter @beamhop/pwa dev          # http://127.0.0.1:5173/?mock=1 (in-browser mock daemon)
pnpm --filter @beamhop/pwa build        # → apps/pwa/dist (bundled into the npm package)
pnpm --filter @beamhop/pwa test:e2e     # Playwright + axe, mobile + desktop
```

`?mock=1` runs a complete in-browser mock of every daemon method (agents on four harnesses, all four
channels, pending approvals, 14 days of usage). Design direction and screen specs live in
[docs/design](design/).
