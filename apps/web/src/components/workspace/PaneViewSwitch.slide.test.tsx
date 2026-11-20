// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { PaneViewSwitch } from "./PaneViewSwitch";

const RAIL_BORDER = 1;
const HALF_W = 146;
const BOARD_LEFT = 5;
const CHAT_LEFT = 155;

const props = {
  label: "Growth view",
  boardLabel: "Growth plan",
  controls: "growth-chat-panel",
  onChange: vi.fn(),
};

let laidOut = true;

function stubLayout() {
  for (const [prop, get] of [
    [
      "offsetWidth",
      function (this: HTMLElement) {
        if (!laidOut) return 0;
        return this.tagName === "BUTTON" ? HALF_W : 300;
      },
    ],
    [
      "offsetLeft",
      function (this: HTMLElement) {
        if (this.tagName !== "BUTTON") return 0;
        return this.textContent === "Chat" ? CHAT_LEFT : BOARD_LEFT;
      },
    ],
    [
      "clientLeft",
      function (this: HTMLElement) {
        return this.tagName === "BUTTON" ? 0 : RAIL_BORDER;
      },
    ],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
  }
}

beforeEach(() => {
  laidOut = true;
  stubLayout();
});

afterEach(() => {
  cleanup();
  for (const prop of ["offsetWidth", "offsetLeft", "clientLeft"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
});

function pillOf(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-testid="pane-switch-pill"]');
}

function halves(container: HTMLElement) {
  return [...container.querySelectorAll("button")];
}

describe("the switch slides its pill instead of blinking it across", () => {
  it("parks the pill on the half that is active, measured off the rail", () => {
    const { container } = render(<PaneViewSwitch {...props} chatOpen={false} />);
    const pill = pillOf(container);
    expect(pill).not.toBeNull();
    expect(pill!.style.transform).toBe(`translateX(${BOARD_LEFT - RAIL_BORDER}px)`);
    expect(pill!.style.width).toBe(`${HALF_W}px`);
  });

  it("moves the SAME element to the other half rather than repainting a background", () => {
    const { container, rerender } = render(<PaneViewSwitch {...props} chatOpen={false} />);
    const before = pillOf(container);
    rerender(<PaneViewSwitch {...props} chatOpen />);
    const after = pillOf(container);
    expect(after).toBe(before);
    expect(after!.style.transform).toBe(`translateX(${CHAT_LEFT - RAIL_BORDER}px)`);
  });

  it("animates transform and width together, and stops for reduced motion", () => {
    const { container } = render(<PaneViewSwitch {...props} chatOpen />);
    const cls = pillOf(container)!.className;
    expect(cls).toContain("transition-[transform,width]");
    expect(cls).toContain("duration-300");
    expect(cls).toContain("ease-out");
    expect(cls).toContain("motion-reduce:transition-none");
  });

  it("never paints two pills: once measured, the active half drops its own fill", () => {
    const { container } = render(<PaneViewSwitch {...props} chatOpen />);
    expect(pillOf(container)).not.toBeNull();
    for (const half of halves(container)) {
      expect(half.className).not.toContain("bg-bone");
    }
  });

  it("still shows the active half before anything has been measured", () => {
    laidOut = false;
    const { container } = render(<PaneViewSwitch {...props} chatOpen />);
    expect(pillOf(container)).toBeNull();
    const active = halves(container).find((b) => b.getAttribute("aria-pressed") === "true");
    expect(active!.textContent).toBe("Chat");
    expect(active!.className).toContain("bg-bone");
  });

  it("keeps the pill out of the accessibility tree and out of the way of taps", () => {
    const { container } = render(<PaneViewSwitch {...props} chatOpen />);
    const pill = pillOf(container)!;
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(pill.className).toContain("pointer-events-none");
  });

  it("does not crash where ResizeObserver is missing, which is where it renders in tests", () => {
    expect(typeof ResizeObserver).toBe("undefined");
    const { container } = render(<PaneViewSwitch {...props} chatOpen={false} />);
    expect(pillOf(container)).not.toBeNull();
  });
});
