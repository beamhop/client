# Session continuity across harness, model and setting changes

## Problem

A conversation's session stores a harness-native resume token (`sessions.resume_enc`) and
[`apps/daemon/src/sessions.ts`](../../apps/daemon/src/sessions.ts) passes it to whatever harness the agent
uses now. After a switch (e.g. claude → pi) the new harness gets a foreign id and fails:

    pi exited (code=1 signal=null): No session found matching '01a1d649-…'

The same breaks when the model, sandbox home or mounts change, or the agent moves host: the harness's own
session files are no longer where the token points.

## Decisions

| Topic | Decision |
| --- | --- |
| Source of truth | Beamhop owns the conversation. History = beamhop's `session_events` + channel history fetched on demand. |
| Native resume | Dropped. Every harness start is fresh and gets the history replayed. |
| Scope | Thread: whole thread. DM: everything since the last `/new`. Top-level channel: last N messages since the last `/new`. All trimmed to the budget. |
| Tool activity | Replayed as one-line summaries (`[ran: git status → 3 files changed]`, `[edited src/x.ts]`). |
| Budget | Share of the model's context window (default 40%) from the harness catalog; fixed fallback when unknown. |
| When changes apply | Next inbound message. A running turn finishes on the old runtime. |
| Reset | `/new` in DMs and channels. Threads never reset. Idle timeout only stops the process. |
| Others' messages | Fetched from the channel API at harness start where available (Slack, Discord, Nostr). Telegram and others fall back to beamhop's log. Nothing extra stored. |
| Switch visibility | Silent in the channel; the replay preamble tells the agent which harness/model earlier turns ran on. |
| Must survive | Harness switch, model switch, sandbox/home/mounts change, daemon restart/upgrade/host move. |

## Design

### 1. Conversation, not harness session

- A **conversation** is keyed by `(agent, channel, conversationId, threadId)`, with a `contextStart`
  marker (the seq/time of the last `/new`; none for threads).
- The beamhop session row stays the unit of process lifetime, usage and audit. Several sessions can belong
  to one conversation; history is read across all of them from `contextStart` on.
- The daemon never passes `SessionSpec.resume` and ignores `done.resume`; migration 3 clears
  `sessions.resume_enc`. Harness plugins keep the field for their own in-process use.

### 2. History assembly (`apps/daemon/src/history.ts`, new)

`buildHistory(conversation, { budgetTokens, currentMessageId })` returns ordered entries:

1. Beamhop events since `contextStart`: user messages (with author), assistant text, tool calls collapsed
   to one-line summaries, approvals/system notes that matter (denials, errors).
2. Channel history, if the channel supports it: messages in the thread / recent channel window that are
   not already in beamhop's log (dedupe by platform message id), tagged with author and time.
3. Merge by timestamp, drop the current inbound message (it is sent as the prompt), then trim oldest-first
   to the budget. When trimming, keep the first message of a thread (its topic) and say how many messages
   were omitted.

Token counting: a cheap estimator (chars/4) is enough; precision isn't needed at 40% headroom.

### 3. Replay into a fresh harness

On every harness start (new session, restart after crash/idle, settings change, daemon restart), the first
prompt is:

    <conversation-history source="beamhop" channel="slack" kind="thread" omitted="12">
    Earlier turns ran on claude / sonnet; you are now pi / gpt-5.
    [2026-11-12 10:03] alice: …
    [2026-11-12 10:03] you: …
    [2026-11-12 10:04] you: [ran: git status → 3 files changed]
    …
    </conversation-history>

    <new message>

It goes in the user prompt, not a system prompt, so it works the same on every harness (ACP, Claude SDK,
Codex, pi). The preamble is not echoed to the channel and is recorded in `session_events` as a `system`
event with a short note ("history replayed: 48 messages"), not the full text.

While a harness process stays alive between messages, nothing is replayed: the harness keeps its own
context.

### 4. Settings changes

- Compute a **runtime fingerprint** at start: harness id, model, permission mode, profile, mounts, home
  sync, sandbox policy hash. Store it on the live runtime.
- On each inbound message, if the agent's current fingerprint differs and no turn is running, close the
  runtime softly and start a new one (which replays history). If a turn is running, the message queues as
  today and the check runs before it starts.
- This replaces any ad-hoc "restart on config change" paths so there is one rule.

### 5. Channel history capability

Add an optional method to `ChannelConn` in `packages/core/src/plugins.ts`:

    fetchHistory?(q: { conversationId: string; threadId?: string; limit: number; before?: string }):
      Promise<ChannelHistoryMessage[]>

with `{ id, author: { id, name, isBot }, text, at, threadId? }`.

- Slack: `conversations.replies` for threads, `conversations.history` for channels/DMs (scopes already in
  the manifest).
- Discord: `GET /channels/{id}/messages` (threads are channels).
- Nostr: relay query by thread root / DM pair.
- Telegram: not implemented (bot API has no history); beamhop log only.

Fetch failures are logged and the replay continues with beamhop's log only; they never block a turn.
Channel history counts against the same budget, with beamhop's own entries kept first when trimming.

### 6. Budget

- `modelContextWindow()` in `packages/core/src/models.ts` maps well-known model families to their context
  window (the signed harness catalog carries no model data); unknown models and `default` get 128k.
- Agent setting `historyShare` (default 0.4, max 0.8), budget capped at 400k tokens.

### 7. `/new`

- In DMs and channels: sets `contextStart` to now and ends the live runtime, so the next message starts
  clean; `/resume` restores the previous mark. In threads: restarts the harness and says threads keep their
  history.

## Tests

- Harness switch mid-thread (fake-acp → fake-pi): second message succeeds, prompt contains prior turns.
- Model switch on the same harness: runtime restarts on next message, history replayed, no `--session`.
- Mount/home change: same.
- Daemon restart: re-attached conversation replays on first message.
- Budget trimming keeps thread root, reports omitted count, stays under budget.
- Channel history merge dedupes messages present in both sources; fetch failure falls back cleanly.
- `/new` in DM clears context; `/new` in a thread does not.
- Migration clears `resume_enc`; no harness spec carries `resume`.

## Rollout order

1. Stop passing/storing resume tokens + migration (fixes the reported crash on its own).
2. History builder from beamhop's log + replay on harness start + fingerprint restart.
3. Budget from catalog context windows.
4. `fetchHistory` for Slack, then Discord, then Nostr.
5. `/new` semantics for DM/channel vs thread.
