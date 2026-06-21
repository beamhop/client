import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { act, fireEvent, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { Toasts } from "../Toasts.tsx";
import { ProfileToastChip } from "../ProfileToastChip.tsx";
import { useStore, type Store } from "@beamhop/state";

const pk = getPublicKey(generateSecretKey());

afterEach(() => {
  window.location.hash = "";
});

let store: Store | null = null;
const Probe = (): null => {
  store = useStore();
  return null;
};

describe("Toasts", () => {
  test("renders queued toast text from the store", async () => {
    renderWithStore(
      <>
        <Probe />
        <Toasts />
      </>,
    );
    await waitFor(() => expect(store?.state.ready).toBe(true));

    act(() => store?.toast("Saved to bookmarks", "check"));
    expect(screen.getByText("Saved to bookmarks")).toBeDefined();
  });

  test("renders a profile chip for a toast with a profile action", async () => {
    renderWithStore(
      <>
        <Probe />
        <Toasts />
      </>,
    );
    await waitFor(() => expect(store?.state.ready).toBe(true));

    act(() => store?.toast("Followed", "check", { type: "profile", pubkey: pk }));
    expect(await screen.findByRole("button", { name: /profile/i })).toBeDefined();
  });
});

describe("ProfileToastChip", () => {
  test("renders a fallback handle and navigates to the profile on click", async () => {
    renderWithStore(<ProfileToastChip pubkey={pk} />);
    const button = await screen.findByRole("button", { name: /profile/i });
    fireEvent.click(button);
    expect(window.location.hash).toContain(`/profile/${pk}`);
  });
});
