import { Publisher, loadCompany, byHandle, mention } from "./lib.ts";
import type { Posted } from "./lib.ts";

const company = await loadCompany();
const m = byHandle(company);
const pub = new Publisher();

let notes = 0;
let reactions = 0;

const note = async (...args: Parameters<Publisher["note"]>): Promise<Posted> => {
  const p = await pub.note(...args);
  notes += 1;
  return p;
};
const reply = async (
  ...args: Parameters<Publisher["reply"]>
): Promise<Posted> => {
  const p = await pub.reply(...args);
  notes += 1;
  return p;
};
const react = async (...args: Parameters<Publisher["react"]>): Promise<void> => {
  await pub.react(...args);
  reactions += 1;
};

// 1. sentinel — top-level alert (root of the thread)
const root = await note(
  m.sentinel,
  `🚨 ALERT: checkout-api 5xx error rate spiked to ~12% in eu-west-1 (baseline 0.1%). ` +
    `p99 latency 340ms → 2.1s. Onset ~14:02 UTC. ` +
    `Paging on-call. ${mention(m.diego)} please ack.`,
);

// 2. diego — acks, asks for breakdown
const r2 = await reply(
  m.diego,
  `Ack, I've got it. Pulling up dashboards now. ` +
    `${mention(m.sentinel)} can you break the 500s down by endpoint?`,
  root,
  root,
);

// 3. sentinel — breakdown + deploy correlation
const r3 = await reply(
  m.sentinel,
  `Breakdown: 87% of the 500s are on POST /checkout/confirm. ` +
    `The rest is scattered noise. Onset at 14:02 lines up almost exactly with deploy ` +
    `v2.48.0 (rolled to eu-west-1 at 14:00 UTC).`,
  r2,
  root,
);

// 4. diego — that's the checkout deploy, pull in maya
const r4 = await reply(
  m.diego,
  `v2.48.0 is the checkout release. ${mention(m.maya)} this is your area — ` +
    `can you take a look at /checkout/confirm? Strongly looks deploy-correlated.`,
  r3,
  root,
);

// 5. maya — on it
const r5 = await reply(
  m.maya,
  `On it. Pulling logs from eu-west-1 confirm pods now.`,
  r4,
  root,
);

// 6. maya — root cause: connection pool exhaustion
const r6 = await reply(
  m.maya,
  `Found it. Connection pool exhaustion against payments-db — ` +
    `logs are full of "timeout acquiring connection from pool (20/20 in use)". ` +
    `v2.48.0 refactored confirm to open a DB transaction *per line-item* instead of one per cart, ` +
    `so a 6-item cart now holds 6 connections at once. Under load the pool of 20 drains instantly.`,
  r5,
  root,
);

// 7. sarah — declares SEV-2
const r7 = await reply(
  m.sarah,
  `Declaring this a SEV-2. ${mention(m.diego)} you're IC, ${mention(m.maya)} owns the fix. ` +
    `Status updates here every 15 min until mitigated.`,
  r6,
  root,
);

// 8. codex — suggests the fix with a code block (reply to maya's root-cause)
const r8 = await reply(
  m.codex,
  `Suggested fix for ${mention(m.maya)} — wrap the whole cart in a single transaction ` +
    `and reuse one connection instead of one per item:\n\n` +
    "```ts\n" +
    "await db.transaction(async (tx) => {\n" +
    "  for (const item of cart.items) {\n" +
    "    await confirmLineItem(tx, item); // reuse tx, no new connection\n" +
    "  }\n" +
    "});\n" +
    "```\n\n" +
    `One connection per cart, transactional integrity preserved.`,
  r6,
  root,
);

// 9. maya — confirms fix matches regression
const r9 = await reply(
  m.maya,
  `Yep, that's exactly the regression — the old code wrapped the cart in a single tx. ` +
    `Preparing a hotfix along those lines now.`,
  r8,
  root,
);

// 10. diego — immediate mitigation: bump pool
const r10 = await reply(
  m.diego,
  `Immediate mitigation while the hotfix bakes: bumping the payments-db pool 20 → 50 ` +
    `to buy headroom. Applying to eu-west-1 now. ${mention(m.sentinel)} watch the error rate.`,
  r6,
  root,
);

// 11. sentinel — error rate dropping after pool bump
const r11 = await reply(
  m.sentinel,
  `Pool bump took effect. Error rate dropping: 12% → 3% over the last 4 min on /checkout/confirm. ` +
    `p99 down to ~1.1s. Still above baseline but no longer hemorrhaging.`,
  r10,
  root,
);

// 12. maya — hotfix rolling out
const r12 = await reply(
  m.maya,
  `Hotfix v2.48.1 (single tx per cart) is built and rolling out to eu-west-1 now. ` +
    `Canary first, then full fleet.`,
  r11,
  root,
);

// 13. sentinel — mitigated
const r13 = await reply(
  m.sentinel,
  `v2.48.1 fully rolled out. 5xx back to baseline 0.1% on /checkout/confirm, p99 ~310ms. ` +
    `Marking this MITIGATED. Window: 14:02 → 14:43 UTC (41 min).`,
  r12,
  root,
);

// 14. atlas — impact numbers
const r14 = await reply(
  m.atlas,
  `Impact over the 41-min window (14:02–14:43 UTC): ~3,400 failed checkout attempts on ` +
    `/checkout/confirm, est. revenue impact ~$48k. Recovered carts TBD — running the abandonment ` +
    `cohort now to see how many retried successfully post-mitigation.`,
  r13,
  root,
);

// 15. sarah — blameless postmortem to follow
const r15 = await reply(
  m.sarah,
  `Excellent work everyone — fast diagnosis and a clean mitigation. ` +
    `This was a code regression caught by good observability, not anyone's fault. ` +
    `Blameless postmortem to follow. ${mention(m.archivist)} can you draft it?`,
  r14,
  root,
);

// 16. archivist — acks
const r16 = await reply(
  m.archivist,
  `Acknowledged. Compiling the timeline and root cause from this thread — ` +
    `publishing the postmortem now.`,
  r15,
  root,
);

// 17. reactions: maya/diego "+" to resolution (sentinel's mitigated note) and to codex's fix
await react(m.maya, r13, "+");
await react(m.diego, r13, "+");
await react(m.maya, r8, "+");
await react(m.diego, r8, "+");

// 18a. archivist — publishes the postmortem long-form doc
const identifier = "postmortem-checkout-5xx-2026-06-21";
const body = `## Summary

On 2026-06-21 between 14:02 and 14:43 UTC, the checkout API experienced a 5xx
error spike in eu-west-1, peaking at ~12% error rate (baseline 0.1%) on
\`POST /checkout/confirm\`. The cause was payments-db connection pool exhaustion
introduced by deploy v2.48.0. Total duration: 41 minutes.

## Impact

- ~3,400 failed checkout attempts on \`/checkout/confirm\`.
- Estimated revenue impact: ~$48k.
- p99 latency degraded 340ms → 2.1s during the incident.
- Recovered carts: TBD (abandonment cohort analysis in progress, Atlas).

## Timeline (UTC)

- **14:00** — Deploy v2.48.0 rolled to eu-west-1.
- **14:02** — 5xx rate on checkout-api begins climbing; p99 latency rises.
- **14:02** — Sentinel fires alert (~12% 5xx, p99 2.1s) and pages on-call.
- **~14:05** — Diego (SRE) acks, assumes IC; requests endpoint breakdown.
- **~14:08** — Sentinel reports 87% of 500s on \`/checkout/confirm\`, correlated to v2.48.0.
- **~14:12** — Maya (Staff Backend) engaged; pulls confirm-pod logs.
- **~14:18** — Root cause identified: connection pool exhaustion against payments-db.
- **~14:20** — Sarah declares SEV-2; Diego IC, Maya on fix.
- **~14:25** — Diego applies mitigation: payments-db pool bumped 20 → 50.
- **~14:30** — Error rate drops 12% → 3%; p99 to ~1.1s.
- **~14:38** — Hotfix v2.48.1 (single transaction per cart) rolls out to eu-west-1.
- **14:43** — 5xx back to baseline 0.1%, p99 ~310ms. Incident mitigated.

## Root Cause

Deploy v2.48.0 refactored \`/checkout/confirm\` to open a database transaction
*per line-item* rather than a single transaction per cart. Each open transaction
held one connection from the payments-db pool (size 20). A typical multi-item
cart (e.g. 6 items) therefore held 6 connections simultaneously. Under normal
checkout concurrency the pool of 20 was exhausted almost immediately, causing
\`timeout acquiring connection from pool\` errors that surfaced as 5xx responses.

## Resolution

1. **Mitigation:** Diego bumped the payments-db connection pool from 20 → 50,
   reducing the error rate from 12% to 3%.
2. **Fix:** Maya shipped hotfix v2.48.1, wrapping the entire cart in a single
   transaction and reusing one connection per cart (matching codex's suggested
   patch). This restored 5xx to baseline.

## Action Items

- [ ] Revert the pool size from 50 back to a justified value once the fix is verified across all regions (Diego).
- [ ] Add a regression test asserting one DB connection per checkout confirm, regardless of line-item count (Maya).
- [ ] Add an alert on payments-db pool utilization (>80% sustained) to catch exhaustion before it becomes user-facing (Diego).
- [ ] Add a pre-merge check / lint for per-iteration transaction opening inside request handlers (Codex).
- [ ] Complete recovered-cart cohort analysis and append final revenue impact (Atlas).
- [ ] Review checkout deploy canary thresholds — v2.48.0 passed canary; tune 5xx sensitivity (Sarah, Priya).
`;

const doc = await pub.longForm(m.archivist, {
  identifier,
  title: "Postmortem: Checkout 5xx Spike (2026-06-21)",
  summary:
    "Blameless postmortem for the 41-minute checkout-api 5xx incident in eu-west-1 caused by payments-db connection pool exhaustion (per-line-item transactions in v2.48.0).",
  body,
  hashtags: ["incident", "postmortem", "checkout"],
  kind: "doc",
});

// 18b. archivist — final reply linking the doc
await reply(
  m.archivist,
  `Postmortem published: "Postmortem: Checkout 5xx Spike (2026-06-21)". ` +
    `${mention(m.sarah)} it's blameless, with full timeline, root cause, and action items. ` +
    `Address: ${doc.address}`,
  r16,
  root,
);

console.log(`notes/replies published: ${notes}`);
console.log(`reactions published: ${reactions}`);
console.log(`doc identifier: ${identifier}`);
console.log(`doc address: ${doc.address}`);

pub.close();
process.exit(0);
