import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import {
  clearPersisted,
  connectNip07,
  createLocalIdentity,
  hasNip07,
  importSecret,
  loadPersisted,
  npubOf,
  nsecOf,
  persist,
  shortNpub,
  signWith,
  type Nip07,
} from "../keys.ts";

/** A genuine (not hollow) NIP-07 signer backed by a real local key. */
const stubSigner = (): { signer: Nip07; pubkey: string } => {
  const sk = createLocalIdentity();
  if (sk.kind !== "local") throw new Error("expected local");
  return {
    pubkey: sk.pubkey,
    signer: {
      getPublicKey: async () => sk.pubkey,
      signEvent: async (template: EventTemplate) => finalizeEvent(template, sk.secretKey),
    },
  };
};

afterEach(() => {
  delete (window as { nostr?: Nip07 }).nostr;
});

describe("key handling", () => {
  test("a generated local identity exposes a matching pubkey", () => {
    const id = createLocalIdentity();
    expect(id.kind).toBe("local");
    if (id.kind === "local") {
      expect(getPublicKey(id.secretKey)).toBe(id.pubkey);
      expect(id.pubkey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("an nsec round-trips through encode then import", () => {
    const id = createLocalIdentity();
    if (id.kind !== "local") throw new Error("expected local");
    const nsec = nsecOf(id.secretKey);
    expect(nsec).toMatch(/^nsec1/);
    const reimported = importSecret(nsec);
    expect(reimported.pubkey).toBe(id.pubkey);
  });

  test("importing a 64-char hex secret works", () => {
    const id = createLocalIdentity();
    if (id.kind !== "local") throw new Error("expected local");
    const hex = Array.from(id.secretKey, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(importSecret(hex).pubkey).toBe(id.pubkey);
  });

  test("importing garbage throws", () => {
    expect(() => importSecret("not-a-key")).toThrow();
  });

  test("importing trims surrounding whitespace", () => {
    const id = createLocalIdentity();
    if (id.kind !== "local") throw new Error("expected local");
    const hex = Array.from(id.secretKey, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(importSecret(`  ${hex}\n`).pubkey).toBe(id.pubkey);
  });

  test("an npub (not an nsec) is rejected as a secret", () => {
    const npub = npubOf(createLocalIdentity().pubkey);
    expect(() => importSecret(npub)).toThrow();
  });

  test("npub encoding and short display", () => {
    const id = createLocalIdentity();
    const npub = npubOf(id.pubkey);
    expect(npub).toMatch(/^npub1/);
    const short = shortNpub(id.pubkey);
    expect(short).toContain("…");
    expect(short.startsWith("npub1")).toBe(true);
  });
});

describe("identity persistence", () => {
  test("a local identity persists and reloads with the same key", () => {
    const id = createLocalIdentity();
    persist(id);
    const loaded = loadPersisted();
    expect(loaded?.kind).toBe("local");
    expect(loaded?.pubkey).toBe(id.pubkey);
    if (loaded?.kind === "local" && id.kind === "local") {
      expect([...loaded.secretKey]).toEqual([...id.secretKey]);
    }
  });

  test("a nip07 identity persists only its pubkey", () => {
    persist({ kind: "nip07", pubkey: "a".repeat(64) });
    const loaded = loadPersisted();
    expect(loaded).toEqual({ kind: "nip07", pubkey: "a".repeat(64) });
  });

  test("loadPersisted returns null when nothing is stored", () => {
    expect(loadPersisted()).toBeNull();
  });

  test("loadPersisted returns null for corrupt storage", () => {
    localStorage.setItem("beamhop.identity.v1", "{not json");
    expect(loadPersisted()).toBeNull();
  });

  test("clearPersisted removes the stored identity", () => {
    persist(createLocalIdentity());
    clearPersisted();
    expect(loadPersisted()).toBeNull();
  });
});

describe("hasNip07", () => {
  test("is false when no signer extension is present", () => {
    expect(hasNip07()).toBe(false);
  });

  test("is true once a signer is exposed on window", () => {
    window.nostr = stubSigner().signer;
    expect(hasNip07()).toBe(true);
  });
});

describe("NIP-07 signer", () => {
  test("connectNip07 reads the pubkey from the injected signer", async () => {
    const { signer, pubkey } = stubSigner();
    window.nostr = signer;
    expect(await connectNip07()).toEqual({ kind: "nip07", pubkey });
  });

  test("connectNip07 throws when no signer is present", () => {
    expect(connectNip07()).rejects.toThrow("No NIP-07 signer found");
  });

  test("signWith delegates to the signer for a nip07 identity", async () => {
    const { signer, pubkey } = stubSigner();
    window.nostr = signer;
    const signed = await signWith({ kind: "nip07", pubkey }, {
      kind: 1,
      created_at: 1,
      tags: [],
      content: "via extension",
    });
    expect(signed.pubkey).toBe(pubkey);
    expect(signed.content).toBe("via extension");
  });

  test("signWith throws when the nip07 signer has disappeared", () => {
    expect(
      signWith({ kind: "nip07", pubkey: "a".repeat(64) }, { kind: 1, created_at: 1, tags: [], content: "x" }),
    ).rejects.toThrow("NIP-07 signer disappeared");
  });
});
