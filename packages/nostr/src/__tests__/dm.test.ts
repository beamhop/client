import { afterEach, describe, expect, test } from "bun:test";
import { finalizeEvent, nip04 } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import { buildDm, decodeDm, decryptDm, dmPeer, encryptDm } from "../dm.ts";
import { createLocalIdentity, type Identity, type Nip07 } from "../keys.ts";
import { Kind } from "../types.ts";

afterEach(() => {
  delete (window as { nostr?: Nip07 }).nostr;
});

const local = (): Extract<Identity, { kind: "local" }> => {
  const id = createLocalIdentity();
  if (id.kind !== "local") throw new Error("expected local identity");
  return id;
};

const sign = (id: Extract<Identity, { kind: "local" }>, t: EventTemplate) => finalizeEvent(t, id.secretKey);

describe("NIP-04 direct messages", () => {
  test("encrypt then decrypt round-trips between two local identities", async () => {
    const alice = local();
    const bob = local();
    const cipher = await encryptDm(alice, bob.pubkey, "hello bob");
    expect(cipher).not.toBe("hello bob");
    // Bob decrypts using Alice as the peer.
    const plain = await decryptDm(bob, alice.pubkey, cipher);
    expect(plain).toBe("hello bob");
  });

  test("buildDm produces a kind-4 event tagged with the recipient", () => {
    const tmpl = buildDm("b".repeat(64), "ciphertext");
    expect(tmpl.kind).toBe(Kind.EncryptedDM);
    expect(tmpl.tags).toContainEqual(["p", "b".repeat(64)]);
    expect(tmpl.content).toBe("ciphertext");
  });
});

describe("NIP-07 signer-backed DMs", () => {
  test("delegates encrypt/decrypt to the signer's nip04 when present", async () => {
    const me = local();
    const peer = local();
    // A signer that genuinely performs nip04 with the held key.
    const signer: Nip07 = {
      getPublicKey: async () => me.pubkey,
      signEvent: async (t) => finalizeEvent(t, me.secretKey),
      nip04: {
        encrypt: async (pk, text) => nip04.encrypt(me.secretKey, pk, text),
        decrypt: async (pk, ct) => nip04.decrypt(me.secretKey, pk, ct),
      },
    };
    window.nostr = signer;

    const identity: Identity = { kind: "nip07", pubkey: me.pubkey };
    const cipher = await encryptDm(identity, peer.pubkey, "hi via extension");
    // Peer (a local identity) can decrypt what the signer produced.
    expect(await decryptDm(peer, me.pubkey, cipher)).toBe("hi via extension");
    // And the signer can decrypt back too.
    expect(await decryptDm(identity, peer.pubkey, cipher)).toBe("hi via extension");
  });

  test("throws when the signer cannot encrypt or decrypt DMs", () => {
    const me = local();
    // A signer with no nip04 capability.
    window.nostr = {
      getPublicKey: async () => me.pubkey,
      signEvent: async (t) => finalizeEvent(t, me.secretKey),
    };
    const identity: Identity = { kind: "nip07", pubkey: me.pubkey };
    expect(encryptDm(identity, "b".repeat(64), "x")).rejects.toThrow("Signer cannot encrypt DMs");
    expect(decryptDm(identity, "b".repeat(64), "x")).rejects.toThrow("Signer cannot decrypt DMs");
  });
});

describe("dmPeer", () => {
  const me = "a".repeat(64);
  const them = "b".repeat(64);
  const dmEvent = (pubkey: string, pTags: string[]) => ({
    id: "1".repeat(64),
    pubkey,
    sig: "",
    kind: Kind.EncryptedDM,
    created_at: 1,
    content: "x",
    tags: pTags.map((p) => ["p", p]),
  });

  test("an outgoing DM's peer is its p-tag recipient", () => {
    expect(dmPeer(dmEvent(me, [them]), me)).toBe(them);
  });

  test("an incoming DM's peer is its author", () => {
    expect(dmPeer(dmEvent(them, [me]), me)).toBe(them);
  });

  test("a DM that neither mentions nor comes from me has no peer", () => {
    expect(dmPeer(dmEvent(them, ["c".repeat(64)]), me)).toBeNull();
  });
});

describe("decodeDm", () => {
  test("decodes an incoming encrypted DM into a plaintext message", async () => {
    const me = local();
    const peer = local();
    const cipher = await encryptDm(peer, me.pubkey, "secret hi");
    const event = sign(peer, buildDm(me.pubkey, cipher));

    const decoded = await decodeDm(me, me.pubkey, event);
    expect(decoded).not.toBeNull();
    expect(decoded).toMatchObject({
      id: event.id,
      pubkey: peer.pubkey,
      content: "secret hi",
      fromMe: false,
    });
  });

  test("marks a message authored by me as fromMe", async () => {
    const me = local();
    const peer = local();
    const cipher = await encryptDm(me, peer.pubkey, "from me");
    const event = sign(me, buildDm(peer.pubkey, cipher));

    const decoded = await decodeDm(me, me.pubkey, event);
    expect(decoded?.fromMe).toBe(true);
    expect(decoded?.pubkey).toBe(peer.pubkey);
  });

  test("returns null when the event is unrelated to me", async () => {
    const me = local();
    const peer = local();
    const other = local();
    const cipher = await encryptDm(peer, other.pubkey, "not for me");
    const event = sign(peer, buildDm(other.pubkey, cipher));

    expect(await decodeDm(me, me.pubkey, event)).toBeNull();
  });

  test("returns null when the ciphertext cannot be decrypted", async () => {
    const me = local();
    const peer = local();
    const event = sign(peer, buildDm(me.pubkey, "not-valid-ciphertext"));

    expect(await decodeDm(me, me.pubkey, event)).toBeNull();
  });
});
