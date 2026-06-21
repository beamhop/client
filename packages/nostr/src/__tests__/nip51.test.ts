import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { Identity } from "../keys.ts";
import { buildMuteList, parseMuteList } from "../nip51.ts";
import type { MuteSettings } from "@beamhop/lib";
import { createRule } from "@beamhop/lib";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const identity: Identity = { kind: "local", secretKey: sk, pubkey };

const NOW_MS = Date.now();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("buildMuteList / parseMuteList round-trip", () => {
  test("account rule survives round-trip", async () => {
    const target = getPublicKey(generateSecretKey());
    const settings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "account", pubkey: target })],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ type: "account", pubkey: target });
  });

  test("keyword rule survives round-trip", async () => {
    const settings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "casino" })],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ type: "keyword", value: "casino" });
  });

  test("regex rule survives round-trip", async () => {
    const settings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "regex", source: "buy\\s+now", flags: "i" })],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ type: "regex", source: "buy\\s+now" });
  });

  test("expiresAt is encoded and decoded (ms precision preserved within 1s)", async () => {
    const expiresAt = NOW_MS + ONE_DAY_MS;
    const settings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "airdrop", expiresAt })],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules).toHaveLength(1);
    const rule = result.rules[0];
    expect(rule?.expiresAt).toBeDefined();
    // Round-tripped through unix seconds, so within 1000ms of original.
    expect(Math.abs((rule?.expiresAt ?? 0) - expiresAt)).toBeLessThan(1000);
  });

  test("expiresAt is encoded for account and regex rules too", async () => {
    const target = getPublicKey(generateSecretKey());
    const expiresAt = NOW_MS + 7 * ONE_DAY_MS;
    const settings: MuteSettings = {
      display: "hidden",
      rules: [
        createRule({ type: "account", pubkey: target, expiresAt }),
        createRule({ type: "regex", source: "scam", expiresAt }),
      ],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules).toHaveLength(2);
    for (const rule of result.rules) {
      expect(Math.abs((rule.expiresAt ?? 0) - expiresAt)).toBeLessThan(1000);
    }
  });

  test("already-expired rules are stripped from the published event", async () => {
    const pastExpiry = NOW_MS - ONE_DAY_MS; // expired yesterday
    const futureExpiry = NOW_MS + ONE_DAY_MS;
    const settings: MuteSettings = {
      display: "hidden",
      rules: [
        createRule({ type: "keyword", value: "expired-keyword", expiresAt: pastExpiry }),
        createRule({ type: "keyword", value: "active-keyword", expiresAt: futureExpiry }),
      ],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ type: "keyword", value: "active-keyword" });
  });

  test("rules without expiresAt round-trip with no expiry field", async () => {
    const settings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "permanent" })],
    };

    const template = await buildMuteList(settings, identity);
    const fake = { ...template, id: "x", pubkey, sig: "x", created_at: template.created_at ?? 0 };
    const result = await parseMuteList(fake, identity);

    expect(result.rules[0]?.expiresAt).toBeUndefined();
  });

  test("parseMuteList returns empty settings when content is empty", async () => {
    const fake = { kind: 10000, id: "x", pubkey, sig: "x", created_at: 0, tags: [], content: "" };
    const result = await parseMuteList(fake, identity);
    expect(result.rules).toHaveLength(0);
  });
});
