import { beforeEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { act, fireEvent, renderWithStore, screen, within } from "../../../test/render.tsx";
import type { Identity } from "../../nostr/keys.ts";
import type { MuteDisplay, MuteRule } from "../../lib/mute.ts";
import { SecurityView } from "../Security.tsx";

const sk = generateSecretKey();
const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

const MUTES_KEY = `verity.mutes.v1:${identity.pubkey}`;

/** Read what the store persisted for this identity, typed (no `any`). */
type PersistedMutes = { version: number; display: MuteDisplay; rules: MuteRule[] };

const readPersisted = (): PersistedMutes | null => {
  const raw = localStorage.getItem(MUTES_KEY);
  if (raw === null) return null;
  return JSON.parse(raw) as PersistedMutes;
};

const persistedRules = (): MuteRule[] => readPersisted()?.rules ?? [];

beforeEach(() => {
  window.location.hash = "#/settings";
});

describe("Security · Muted content card", () => {
  test("typing a keyword and clicking Mute word adds a rule (list + storage)", () => {
    renderWithStore(<SecurityView />, { identity });

    // Nothing persisted, friendly empty state shown.
    expect(localStorage.getItem(MUTES_KEY)).toBeNull();
    expect(screen.getByText(/No mute rules yet/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Word to mute"), { target: { value: "airdrop" } });
    act(() => fireEvent.click(screen.getByRole("button", { name: "Mute word" })));

    // Persisted: exactly one keyword rule with the trimmed value.
    const rules = persistedRules();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule?.type).toBe("keyword");
    expect(rule).toMatchObject({ type: "keyword", value: "airdrop", enabled: true });

    // Visible in the rule list, under the Keywords group.
    expect(screen.getByText("Keywords · 1")).toBeTruthy();
    expect(screen.getByText("airdrop")).toBeTruthy();
    expect(screen.queryByText(/No mute rules yet/i)).toBeNull();

    // Input cleared after add.
    expect((screen.getByLabelText("Word to mute") as HTMLInputElement).value).toBe("");
  });

  test("toggling display mode persists the flipped value", () => {
    renderWithStore(<SecurityView />, { identity });

    // Default is "hidden"; flip to summary.
    act(() => fireEvent.click(screen.getByTestId("mute-display-summary")));
    expect(readPersisted()?.display).toBe("summary");
    expect(screen.getByTestId("mute-display-summary").getAttribute("aria-pressed")).toBe("true");

    // Flip back to hidden.
    act(() => fireEvent.click(screen.getByTestId("mute-display-hidden")));
    expect(readPersisted()?.display).toBe("hidden");
    expect(screen.getByTestId("mute-display-hidden").getAttribute("aria-pressed")).toBe("true");
  });

  test("invalid regex shows inline error + disables add; valid pattern adds a rule", () => {
    renderWithStore(<SecurityView />, { identity });

    // Reveal the advanced/regex subsection.
    fireEvent.click(screen.getByTestId("mute-advanced-toggle"));

    const regexInput = screen.getByLabelText("Regex pattern to mute");
    const muteButton = screen.getByRole("button", { name: "Mute pattern" });

    // An unbalanced group is invalid: inline alert + aria-invalid + disabled button.
    fireEvent.change(regexInput, { target: { value: "(unclosed" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(regexInput.getAttribute("aria-invalid")).toBe("true");
    expect((muteButton as HTMLButtonElement).disabled).toBe(true);

    // Clicking while invalid must not add anything.
    act(() => fireEvent.click(muteButton));
    expect(localStorage.getItem(MUTES_KEY)).toBeNull();

    // Correct it: error clears, button enables, add succeeds.
    fireEvent.change(regexInput, { target: { value: "^spam.*$" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((muteButton as HTMLButtonElement).disabled).toBe(false);

    act(() => fireEvent.click(muteButton));
    const rules = persistedRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ type: "regex", source: "^spam.*$" });
    expect(screen.getByText("Patterns · 1")).toBeTruthy();
    expect(screen.getByText("/^spam.*$/i")).toBeTruthy();
  });

  test("removing a rule drops it from the list and storage", () => {
    renderWithStore(<SecurityView />, { identity });

    fireEvent.change(screen.getByLabelText("Word to mute"), { target: { value: "spam" } });
    act(() => fireEvent.click(screen.getByRole("button", { name: "Mute word" })));

    const added = persistedRules();
    expect(added).toHaveLength(1);
    const ruleId = added[0]?.id ?? "";
    expect(ruleId).not.toBe("");

    const row = screen.getByTestId(`mute-rule-${ruleId}`);
    act(() => fireEvent.click(within(row).getByRole("button", { name: "Remove mute rule spam" })));

    // Gone from storage and from the DOM; empty state returns.
    expect(persistedRules()).toHaveLength(0);
    expect(screen.queryByTestId(`mute-rule-${ruleId}`)).toBeNull();
    expect(screen.queryByText("spam")).toBeNull();
    expect(screen.getByText(/No mute rules yet/i)).toBeTruthy();
  });

  test("an invalid account input (not npub/hex) does not add a rule", () => {
    renderWithStore(<SecurityView />, { identity });

    fireEvent.change(screen.getByLabelText("Account to mute"), { target: { value: "not-an-npub" } });
    act(() => fireEvent.click(screen.getByRole("button", { name: "Mute account" })));

    // No rule persisted; an empty-state list (no storage write for the rejected add).
    expect(persistedRules()).toHaveLength(0);
    expect(screen.getByText(/No mute rules yet/i)).toBeTruthy();
  });
});
