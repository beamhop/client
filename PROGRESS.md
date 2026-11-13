# beamhop — overnight build progress

Deadline: 08:00 Europe/Berlin (07:00 UTC), 2026-11-13. Updated by the watchdog every ~25 min.

## Status board

| Module                                                        | Owner         | State                |
| ------------------------------------------------------------- | ------------- | -------------------- |
| Monorepo + `@beamhop/core` contracts + CI gates               | orchestrator  | ✅ merged            |
| Design direction (DESIGN/JOURNEYS/SCREENS/tokens)             | design agent  | 🔨 in progress       |
| `sandbox` (srt) + `broker` (LLM key proxy, vault, DLP)        | builder A1    | 🔨 in progress       |
| `channel-nostr` (NIP-17/29/kind1/90, identity, control plane) | builder A2    | 🔨 in progress       |
| Harness catalog, discovery, ACP/Claude/Codex/pi adapters      | builder A3    | 🔨 in progress       |
| `store` (SQLite, YAML configs, retention) + `authz`           | builder A4    | 🔨 in progress       |
| `channel-telegram` (live-tested with @Ass5istan7Bot)          | builder A5    | 🔨 in progress       |
| `mcp` (channel/mesh tools for agents)                         | builder A6    | 🔨 in progress       |
| daemon + CLI                                                  | builder B1    | ⏳ queued            |
| PWA                                                           | builders B2.. | ⏳ waiting on design |
| Slack, Discord                                                | —             | ⏳                   |
| Deployers (Hetzner, DO, Fly, Render, Railway)                 | —             | ⏳                   |
| E2E, security suite, UX iteration                             | —             | ⏳                   |

## Log

- 01:10 — Phase 0 done: bubblewrap/socat installed, monorepo + core contracts (11 tests green), conventions. Wave A launched (6 builders + design research).
- 01:40 — MCP + Telegram merged (108 tests green). Design direction CARRIER delivered. PWA foundation started.
