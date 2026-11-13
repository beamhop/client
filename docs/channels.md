# Channels

A **channel** is one bot account on one provider (a Telegram bot, a Slack app, a Discord bot, a Nostr
key). An agent **joins** targets on a channel — a DM, a group, a Slack channel — with a default role for
the people it meets there.

Every provider uses a connection that needs **no public URL** (relays, long polling, Socket Mode, the
Gateway), so it all works behind NAT and on a laptop. Credentials go straight into beamhop's encrypted vault
(`channel.<name>.<field>`); they are never written to config files.

The shared flow, whichever provider:

1. **Create the bot/app** on the provider (links below; the PWA and `beamhop channel providers --json`
   show the same wizard steps).
2. **Add it**: `beamhop channel add <provider> --name <name> ...` validates the credentials with a live API
   call and shows the bot's name.
3. **Pair yourself**: `beamhop channel pair <name>` prints a one-time code; send `/pair <code>` to the bot.
   That links your account on that provider to your beamhop owner identity.
4. **Join**: `beamhop join <agent> <name>:<kind>[/<id>] --role <role>`.

## Targets

`<channel>:<kind>[/<id>]` where kind is `dm`, `group`, `channel`, `thread` or `public`. Without an id the
membership covers every conversation of that kind.

| Example                              | Means                                     |
| ------------------------------------ | ----------------------------------------- |
| `mybot:dm`                           | every DM to the Telegram bot `mybot`      |
| `mybot:group/-1001234567890`         | one Telegram group (ids start with `-100`) |
| `team:channel/C0123ABCD`             | one Slack channel (id from the channel's "About" panel) |
| `team:dm`                            | Slack DMs and the app's Messages tab      |
| `guild:channel/112233445566778899`   | one Discord channel (Developer Mode → Copy Channel ID) |
| `nostr:dm`                           | NIP-17 DMs to the agent's own Nostr key   |
| `nostr:group/groups.example.com'abc` | a NIP-29 group (`<relay host>'<group id>`) |
| `nostr:public`                       | kind 1 mentions/replies (opt-in, rate-limited) |

Triggers: DMs always trigger. In groups and channels the agent only answers when **@mentioned** or
**replied to** (`--trigger mention --trigger reply` is the default; `command` and `all` exist too).
Ignored messages never reach the model, so they cost nothing.

Roles: `owner`, `admin`, `user`, `viewer`, `agent`. Strangers are ignored unless the agent is `public`,
in which case they get `viewer` (strict sandbox, rate limits, DLP on replies). Grant people roles with
`beamhop role grant telegram:5551 user --agent helper`, link one person's accounts across providers with
`beamhop link alice telegram:5551`.

Revoking access is platform-native: kick the bot from the group/channel/server. beamhop treats that as the
membership being gone and never rejoins on its own.

## Nostr

Nothing to sign up for. Each agent automatically gets **its own Nostr key** (stored in the encrypted vault) when
it is created, on the built-in `nostr` channel. The agent publishes a kind 0 profile labelled
"AI agent operated by <your npub>" and an owner attestation.

```bash
beamhop agent show helper          # shows the agent's npub
beamhop join helper nostr:dm --role user      # presets already add nostr:dm
```

DM the npub from any NIP-17-capable client signed in as your owner key (or a key you granted a role).

- **Relays:** `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net` by default; change
  `nostr.relays` in `~/.beamhop/config.yaml` or the channel's `settings.relays` in
  `~/.beamhop/channels/nostr.yaml`. Reconnects back off; events are deduplicated.
- **NIP-29 groups:** add `relay'groupId` entries to the channel's `settings.groups` (for example
  `wss://groups.example.com'abc123`), then `beamhop join helper nostr:group/groups.example.com'abc123`.
  Group roles map to beamhop roles. A removal (kind 9001) is honoured only from the relay key or an admin in
  the group's kind 39001 list.
- **Public notes (kind 1):** off by default; set `publicNotes: true` in the channel's settings to answer
  mentions and replies, rate-limited. Outgoing notes can carry NIP-13 proof of work (`powDifficulty`).
- **NIP-90 jobs:** agents can post and accept jobs from peer agents (`mesh_post_job`); payment tags
  (`amount`, `bid`) are ignored — there are no zaps or payments.
- **Your own handle:** `beamhop identity nip05 --domain example.com` writes `/.well-known/nostr.json` and
  hosting snippets (static host, nginx, Cloudflare Pages). beamhop never hosts handles for you.
- **A separate Nostr bot key:** `BEAMHOP_NOSTR_NSEC=nsec1… beamhop channel add nostr --name lab --secret nsec=BEAMHOP_NOSTR_NSEC`
  adds a channel with a key you bring. Never use your personal key for an agent.

## Telegram

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a display name and a username ending in
   `bot`. BotFather replies with an HTTP API token (`<digits>:<35 characters>`).
2. Add the channel (the token is read from the environment, never from the command line):

   ```bash
   export BEAMHOP_TELEGRAM_TOKEN=...            # paste from BotFather
   beamhop channel add telegram --name mybot --token-env BEAMHOP_TELEGRAM_TOKEN
   ```

   beamhop calls `getMe`, shows the bot's handle and tells you whether privacy mode is on.
3. `beamhop channel pair mybot`, then send `/pair <code>` to the bot in a DM.
4. `beamhop join helper mybot:dm --role owner`
5. **Groups (optional):** add the bot to the group. With privacy mode **on** (default) the bot sees only
   @mentions, replies and `/commands` — all beamhop needs. If the agent should read every message for
   context, send `/setprivacy` to @BotFather → your bot → **Disable**, then remove and re-add the bot.
   Then `beamhop join helper mybot:group/-100… --role viewer`.

Transport: Bot API long polling (`getUpdates`). Replies are live-edited (about one edit per second),
formatted as Telegram HTML; approvals use inline buttons.

## Slack

1. Run `beamhop channel providers --json` (or open Channels → Add → Slack in the PWA) and open the
   **Create app from manifest** link. It prefills:
   - Socket Mode on (no public URL) and Interactivity on (buttons)
   - bot scopes `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`,
     `im:read`, `im:write`, `mpim:history`, `files:read`, `files:write`, `users:read`, `reactions:write`,
     `channels:read`, `groups:read`
   - events `app_mention`, `message.im`, `message.channels`, `message.groups`, `message.mpim`,
     `member_left_channel`, `channel_left`
   - an app description that labels it as an AI agent operated by you
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**, add `connections:write`, copy the
   `xapp-…` token.
3. **Install App → Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-…`).
4. Add it:

   ```bash
   export BEAMHOP_SLACK_APP_TOKEN=...  BEAMHOP_SLACK_BOT_TOKEN=...
   beamhop channel add slack --name team \
     --secret appToken=BEAMHOP_SLACK_APP_TOKEN --secret botToken=BEAMHOP_SLACK_BOT_TOKEN
   ```

5. `beamhop channel pair team`, DM `/pair <code>` to the app, then `/invite @<bot>` in each channel and
   `beamhop join reviewer team:channel/C0123ABCD --role user`.

Transport: Socket Mode. Output is mrkdwn/Block Kit; mass mentions (`@channel`, `@here`) in agent output
are neutralized; approvals are buttons.

## Discord

1. [Developer Portal](https://discord.com/developers/applications) → **New Application** (name it after
   your agent; say in the description that it is an AI agent operated by you).
2. **Bot → Reset Token**, copy it. Under **Privileged Gateway Intents** enable **Message Content Intent**.
3. Add it:

   ```bash
   export BEAMHOP_DISCORD_TOKEN=...
   beamhop channel add discord --name guild --secret botToken=BEAMHOP_DISCORD_TOKEN
   ```

4. Invite the bot with the link `channel add` prints after validation (also shown in the PWA wizard). It requests only View Channels, Send
   Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions and Use Slash
   Commands (`permissions=277025492032`, scopes `bot applications.commands`).
5. `beamhop channel pair guild`, DM `/pair <code>` to the bot, then
   `beamhop join helper guild:channel/<channel id> --role user`.

Transport: the Gateway websocket (discord.js). Output is Markdown with embeds; `@everyone`/role pings are
neutralized; approvals are buttons.

## Files, formatting and commands

- Inbound files land in the session's `inbox/` inside the sandbox; the agent gets the path and MIME type.
  Downloads go through the daemon's SSRF-safe fetcher, never directly from the sandbox, with size and type
  limits per role.
- The agent sends files with the MCP tool `channel_send_file` (native uploads; Blossom on Nostr).
- The agent writes Markdown; each channel renders it natively (Telegram HTML, Slack mrkdwn, Discord
  Markdown, Nostr plain text with code fences).
- In-channel commands, by role: `/new` `/stop` `/status` `/resume` `/details`, `/approve <id>`
  `/deny <id>`, `/model` `/harness` `/mode plan|auto|read-only`, `/usage`.
- Cross-channel posting (`nostr:dm → slack:#deploys`) only along routes the owner adds to the agent's
  `routes`; by default replies go only where the message came from.
