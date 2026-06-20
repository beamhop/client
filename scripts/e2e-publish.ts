/**
 * True end-to-end network test: using the SAME identity the app uses, publish a
 * note (kind 1) and a documentation (kind 30023 + verity-doc marker) to the real
 * default relays, then query the relays back to confirm they propagated.
 */
import { SimplePool, finalizeEvent, type EventTemplate } from "nostr-tools";

const idJson = JSON.parse(await Bun.file("/tmp/verity-shot/identity.json").text()) as {
  kind: "local";
  secretKey: string;
};
const sk = Uint8Array.from(
  (idJson.secretKey.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
);

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const pool = new SimplePool();
const now = Math.floor(Date.now() / 1000);
const stamp = new Date(now * 1000).toISOString();

const note: EventTemplate = {
  kind: 1,
  created_at: now,
  tags: [],
  content: `Verity smoke test — live note published from the new client at ${stamp} 🔑`,
};
const docId = `verity-smoke-${now}`;
const doc: EventTemplate = {
  kind: 30023,
  created_at: now,
  tags: [
    ["d", docId],
    ["title", "Verity client — it works"],
    ["summary", "A documentation published end-to-end from the new Verity Nostr client."],
    ["published_at", String(now)],
    ["t", "verity-doc"],
    ["t", "verity"],
  ],
  content: `# It works\n\nThis NIP-23 documentation was published live from **Verity**.\n\n## Markdown renders\n\n- Lists\n- \`code\`\n- > and quotes\n\nVerified at ${stamp}.`,
};

const signedNote = finalizeEvent(note, sk);
const signedDoc = finalizeEvent(doc, sk);

const settle = async (event: ReturnType<typeof finalizeEvent>, label: string): Promise<void> => {
  const results = pool.publish(RELAYS, event);
  const outcomes = await Promise.allSettled(results);
  const ok = outcomes.filter((o) => o.status === "fulfilled").length;
  console.log(`${label}: accepted by ${ok}/${RELAYS.length} relays (id ${event.id.slice(0, 12)}…)`);
};

await settle(signedNote, "NOTE   ");
await settle(signedDoc, "DOC    ");

await new Promise((r) => setTimeout(r, 1500));

// Read both back from the relays.
const backNote = await pool.get(RELAYS, { ids: [signedNote.id] });
const backDoc = await pool.get(RELAYS, { kinds: [30023], "#d": [docId], authors: [signedDoc.pubkey] });

console.log(`\nROUND-TRIP note: ${backNote ? "✅ fetched back from relays" : "❌ not found"}`);
console.log(`ROUND-TRIP doc : ${backDoc ? "✅ fetched back from relays" : "❌ not found"}`);
if (backDoc) console.log(`  doc title tag: ${backDoc.tags.find((t) => t[0] === "title")?.[1]}`);

pool.close(RELAYS);
process.exit(backNote && backDoc ? 0 : 1);
