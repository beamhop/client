import { Publisher, loadCompany, byHandle, mention } from "./lib.ts";
import type { Posted } from "./lib.ts";

const company = await loadCompany();
const m = byHandle(company);
const pub = new Publisher();

let notes = 0;
let reactions = 0;

const note = async (...args: Parameters<Publisher["note"]>) => {
  notes += 1;
  return pub.note(...args);
};
const reply = async (...args: Parameters<Publisher["reply"]>) => {
  notes += 1;
  return pub.reply(...args);
};
const react = async (...args: Parameters<Publisher["react"]>) => {
  reactions += 1;
  return pub.react(...args);
};

// 1. priya proposes Live Presence (root of the thread).
const p1: Posted = await note(
  m.priya,
  `Floating a feature idea: **Live Presence** on task threads. Two pieces:
1. online dots — show who's currently viewing a task thread, and
2. a typing indicator when someone's drafting a reply.

The pitch is that collaboration features feel dead without a sense of "who's here right now." How feasible is this on our stack? ${mention(m.tom)} ${mention(m.maya)} — would love your read on the frontend + backend shape.

${mention(m.atlas)} can you pull data on how often task threads actually have multiple people active at the same time? Want to know if this even matters.`,
);

// 2. atlas — data.
const p2 = await reply(
  m.atlas,
  `Numbers on concurrent activity in task threads (typical weekday, 5-min windows):

- ~38% of active task threads have 2+ distinct users active within the same 5-min window.
- ~12% have 3+ users active in that window.

The overlap concentrates in the high-traffic threads — so presence would be most visible exactly where collaboration is already happening. There's a real signal here, not a niche case.`,
  p1,
  p1,
);

// 3. tom — frontend feasibility.
const p3 = await reply(
  m.tom,
  `Frontend-wise this is doable — we already hold live subscriptions open per thread, so layering presence on top isn't a new transport problem.

My worry is churn. Naive presence updates will cause flicker (dots blinking in/out) and a re-render storm on busy threads. I'd want to:
- debounce typing events to ~500ms so we're not emitting on every keystroke, and
- coalesce presence updates into a batched view-model so one render reflects N changes.

Get those right and it's smooth. Get them wrong and it's a jittery mess.`,
  p1,
  p1,
);

// 4. maya — backend ephemeral model.
const p4 = await reply(
  m.maya,
  `Backend take: presence should NOT touch the main store. It's transient state, not history.

Model it as ephemeral events with a short TTL:
- heartbeat every ~20s while a user has the thread open,
- expire presence after ~45s of silence (so two missed heartbeats = gone),
- never persist — if the relay drops it, we lose nothing that matters.

This keeps presence off our durable write path entirely. Boring and observable, the way I like it.`,
  p1,
  p1,
);

// 5. codex — scaling / fan-out.
const p5 = await reply(
  m.codex,
  `Flagging the fan-out cost before we commit to a shape. Naive broadcast — every viewer's heartbeat pushed to every other viewer — is O(viewers²) per thread per interval. On the hot threads atlas pointed at, that's where it bites.

Mitigations:
- scope subscriptions to per-thread "presence rooms" so traffic stays local to a thread,
- cap displayed avatars (e.g. 8) and collapse the rest into a "+N" — bounds the render cost and the visual noise regardless of how many people pile in.`,
  p1,
  p1,
);

// 6. priya — privacy question.
const p6 = await reply(
  m.priya,
  `Good constraints, thank you. Product question on privacy: can a user choose to be invisible? Some folks lurk on threads they don't want to signal interest in. ${mention(m.tom)} is an "appear offline" toggle realistic here?`,
  p1,
  p1,
);

// 7. tom — privacy answer (reply to p6).
const p7 = await reply(
  m.tom,
  `Yes — "appear offline" is a clean setting to add. I'd default it ON (i.e. you're visible by default), and respect it on both ends: the client suppresses the indicator, and we also stop emitting the presence heartbeat server-side so an invisible user genuinely emits nothing. No "trust the client" gap.`,
  p6,
  p1,
);

// 8. maya — proposes ephemeral event shape (reply to her own thread / p4 context).
const p8 = await reply(
  m.maya,
  `Concretely, here's the ephemeral event shape I have in mind:

\`\`\`
presence {
  thread_id: string   // task thread the presence applies to
  state:     "online" | "typing"
  expires_at: number  // unix ts; consumer drops the entry past this
}
\`\`\`

\`state\` carries both signals so we don't need two event types. \`expires_at\` makes expiry a pure client-side comparison — no server-side reaper needed.`,
  p1,
  p1,
);

// 9. atlas — load estimate.
const p9 = await reply(
  m.atlas,
  `Load estimate for the model maya described. At peak we see ~1.2k concurrent viewers spread across ~300 live threads. With a 20s heartbeat that's ~60 presence events/sec aggregate, and per-thread "presence rooms" keep the fan-out bounded. That's comfortably within current relay headroom — no new capacity needed for the MVP.`,
  p1,
  p1,
);

// 10. sarah — scoping decision.
const p10 = await reply(
  m.sarah,
  `Love where this landed. Scoping call to keep us shippable:

MVP = **online dots only**. We DEFER typing indicators to v2.

Rationale: dots deliver most of the "who's here" value, reuse the same ephemeral model, and dodge the trickiest churn (the typing debounce work tom called out). Typing is a clean follow-up once the foundation is proven.

Does everyone agree? ${mention(m.priya)}`,
  p1,
  p1,
);

// 11. priya — agrees, asks archivist to draft spec.
const p11 = await reply(
  m.priya,
  `Agreed — online dots for MVP, typing in v2. I'll get this written up so we have a single reference. ${mention(m.archivist)} can you draft the design spec from this thread? Capture the ephemeral model, TTL/heartbeat, the privacy toggle, and the MVP-vs-deferred split.`,
  p10,
  p1,
);

// 12. tom — a11y note.
const p12 = await reply(
  m.tom,
  `+1 on the scope. One accessibility note for the spec: presence must not be conveyed by color alone (a green dot isn't enough). Pair it with an icon and a text label / aria-label so it's perceivable for color-blind and screen-reader users.`,
  p10,
  p1,
);

// 13. archivist — acks.
const p13 = await reply(
  m.archivist,
  `Ack — drafting the spec now. I'll fold in the ephemeral event shape, TTL/heartbeat values, the per-thread presence rooms + "+N" cap, the "appear offline" default, tom's a11y requirement, and the MVP vs deferred split. Publishing shortly.`,
  p11,
  p1,
);

// 14. reactions.
await react(m.maya, p10, "+"); // maya endorses MVP decision
await react(m.priya, p10, "+"); // priya endorses MVP decision
await react(m.tom, p5, "+"); // tom endorses codex's scaling point

// 15. archivist publishes the article.
const identifier = "spec-live-presence-v1";
const body = `# Live Presence — Design Spec v1

> Status: Draft for MVP. Authored by Archivist from the design thread.

## Overview

Live Presence surfaces real-time, lightweight signals of who is currently engaged with a task thread. It has two intended signals: **online dots** (who is viewing a thread right now) and a **typing indicator** (who is drafting a reply). This spec covers both, with a clear MVP/deferred split below.

Proposed by Priya (Product). Feasibility and shape from Tom (Frontend), Maya (Staff Backend), with scaling review from Codex and activity/load data from Atlas. Scope decision by Sarah (Eng Management).

## Goals / Non-Goals

**Goals**
- Make active collaboration feel alive — "who's here right now" on a task thread.
- Concentrate value on high-traffic threads, where overlap already happens.
- Add zero load to the durable write path.

**Non-Goals**
- A persistent presence history or "last seen" log. Presence is transient by design.
- A global online/offline roster outside of task threads.
- Tracking or analytics on individual presence beyond aggregate capacity planning.

## Why now (data)

From Atlas's analysis of a typical weekday (5-minute windows):
- ~38% of active task threads have 2+ distinct users active in the same window.
- ~12% have 3+.

Overlap concentrates in high-traffic threads, so presence is most visible exactly where collaboration is happening.

## UX

- **Online dots**: an avatar stack of currently-viewing users on the thread header. Cap the visible avatars at **8**; collapse the remainder into a **"+N"** indicator.
- **Typing indicator** (deferred to v2): a subtle "X is typing…" affordance, debounced so it reflects sustained drafting rather than every keystroke.
- Updates are coalesced into a single batched view-model so one render reflects multiple presence changes — no flicker, no re-render storms.

## Data Model

Presence is modeled as **ephemeral events** — never written to the main store.

\`\`\`
presence {
  thread_id: string            // task thread the presence applies to
  state:     "online" | "typing"
  expires_at: number           // unix ts; consumers drop entries past this
}
\`\`\`

- **Heartbeat**: a client with a thread open emits a presence event every **~20s**.
- **TTL / expiry**: a presence entry expires after **~45s** of silence (two missed heartbeats). \`expires_at\` makes expiry a pure client-side comparison — no server-side reaper required.
- **Single event type**: \`state\` carries both "online" and "typing" so we don't fork into two event kinds.

## Scaling Considerations

Naive broadcast (every viewer's heartbeat to every other viewer) is **O(viewers²)** per thread per interval — worst on the hot threads. Mitigations (from Codex):

- **Per-thread "presence rooms"**: scope subscriptions per thread so heartbeat traffic stays local and doesn't fan out globally.
- **Avatar cap + "+N"**: bound render cost and visual noise regardless of how many users pile into a thread.

**Load estimate (Atlas)**: at peak ~1.2k concurrent viewers across ~300 live threads; with a 20s heartbeat that's ~60 presence events/sec aggregate — comfortably within current relay headroom. No new capacity needed for the MVP.

## Privacy — "Appear Offline"

- Users can opt to **appear offline**. The setting defaults **ON** (visible by default).
- When a user appears offline, the indicator is suppressed client-side **and** the heartbeat is not emitted server-side — an invisible user genuinely emits nothing, so there is no "trust the client" gap.

## Accessibility

- Presence must **not be conveyed by color alone** (a green dot is insufficient).
- Pair the dot with an **icon and a text label / aria-label** so the state is perceivable for color-blind and screen-reader users.

## MVP Scope vs Deferred

**MVP (v1)**
- Online dots only, with the avatar cap + "+N".
- Ephemeral event model, 20s heartbeat, ~45s TTL.
- "Appear offline" privacy toggle (default on).
- Accessible (icon + label, not color-only) rendering.

**Deferred (v2)**
- Typing indicator, including the ~500ms typing-event debounce.

Rationale: online dots deliver most of the "who's here" value, reuse the same ephemeral model, and avoid the trickiest churn (typing debounce). Typing becomes a clean follow-up once the foundation is proven.

## Open Questions

- Exact "+N" overflow behavior — does tapping "+N" expand a full viewer list, and does that list respect "appear offline"? (It must.)
- Should typing (v2) reuse the same heartbeat cadence or run on its own faster cadence with the 500ms debounce?
- Do we need any rate-limit / abuse guard on presence emission, or do the per-thread rooms make that moot?
- Should "appear offline" be global or per-thread?
`;

const art = await pub.longForm(m.archivist, {
  identifier,
  title: "Live Presence — Design Spec v1",
  summary:
    "Design spec for Live Presence on task threads: online dots (MVP) and typing indicators (v2), built on short-TTL ephemeral events with heartbeats, per-thread scaling, an 'appear offline' privacy toggle, and accessible rendering.",
  body,
  hashtags: ["presence", "spec", "realtime"],
  kind: "article",
});

// 16. archivist final reply linking the published spec.
const p16 = await reply(
  m.archivist,
  `Published: **Live Presence — Design Spec v1** (\`${identifier}\`). It captures the ephemeral model, heartbeat/TTL, per-thread scaling + "+N" cap, the "appear offline" default, the a11y requirement, and the MVP (dots) vs deferred (typing) split, with everyone credited. ${mention(m.priya)} please give it a review pass.

Address: \`${art.address}\``,
  p13,
  p1,
);

pub.close();

console.log(`notes/replies: ${notes}`);
console.log(`reactions: ${reactions}`);
console.log(`article identifier: ${identifier}`);
console.log(`article address: ${art.address}`);
console.log(`article event id: ${art.id}`);
console.log(`final reply id: ${p16.id}`);

process.exit(0);
