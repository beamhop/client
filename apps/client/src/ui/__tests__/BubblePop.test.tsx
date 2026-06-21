import { describe, expect, test } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import { BubblePop } from "../BubblePop.tsx";

describe("BubblePop", () => {
  test("shows no bubble until the active key changes", () => {
    render(
      <BubblePop activeKey={null} message="Liked">
        <button type="button">heart</button>
      </BubblePop>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "heart" })).toBeDefined();
  });

  test("pops the message when the active key transitions to a value", async () => {
    const { rerender } = render(
      <BubblePop activeKey={null} message="Liked">
        <button type="button">heart</button>
      </BubblePop>,
    );
    act(() => {
      rerender(
        <BubblePop activeKey={1} message="Liked">
          <button type="button">heart</button>
        </BubblePop>,
      );
    });
    const bubble = await waitFor(() => screen.getByRole("status"));
    expect(bubble.textContent).toContain("Liked");
    expect(bubble.getAttribute("aria-live")).toBe("polite");
  });

  test("hides again when the active key returns to null", async () => {
    const { rerender } = render(
      <BubblePop activeKey={null} message="Liked">
        <span>x</span>
      </BubblePop>,
    );
    act(() => {
      rerender(
        <BubblePop activeKey={1} message="Liked">
          <span>x</span>
        </BubblePop>,
      );
    });
    await waitFor(() => screen.getByRole("status"));
    act(() => {
      rerender(
        <BubblePop activeKey={null} message="Liked">
          <span>x</span>
        </BubblePop>,
      );
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
