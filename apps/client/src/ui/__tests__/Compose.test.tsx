import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { act, fireEvent, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { Compose } from "../Compose.tsx";
import { Kind } from "@beamhop/nostr";
import type { Identity } from "@beamhop/nostr";

const sk = generateSecretKey();
const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

describe("Compose", () => {
  test("publishes a note, toasts, and closes", async () => {
    let closed = false;
    const { pool } = renderWithStore(<Compose onClose={() => (closed = true)} />, { identity });
    await waitFor(() => expect(screen.getByTestId("compose-input-modal")).toBeDefined());

    fireEvent.change(screen.getByTestId("compose-input-modal"), { target: { value: "hello world" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("post-submit"));
    });

    await waitFor(() => expect(closed).toBe(true));
    const note = pool?.published.find((e) => e.kind === Kind.Note);
    expect(note?.content).toBe("hello world");
  });

  test("the submit button is disabled until there is trimmed text", async () => {
    const { container } = renderWithStore(<Compose onClose={() => undefined} />, { identity });
    await waitFor(() => screen.getByTestId("post-submit"));
    const submit = screen.getByTestId("post-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("compose-input-modal"), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("compose-input-modal"), { target: { value: "real" } });
    expect(submit.disabled).toBe(false);
    void container;
  });

  test("the close button invokes onClose", async () => {
    let closed = false;
    renderWithStore(<Compose onClose={() => (closed = true)} />, { identity });
    await waitFor(() => screen.getByTestId("compose-close"));
    fireEvent.click(screen.getByTestId("compose-close"));
    expect(closed).toBe(true);
  });
});
