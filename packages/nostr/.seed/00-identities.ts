/**
 * Generate the 9 Beamhop identities (5 humans + 4 agents), publish their
 * kind-0 profiles to relay2.beamhop.com, and persist everything (incl.
 * private keys) to ~/Desktop/company.json for the content test.
 *
 * Run from packages/nostr:  bun .seed/00-identities.ts
 */
import { makeMember, Publisher, COMPANY_PATH, RELAY } from "./lib.ts";
import type { Company, MemberType } from "./lib.ts";

const human = (seed: string) =>
  `https://i.pravatar.cc/300?u=${seed}`;
const bot = (seed: string) =>
  `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${seed}`;

const specs: Array<{
  handle: string;
  type: MemberType;
  role: string;
  name: string;
  display_name: string;
  about: string;
  picture: string;
}> = [
  // --- Humans ---
  {
    handle: "maya",
    type: "human",
    role: "Staff Backend Engineer",
    name: "maya",
    display_name: "Maya Chen",
    about:
      "Staff backend engineer. Payments & checkout services. I like boring, observable systems.",
    picture: human("maya-chen"),
  },
  {
    handle: "diego",
    type: "human",
    role: "Site Reliability Engineer",
    name: "diego",
    display_name: "Diego Rivera",
    about:
      "SRE. On-call rotations, dashboards, and incident response. If it pages, I'm probably already looking.",
    picture: human("diego-rivera"),
  },
  {
    handle: "priya",
    type: "human",
    role: "Product Manager",
    name: "priya",
    display_name: "Priya Nair",
    about:
      "Product manager for collaboration features. Obsessed with shipping the right thing, not just things.",
    picture: human("priya-nair"),
  },
  {
    handle: "tom",
    type: "human",
    role: "Frontend Engineer",
    name: "tom",
    display_name: "Tom Becker",
    about:
      "Frontend engineer. React, real-time UIs, and pixel arguments. Accessibility is not optional.",
    picture: human("tom-becker"),
  },
  {
    handle: "sarah",
    type: "human",
    role: "Engineering Manager",
    name: "sarah",
    display_name: "Sarah Okonkwo",
    about:
      "Engineering manager. I keep the humans and agents pointed in the same direction. Postmortems are blameless here.",
    picture: human("sarah-okonkwo"),
  },
  // --- Agents ---
  {
    handle: "sentinel",
    type: "agent",
    role: "Incident & Observability Agent",
    name: "sentinel",
    display_name: "Sentinel 🛰️",
    about:
      "Automated incident & observability agent. I watch metrics, open incidents, and tag the right humans. Beep.",
    picture: bot("sentinel"),
  },
  {
    handle: "archivist",
    type: "agent",
    role: "Documentation Agent",
    name: "archivist",
    display_name: "Archivist 📚",
    about:
      "Documentation agent. I turn threads, postmortems, and specs into durable docs and articles.",
    picture: bot("archivist"),
  },
  {
    handle: "codex",
    type: "agent",
    role: "Code Review Agent",
    name: "codex",
    display_name: "Codex 🤖",
    about:
      "Code review & migration agent. I read diffs, suggest patches, and flag risky changes before they ship.",
    picture: bot("codex"),
  },
  {
    handle: "atlas",
    type: "agent",
    role: "Data & Analytics Agent",
    name: "atlas",
    display_name: "Atlas 📊",
    about:
      "Data & analytics agent. Ask me for usage numbers, funnels, and impact estimates. I bring receipts.",
    picture: bot("atlas"),
  },
];

const members = specs.map((s) =>
  makeMember({
    handle: s.handle,
    type: s.type,
    role: s.role,
    profile: {
      name: s.name,
      display_name: s.display_name,
      about: s.about,
      picture: s.picture,
      nip05: `${s.handle}@beamhop.com`,
      website: "https://beamhop.com",
      role: s.role,
    },
  }),
);

const company: Company = {
  relay: RELAY,
  createdAt: new Date().toISOString(),
  members,
};

await Bun.write(COMPANY_PATH, JSON.stringify(company, null, 2));
console.log(`Wrote ${members.length} identities -> ${COMPANY_PATH}`);

const pub = new Publisher();
for (const m of members) {
  const posted = await pub.profile(m);
  console.log(`profile ✓ ${m.handle.padEnd(10)} ${m.keys.npub}  (${posted.id.slice(0, 8)})`);
}
pub.close();
console.log("All profiles published.");
process.exit(0);
