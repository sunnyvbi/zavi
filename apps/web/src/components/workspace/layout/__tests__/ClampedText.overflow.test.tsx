// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClampedText } from "../InlineActionBody";

const box = { scroll: 0, client: 0 };
let fireResize: Array<() => void> = [];

class StubResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    fireResize.push(() =>
      callback([], this as unknown as ResizeObserver),
    );
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const BODY = [
  "Post this comment at: https://www.reddit.com/r/cookingforbeginners/comments/1bce",
  "",
  "Before posting:",
  "",
  "- The payout tier structure references the deductible-linked split.",
  "- After posting, open the thread in a logged-out private window.",
].join("\n");

beforeEach(() => {
  fireResize = [];
  box.scroll = 0;
  box.client = 0;
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return box.scroll;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return box.client;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

describe("ClampedText measures after the body is actually laid out", () => {
  it("offers Show more when a body that mounted with no box turns out to overflow, and the toggle expands it", () => {
    render(<ClampedText text={BODY} lines={2} />);

    expect(screen.queryByText("Show more")).toBeNull();

    box.scroll = 240;
    box.client = 48;
    act(() => {
      for (const fire of fireResize) fire();
    });

    const toggle = screen.getByText("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    const collapsed = screen.getByText("Show less");
    expect(collapsed.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Show more")).toBeNull();

    fireEvent.click(collapsed);
    expect(screen.getByText("Show more")).toBeTruthy();
  });

  it("stays silent when the laid-out body fits", () => {
    render(<ClampedText text="One short line." lines={2} />);

    box.scroll = 24;
    box.client = 48;
    act(() => {
      for (const fire of fireResize) fire();
    });

    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("does not forget an overflow it already found when the body is hidden again", () => {
    render(<ClampedText text={BODY} lines={2} />);

    box.scroll = 240;
    box.client = 48;
    act(() => {
      for (const fire of fireResize) fire();
    });
    expect(screen.getByText("Show more")).toBeTruthy();

    box.scroll = 0;
    box.client = 0;
    act(() => {
      for (const fire of fireResize) fire();
    });

    expect(screen.getByText("Show more")).toBeTruthy();
  });
});
