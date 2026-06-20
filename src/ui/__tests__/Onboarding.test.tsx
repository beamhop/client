import { describe, expect, test } from "bun:test";
import { generateSecretKey } from "nostr-tools";
import { fireEvent, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { Onboarding } from "../Onboarding.tsx";
import { nsecOf } from "../../nostr/keys.ts";

describe("Onboarding", () => {
  test("creating an identity reveals the keys, then enters the app and persists", async () => {
    renderWithStore(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /create a new identity/i }));

    // The created step shows the npub and a confirmation button.
    expect(await screen.findByText(/Public key/i)).toBeDefined();
    const enter = screen.getByRole("button", { name: /enter verity/i });
    fireEvent.click(enter);

    await waitFor(() => expect(localStorage.getItem("verity.identity.v1")).not.toBeNull());
  });

  test("importing a valid nsec signs in", async () => {
    renderWithStore(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /import an existing nsec/i }));

    const nsec = nsecOf(generateSecretKey());
    fireEvent.change(screen.getByPlaceholderText(/nsec1/i), { target: { value: nsec } });
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    await waitFor(() => expect(localStorage.getItem("verity.identity.v1")).not.toBeNull());
  });

  test("importing garbage surfaces an inline error and does not sign in", async () => {
    renderWithStore(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /import an existing nsec/i }));
    fireEvent.change(screen.getByPlaceholderText(/nsec1/i), { target: { value: "not-a-key" } });
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    expect(await screen.findByText(/Expected an nsec/i)).toBeDefined();
    expect(localStorage.getItem("verity.identity.v1")).toBeNull();
  });

  test("the NIP-07 option is hidden when no signer is present", () => {
    renderWithStore(<Onboarding />);
    expect(screen.queryByRole("button", { name: /connect signer/i })).toBeNull();
  });
});
