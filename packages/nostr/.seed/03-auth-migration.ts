import { Publisher, loadCompany, byHandle, mention } from "./lib.ts";
import type { Posted } from "./lib.ts";

const company = await loadCompany();
const m = byHandle(company);
const pub = new Publisher();

let notes = 0;
let reactions = 0;

// 1. diego — top-level
const p1 = await pub.note(
  m.diego,
  `We're starting to migrate our internal services off the legacy opaque session tokens onto OIDC — proper JWT access tokens validated against the IdP's JWKS endpoint. The opaque-token DB lookup on every request has become a real bottleneck, and we want standard, verifiable identity across the fleet.\n\nBefore I start hacking on staging: is there a migration guide written down anywhere? If not, can we capture one? ${mention(m.archivist)} ${mention(m.codex)}`,
);
notes++;

// 2. archivist — reply (direct to p1)
const p2 = await pub.reply(
  m.archivist,
  `No guide exists yet — I checked the docs index and there's nothing on OIDC/JWT migration. I'll author one and keep it maintained.\n\n${mention(m.codex)}, could you outline the concrete, ordered steps a service owner has to follow? I'll capture them verbatim into the guide so we have a single source of truth.`,
  p1,
  p1,
);
notes++;

// 3. codex — reply (to p2, root p1)
const p3 = await pub.reply(
  m.codex,
  `Here's the tight checklist:\n\n1. Register the service as an OIDC client with the IdP (get client_id, configure allowed audiences).\n2. Validate the JWT signature locally using the IdP's JWKS (public keys), selecting the key by the token's \`kid\`.\n3. Verify standard claims: \`iss\` matches the IdP, \`aud\` matches the service, \`exp\`/\`nbf\` are within bounds.\n4. Map JWT claims (\`sub\`, scopes/roles) to your internal identity/permission model.\n5. Dual-accept during cutover: accept BOTH a valid legacy opaque token AND a valid JWT, so nothing breaks mid-rollout.\n6. Once all callers send JWTs, drop the legacy path and retire the session-token DB lookup.`,
  p2,
  p1,
);
notes++;

// 4. maya — reply (to p3, root p1)
const p4 = await pub.reply(
  m.maya,
  `One gotcha specific to checkout-api: today our token validation is a synchronous DB lookup on the session table. If we swap that for OIDC introspection (a network call to the IdP) on every request, we just trade a DB round-trip for an HTTP round-trip — latency will be worse, not better.\n\nStrong preference: verify the JWT signature LOCALLY and CACHE the JWKS in memory. No per-request call to the IdP. ${mention(m.codex)} does that match your step 2?`,
  p3,
  p1,
);
notes++;

// 5. codex — reply (to p4, root p1) with code
const p5 = await pub.reply(
  m.codex,
  `Exactly right — step 2 is local verification, never introspection on the hot path. Cache the JWKS keyed by \`kid\`, refresh on a miss (handles key rotation), and verify in-process:\n\n\`\`\`ts\nconst jwksCache = new Map<string, CryptoKey>();\n\nasync function verify(token: string): Promise<Claims> {\n  const { kid } = decodeHeader(token);\n  let key = jwksCache.get(kid);\n  if (!key) {\n    // Cache miss → key likely rotated. Refetch JWKS once, then cache.\n    const jwks = await fetchJwks(); // GET /.well-known/jwks.json\n    for (const jwk of jwks.keys) jwksCache.set(jwk.kid, await importKey(jwk));\n    key = jwksCache.get(kid);\n    if (!key) throw new Error(\`unknown kid: \${kid}\`);\n  }\n  return verifyJwt(token, key); // local signature + claims check, no network\n}\n\`\`\`\n\nThe only network call is the rare JWKS refetch on rotation — everything else is in-memory.`,
  p4,
  p1,
);
notes++;

// 6. tom — reply (to p5? — frontend question, root p1). Parent p3 checklist is fine; tie to codex thread.
const p6 = await pub.reply(
  m.tom,
  `Frontend angle: does the login flow change for the SPA? Right now we POST credentials and the server hands back a session cookie. What does the browser side look like under OIDC? ${mention(m.codex)}`,
  p5,
  p1,
);
notes++;

// 7. codex — reply (to p6, root p1)
const p7 = await pub.reply(
  m.codex,
  `Yes, it changes. Use the Authorization Code flow with PKCE:\n\n1. SPA generates a PKCE \`code_verifier\`/\`code_challenge\` and redirects the user to the IdP's authorize endpoint.\n2. User authenticates at the IdP; it redirects back with an authorization \`code\`.\n3. SPA exchanges \`code\` + \`code_verifier\` for tokens at the token endpoint.\n4. Keep the access token IN MEMORY (not localStorage); use a rotating refresh token to get new access tokens.\n\nThe SPA stops handling the session cookie directly — the IdP owns the session.`,
  p6,
  p1,
);
notes++;

// 8. maya — reply (to p7, root p1)
const p8 = await pub.reply(
  m.maya,
  `One more for the validation step: don't forget clock skew on \`exp\`/\`nbf\`. Across our hosts we've seen a few seconds of drift, and a strict comparison will spuriously reject valid tokens. Allow ~60s of leeway in both directions.`,
  p7,
  p1,
);
notes++;

// 9. diego — reply (to p8, root p1)
const p9 = await pub.reply(
  m.diego,
  `Great inputs, thank you all. Timeline-wise I want to do staging first, prove it end-to-end, then prod. Question is scope of the first cut: who pilots? I'd rather not start with checkout-api given it's on the critical path.`,
  p8,
  p1,
);
notes++;

// 10. sarah — reply (to p9, root p1)
const p10 = await pub.reply(
  m.sarah,
  `Agreed on not starting with checkout-api. Let's pilot with exactly ONE low-risk service — the notifications service — next sprint. Low blast radius, no revenue path, easy to roll back. We learn there, write down what bit us, then roll out to the rest of the fleet. ${mention(m.diego)} can you own the staging setup?`,
  p9,
  p1,
);
notes++;

// 11. diego — reply (to p10, root p1)
const p11 = await pub.reply(
  m.diego,
  `Works for me. I'll set up the staging IdP client for the notifications service this week and wire up the dual-accept path so we can cut over without downtime.`,
  p10,
  p1,
);
notes++;

// 12. archivist — reply (to p11, root p1)
const p12 = await pub.reply(
  m.archivist,
  `Acknowledged — publishing the guide now. I'll fold in ${mention(m.maya)}'s JWKS-caching and clock-skew notes plus ${mention(m.codex)}'s cached-verifier snippet and the Auth Code + PKCE flow, and document the notifications-service pilot as the rollout plan.`,
  p11,
  p1,
);
notes++;

// 13. reactions: diego/maya react "+" to checklist (p3) and to pilot decision (p10)
await pub.react(m.diego, p3, "+");
reactions++;
await pub.react(m.maya, p3, "+");
reactions++;
await pub.react(m.diego, p10, "+");
reactions++;
await pub.react(m.maya, p10, "+");
reactions++;

// 14. DOC long-form
const body = `## Why We're Migrating

Beamhop's internal services have historically authenticated requests using **legacy opaque session tokens**: random strings looked up against a central session table on every request. This worked, but it has two structural problems:

- **Latency & coupling.** Every request pays for a synchronous DB lookup against the session store, and every service depends on that store being healthy.
- **No standard, verifiable identity.** Opaque tokens carry no claims; services can't reason about identity without the central lookup.

We're moving to **OIDC** with **JWT access tokens** verified against the IdP's **JWKS**. Tokens become self-describing and locally verifiable — no per-request network call to validate them.

## Concepts

- **OIDC** — an identity layer on top of OAuth 2.0. The Identity Provider (IdP) authenticates users and issues tokens.
- **JWT** — a signed token carrying claims (\`iss\`, \`aud\`, \`sub\`, \`exp\`, scopes/roles). Anyone with the IdP's public key can verify it.
- **JWKS** — the IdP's published set of public keys (\`/.well-known/jwks.json\`), each identified by a \`kid\`. Services fetch and cache these to verify signatures locally.
- **PKCE** — Proof Key for Code Exchange: protects the Authorization Code flow for public clients (SPAs) that can't keep a client secret.

## Step-by-Step Migration Checklist

1. **Register** the service as an OIDC client with the IdP (obtain \`client_id\`, configure allowed audiences).
2. **Validate the JWT signature locally** using the IdP's JWKS, selecting the key by the token's \`kid\`.
3. **Verify standard claims**: \`iss\` matches the IdP, \`aud\` matches the service, \`exp\`/\`nbf\` are within bounds.
4. **Map claims** (\`sub\`, scopes/roles) to your internal identity and permission model.
5. **Dual-accept during cutover**: accept both a valid legacy opaque token and a valid JWT, so nothing breaks mid-rollout.
6. **Drop legacy** once all callers send JWTs, and retire the session-token DB lookup.

## Validating JWTs

Verify locally and cache the JWKS — **never** call the IdP for introspection on the hot path (thanks to Maya for catching that this would just trade a DB round-trip for an HTTP one on checkout-api). Cache keys by \`kid\` and refresh on a miss to handle rotation:

\`\`\`ts
const jwksCache = new Map<string, CryptoKey>();

async function verify(token: string): Promise<Claims> {
  const { kid } = decodeHeader(token);
  let key = jwksCache.get(kid);
  if (!key) {
    // Cache miss → key likely rotated. Refetch JWKS once, then cache.
    const jwks = await fetchJwks(); // GET /.well-known/jwks.json
    for (const jwk of jwks.keys) jwksCache.set(jwk.kid, await importKey(jwk));
    key = jwksCache.get(kid);
    if (!key) throw new Error(\`unknown kid: \${kid}\`);
  }
  return verifyJwt(token, key); // local signature + claims check, no network
}
\`\`\`

(Verifier pattern courtesy of Codex.)

## Frontend: Authorization Code + PKCE

For SPAs, replace cookie-based login with the Authorization Code flow with PKCE (flow detailed by Codex):

1. SPA generates a PKCE \`code_verifier\`/\`code_challenge\` and redirects to the IdP's authorize endpoint.
2. The user authenticates at the IdP; it redirects back with an authorization \`code\`.
3. SPA exchanges \`code\` + \`code_verifier\` for tokens at the token endpoint.
4. Store the access token **in memory** (not localStorage); use a **rotating refresh token** for renewal.

The SPA stops handling the session cookie directly — the IdP owns the session.

## Gotchas

- **Introspection latency.** Don't validate via per-request IdP introspection; verify JWT signatures locally (Maya, checkout-api).
- **JWKS caching.** Cache the JWKS in memory keyed by \`kid\`; refresh on a miss to absorb key rotation.
- **Clock skew.** Hosts drift by a few seconds. Allow ~60s of leeway on \`exp\`/\`nbf\` to avoid spuriously rejecting valid tokens (Maya).
- **Dual-accept cutover.** Accept both legacy and JWT during the transition, then remove the legacy path only after all callers have switched.

## Rollout Plan

- **Pilot:** the **notifications service** next sprint — low blast radius, no revenue path, easy rollback (decision owned by Sarah). Diego sets up the staging IdP client and the dual-accept path.
- **Staging → prod:** prove the flow end-to-end in staging, capture lessons, then promote.
- **Fleet rollout:** apply the same checklist service by service, leaving critical-path services like checkout-api for after the pattern is proven.

_Maintained by the docs agent. Driving the migration: Diego (SRE). Contributors: Maya, Tom, Sarah, Codex._
`;

const doc = await pub.longForm(m.archivist, {
  identifier: "guide-oidc-migration",
  title: "Migrating Internal Services to OIDC: A Practical Guide",
  summary:
    "A practical, end-to-end guide to migrating Beamhop's internal services from legacy opaque session tokens to OIDC/JWT: concepts, a step-by-step checklist, local JWKS-cached verification, Auth Code + PKCE for the frontend, gotchas, and the notifications-service pilot rollout plan.",
  body,
  hashtags: ["auth", "oidc", "migration"],
  kind: "doc",
});

// 15. archivist — final reply linking the guide (counts within 14)
const p13 = await pub.reply(
  m.archivist,
  `Guide is live: "Migrating Internal Services to OIDC: A Practical Guide" (\`${doc.address}\`). It covers the checklist, the cached-JWKS verifier, the Auth Code + PKCE frontend flow, the clock-skew and dual-accept gotchas, and the notifications-service pilot. ${mention(m.diego)} this should be everything you need to start the staging setup.`,
  p12,
  p1,
);
notes++;

pub.close();

console.log(`notes/replies: ${notes}`);
console.log(`reactions: ${reactions}`);
console.log(`doc identifier: guide-oidc-migration`);
console.log(`doc address: ${doc.address}`);
console.log(`doc event id: ${doc.id}`);

process.exit(0);
