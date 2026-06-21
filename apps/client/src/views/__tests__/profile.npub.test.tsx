import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { fireEvent, renderWithStore, waitFor } from "../../../test/render.tsx";
import { npubOf, shortNpub, type Identity } from "@beamhop/nostr";
import { ProfileView } from "../Profile.tsx";

/**
 * Every profile — your own and anyone else's — exposes a copyable public-key
 * chip in the identity header. Clicking it writes the bech32 `npub` (not the raw
 * hex) to the clipboard so the key can be shared anywhere a Nostr id is expected.
 */

const newIdentity = (): Identity => {
  const sk = generateSecretKey();
  return { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };
};

/** The hash the provider parses at construction to route to a given pubkey. */
const openProfile = (pubkey: string): void => {
  window.location.hash = `#/profile/${pubkey}`;
};

let copied: string[] = [];

beforeEach(() => {
  copied = [];
  // happy-dom ships no clipboard; install a capturing stub for the copy path.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string): Promise<void> => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  window.location.hash = "";
});

const findChip = async (root: ParentNode): Promise<HTMLButtonElement> =>
  waitFor(() => {
    const el = root.querySelector('[data-testid="profile-npub-copy"]');
    if (!el) throw new Error("npub chip not rendered");
    return el as HTMLButtonElement;
  });

describe("Profile public-key chip", () => {
  test("another user's profile shows a chip that copies their npub", async () => {
    const me = newIdentity();
    const other = newIdentity();
    openProfile(other.pubkey);

    const { container } = renderWithStore(<ProfileView />, { identity: me });

    const chip = await findChip(container);
    // The chip shows the abbreviated key and carries the full npub for hover/copy.
    expect(chip.textContent).toContain(shortNpub(other.pubkey));
    expect(chip.getAttribute("title")).toBe(npubOf(other.pubkey));

    fireEvent.click(chip);
    await waitFor(() => expect(copied).toEqual([npubOf(other.pubkey)]));
  });

  test("the chip is present on your own profile too", async () => {
    const me = newIdentity();
    openProfile(me.pubkey); // viewing my own pubkey => isMe

    const { container } = renderWithStore(<ProfileView />, { identity: me });

    const chip = await findChip(container);
    fireEvent.click(chip);
    await waitFor(() => expect(copied).toEqual([npubOf(me.pubkey)]));
  });
});
