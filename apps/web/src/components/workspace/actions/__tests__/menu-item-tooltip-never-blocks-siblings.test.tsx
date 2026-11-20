// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PopMenu } from "../PopMenu";
import { ActionTooltip } from "../ActionTooltip";
import { makeAction } from "./fixtures";

const dismissItems = (a: ReturnType<typeof makeAction>, h: { onSetStatus: (...args: unknown[]) => void; onOpenRedoChat: (...args: unknown[]) => void }) => [
  { label: "Remind me next week", tooltip: "Hides it for a week.", onSelect: () => h.onSetStatus(a, "snoozed", { until: new Date().toISOString() }) },
  { label: "Ask for a rewrite", tooltip: "Zavi writes a new version.", onSelect: () => h.onOpenRedoChat(a) },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a menu item's tooltip never covers its siblings", () => {
  it("lets Remind me next week be chosen while Ask for a rewrite's tooltip is open", () => {
    const onSetStatus = vi.fn();
    const onOpenRedoChat = vi.fn();
    const a = makeAction("other");
    const items = [
      {
        label: "Dismiss",
        submenu: {
          heading: "Dismiss: why?",
          items: dismissItems(a, { onSetStatus, onOpenRedoChat } as never),
        },
      },
    ];
    render(<PopMenu items={items} trigger={() => "more"} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Dismiss/ }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: /Ask for a rewrite/ }).parentElement as HTMLElement, { pointerType: "mouse" });
    const tip = screen.getByRole("tooltip");
    expect(tip.className).toContain("pointer-events-none");
    fireEvent.click(screen.getByRole("menuitem", { name: /Remind me next week/ }));
    expect(onSetStatus).toHaveBeenCalledTimes(1);
    expect(onSetStatus).toHaveBeenCalledWith(a, "snoozed", expect.objectContaining({ until: expect.any(String) }));
    expect(onOpenRedoChat).not.toHaveBeenCalled();
  });

  it("keeps the tooltip of an ordinary button hoverable", () => {
    render(
      <ActionTooltip description="About this" label="Go">
        <button>Go</button>
      </ActionTooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Go" }).parentElement as HTMLElement, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip").className).not.toContain("pointer-events-none");
  });
});

describe("a menu item's tooltip sits beside the menu, not over it", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  const open = () => {
    const a = makeAction("other");
    const items = [{ label: "Dismiss", submenu: { heading: "Dismiss: why?", items: dismissItems(a, { onSetStatus: vi.fn(), onOpenRedoChat: vi.fn() } as never) } }];
    render(<PopMenu items={items} trigger={() => "more"} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Dismiss/ }));
    fireEvent.pointerEnter(screen.getByRole("menuitem", { name: /Ask for a rewrite/ }).parentElement as HTMLElement, { pointerType: "mouse" });
    return screen.getByRole("tooltip");
  };

  const stub = (viewport: number) => {
    Object.defineProperty(window, "innerWidth", { value: viewport, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "menu") return rect(100, 200, 320, 240);
      if (this.getAttribute("role") === "tooltip") return rect(0, 0, 300, 120);
      if (this.tagName === "SPAN" && this.querySelector('[role="menuitem"]')) return rect(108, 360, 304, 60);
      return rect(0, 0, 0, 0);
    });
  };

  it("lands wholly right of the menu when there is room", () => {
    stub(1200);
    const tip = open();
    expect(parseFloat(tip.style.left)).toBeGreaterThanOrEqual(420);
  });

  it("lands wholly left of the menu when only the left has room", () => {
    stub(760);
    Object.defineProperty(window, "innerWidth", { value: 760, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "menu") return rect(420, 200, 320, 240);
      if (this.getAttribute("role") === "tooltip") return rect(0, 0, 300, 120);
      if (this.tagName === "SPAN" && this.querySelector('[role="menuitem"]')) return rect(428, 360, 304, 60);
      return rect(0, 0, 0, 0);
    });
    const tip = open();
    expect(parseFloat(tip.style.left) + 300).toBeLessThanOrEqual(420);
  });

  it("goes under the whole menu, never over an option, on a phone", () => {
    stub(390);
    const tip = open();
    const top = parseFloat(tip.style.top);
    expect(top).toBeGreaterThanOrEqual(440);
  });
});
