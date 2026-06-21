import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { fireEvent, renderWithStore, screen, waitFor, within } from "../../../test/render.tsx";
import { MobileNav, mobileNavSlots } from "../Sidebar.tsx";
import type { Identity } from "@beamhop/nostr";

const sk = generateSecretKey();
const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

const setWidth = (w: number): void => {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
};

afterEach(() => {
  setWidth(1024);
  window.location.hash = "";
});

describe("mobileNavSlots", () => {
  test("scales the per-side tab count with viewport width, clamped to 2–4", () => {
    expect(mobileNavSlots(320)).toBe(2);
    expect(mobileNavSlots(360)).toBe(2);
    expect(mobileNavSlots(430)).toBe(3);
    expect(mobileNavSlots(580)).toBe(4);
    expect(mobileNavSlots(900)).toBe(4); // clamped down
    expect(mobileNavSlots(240)).toBe(2); // clamped up
  });
});

describe("MobileNav", () => {
  test("keeps the compose button as the exact middle with symmetric sides", async () => {
    setWidth(430); // → 3 tabs per side
    renderWithStore(<MobileNav onCompose={() => undefined} onOpenPalette={() => undefined} />, { identity });
    const nav = await waitFor(() => screen.getByTestId("bottom-nav"));

    const left = screen.getByTestId("bottom-nav-left");
    const right = screen.getByTestId("bottom-nav-right");
    const compose = screen.getByTestId("compose-button-mobile");

    // Equal counts each side → compose is the true median button.
    expect(left.children.length).toBe(right.children.length);
    expect(left.children.length).toBe(3);
    // Nav DOM order is [left group, compose, right group]: compose is dead centre.
    expect(nav.children.length).toBe(3);
    expect(nav.children[1]).toBe(compose);
  });

  test("adapts the visible tab count to width without overflowing", async () => {
    setWidth(340); // → 2 per side (narrowest)
    const narrow = renderWithStore(<MobileNav onCompose={() => undefined} onOpenPalette={() => undefined} />, { identity });
    await waitFor(() => screen.getByTestId("bottom-nav"));
    expect(screen.getByTestId("bottom-nav-left").children.length).toBe(2);
    expect(screen.getByTestId("bottom-nav-right").children.length).toBe(2); // 1 tab + More
    narrow.unmount();

    setWidth(580); // → 4 per side (tablet width)
    renderWithStore(<MobileNav onCompose={() => undefined} onOpenPalette={() => undefined} />, { identity });
    await waitFor(() => screen.getByTestId("bottom-nav"));
    expect(screen.getByTestId("bottom-nav-left").children.length).toBe(4);
    expect(screen.getByTestId("bottom-nav-right").children.length).toBe(4);
  });

  test("the More sheet holds the overflow destinations and navigates", async () => {
    setWidth(430); // slots=3 → agents/docs/security overflow into More
    renderWithStore(<MobileNav onCompose={() => undefined} onOpenPalette={() => undefined} />, { identity });
    await waitFor(() => screen.getByTestId("bottom-nav"));

    expect(screen.queryByTestId("tab-docs")).toBeNull(); // not a visible tab at this width

    fireEvent.click(screen.getByTestId("tab-more"));
    const sheet = await waitFor(() => screen.getByTestId("more-sheet"));
    expect(within(sheet).getByTestId("more-docs")).toBeDefined();
    expect(within(sheet).getByTestId("more-security")).toBeDefined();

    fireEvent.click(within(sheet).getByTestId("more-docs"));
    expect(window.location.hash).toBe("#/docs");
    await waitFor(() => expect(screen.queryByTestId("more-sheet")).toBeNull());
  });
});
