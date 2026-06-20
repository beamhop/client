import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { fireEvent, renderWithStore, waitFor } from "../../../test/render.tsx";
import type { Identity } from "../../nostr/keys.ts";
import { parseMuteSettings } from "../../lib/mute.ts";
import { ProfileView } from "../Profile.tsx";

/**
 * The per-account soft-mute control lives in the profile header actions. It is
 * an "account"-type mute via the store's `toggleMuteAccount`, which both flips
 * the label (re-render off `state.muteSettings.rules`) and persists to the
 * identity-scoped localStorage key the provider boots from. The control belongs
 * only to the non-me branch, so a user's own profile must never expose it.
 */

const MUTES_KEY = "verity.mutes.v1";
const mutesKey = (pubkey: string): string => `${MUTES_KEY}:${pubkey}`;

const newIdentity = (): Identity => {
  const sk = generateSecretKey();
  return { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };
};

/** The hash the provider parses at construction to route to another user. */
const openOther = (pubkey: string): void => {
  window.location.hash = `#/profile/${pubkey}`;
};

/** Read back the rules the store persisted for `me`. */
const persistedRules = (myPubkey: string) =>
  parseMuteSettings(JSON.parse(localStorage.getItem(mutesKey(myPubkey)) ?? "null")).rules;

afterEach(() => {
  window.location.hash = "";
});

describe("Profile soft-mute control", () => {
  test("muting another user flips Mute → Unmute and persists an account rule", async () => {
    const me = newIdentity();
    const other = newIdentity();
    openOther(other.pubkey);

    renderWithStore(<ProfileView />, { identity: me });

    const button = await waitFor(() => {
      const el = document.querySelector('[data-testid="profile-mute"]');
      if (!el) throw new Error("mute control not rendered");
      return el as HTMLButtonElement;
    });
    expect(button.textContent).toBe("Mute");
    // Nothing persisted yet.
    expect(persistedRules(me.pubkey)).toHaveLength(0);

    fireEvent.click(button);

    // Label flips off the live store; localStorage holds an account rule for `other`.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="profile-mute"]')?.textContent).toBe("Unmute");
    });
    const rules = persistedRules(me.pubkey);
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule?.type).toBe("account");
    expect(rule && rule.type === "account" ? rule.pubkey : undefined).toBe(other.pubkey);
  });

  test("clicking Unmute removes the rule and restores Mute", async () => {
    const me = newIdentity();
    const other = newIdentity();
    openOther(other.pubkey);

    renderWithStore(<ProfileView />, { identity: me });

    const button = await waitFor(() => {
      const el = document.querySelector('[data-testid="profile-mute"]');
      if (!el) throw new Error("mute control not rendered");
      return el as HTMLButtonElement;
    });

    fireEvent.click(button); // mute
    await waitFor(() => {
      expect(document.querySelector('[data-testid="profile-mute"]')?.textContent).toBe("Unmute");
    });

    fireEvent.click(document.querySelector('[data-testid="profile-mute"]') as HTMLButtonElement); // unmute
    await waitFor(() => {
      expect(document.querySelector('[data-testid="profile-mute"]')?.textContent).toBe("Mute");
    });
    expect(persistedRules(me.pubkey)).toHaveLength(0);
  });

  test("the control is not shown on the current user's own profile", async () => {
    const me = newIdentity();
    openOther(me.pubkey); // viewing my own pubkey => isMe

    const { container } = renderWithStore(<ProfileView />, { identity: me });

    // The own-profile branch renders the Edit-profile button instead.
    await waitFor(() => {
      if (!container.querySelector('[data-testid="edit-profile-button"]')) {
        throw new Error("own profile not ready");
      }
    });
    expect(document.querySelector('[data-testid="profile-mute"]')).toBeNull();
  });
});
