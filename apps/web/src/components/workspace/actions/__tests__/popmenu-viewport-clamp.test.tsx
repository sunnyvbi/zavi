// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PopMenu } from "../PopMenu";

const VIEWPORT = 390;
const MENU_WIDTH = 320;
const EDGE = 8;

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

let trigger = rect(181, 400, 60, 40);

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.getAttribute("role") === "menu") {
        const right = parseFloat(this.style.right || "0");
        const left = window.innerWidth - right - MENU_WIDTH;
        return rect(left, 120, MENU_WIDTH, 240);
      }
      if (this.getAttribute("aria-haspopup") === "menu") return trigger;
      return rect(0, 0, 0, 0);
    },
  );
}

function open() {
  render(
    <PopMenu
      label="Dismiss"
      width="w-80"
      heading="Dismiss: why? Zavi uses your answer to improve."
      trigger={() => "Dismiss"}
      items={[
        { label: "Remind me next week", hint: "It comes back on Sep 29", onSelect: () => {} },
        { label: "Not relevant for us", onSelect: () => {} },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  return screen.getByRole("menu");
}

const geometry = (menu: HTMLElement) => {
  const right = parseFloat(menu.style.right || "0");
  return { right, left: window.innerWidth - right - MENU_WIDTH };
};

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: VIEWPORT, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  trigger = rect(181, 400, 60, 40);
  stubLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the card menu at phone width", () => {
  it("stays inside the left edge when the trigger sits nearer the left than the panel is wide", () => {
    const menu = open();
    const { left } = geometry(menu);

    expect(window.innerWidth - trigger.right - MENU_WIDTH).toBeLessThan(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBe(EDGE);
  });

  it("never lets either edge of the panel leave the viewport", () => {
    const menu = open();
    const { left } = geometry(menu);

    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + MENU_WIDTH).toBeLessThanOrEqual(window.innerWidth);
  });

  it("leaves a panel that already fits exactly where the trigger put it", () => {
    trigger = rect(320, 400, 60, 40);
    const menu = open();

    expect(geometry(menu).right).toBe(window.innerWidth - trigger.right);
    expect(geometry(menu).left).toBeGreaterThan(EDGE);
  });

  it("caps the panel at the viewport so a wide one cannot be wider than the screen", () => {
    const menu = open();

    expect(menu.style.maxWidth).toBe(`calc(100vw - ${EDGE * 2}px)`);
  });

  it("re-clamps the next time it opens against a trigger that has moved", () => {
    const first = open();
    expect(geometry(first).left).toBe(EDGE);

    cleanup();
    trigger = rect(330, 400, 50, 40);
    const second = open();
    expect(geometry(second).right).toBe(window.innerWidth - 380);
  });
});
