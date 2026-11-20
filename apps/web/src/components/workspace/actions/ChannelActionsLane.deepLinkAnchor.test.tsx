// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
const { tabs } = vi.hoisted(() => ({ tabs: { current: [] as { id: string; payload: Record<string, unknown> }[] } }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ openTab: vi.fn(), tabs: tabs.current, activeTabId: "c" }),
}));
const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";

const FLASH = "shadow-[0_0_36px_rgba(255,255,255,0.32)]";
const scrollIntoView = vi.fn();
const heights = new Map<Element, number>();
type Observer = { cb: ResizeObserverCallback; targets: Set<Element>; live: boolean };
let observers: Observer[] = [];
let above = 0;
const CARD_TOP: Record<string, number> = { "action-card-1": 0, "action-card-2": 120 };

class FakeResizeObserver {
  o: Observer;
  constructor(cb: ResizeObserverCallback) {
    this.o = { cb, targets: new Set(), live: true };
    observers.push(this.o);
  }
  observe(t: Element) {
    this.o.targets.add(t);
  }
  unobserve(t: Element) {
    this.o.targets.delete(t);
  }
  disconnect() {
    this.o.live = false;
    this.o.targets.clear();
  }
}

function layoutTick() {
  for (const o of observers) {
    if (!o.live || o.targets.size === 0) continue;
    const entries = [...o.targets].map((target) => ({ target, contentRect: { height: heights.get(target) ?? 0 } }) as unknown as ResizeObserverEntry);
    act(() => o.cb(entries, o as unknown as ResizeObserver));
  }
}
function grow(by: number) {
  for (const o of observers) for (const t of o.targets) heights.set(t, (heights.get(t) ?? 0) + by);
}
function growAbove(by: number) {
  above += by;
  grow(by);
  layoutTick();
}
function growBelow(by: number) {
  grow(by);
  layoutTick();
}

function mount(slug: string, container?: HTMLElement) {
  const actions: ChannelActionView[] = [
    makeAction("fix", { id: "card-1", title: "Raise the budget" }),
    makeAction("fix", { id: "card-2", title: "Count sign-ups" }),
  ];
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    const body = u.includes("/actions") ? { actions, more: 0, store: "channel_actions" } : u.includes("/metrics") ? { metrics: [] } : {};
    return { ok: true, status: 200, json: async () => body };
  });
  window.history.replaceState(null, "", `/workspace?tab=channels&channel=google_ads&action=card-2`);
  const lane = () => (
    <ChannelActionsLane slug={slug} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      {null}
    </ChannelActionsLane>
  );
  const view = render(lane(), container ? { container } : undefined);
  const relink = (id: string) => {
    tabs.current = [{ id: "c", payload: { kind: "channels", channel: slug, action: id } }];
    view.rerender(lane());
  };
  return { ...view, relink };
}

beforeEach(() => {
  apiFetch.mockReset();
  scrollIntoView.mockReset();
  heights.clear();
  observers = [];
  above = 0;
  tabs.current = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.testid;
    const top = id && id in CARD_TOP ? above + CARD_TOP[id] : 0;
    return { top, bottom: top, left: 0, right: 0, height: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  spec.current = { name: "Test Ads" };
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

async function landed() {
  const card = await screen.findByTestId("action-card-2");
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  layoutTick();
  return card;
}

describe("deep-linked card stays in view while the lane above it settles", () => {
  it("re-centres the card each time content above it grows, and re-lights it once it lands", async () => {
    mount("anchor-grow");
    const card = await landed();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    card.classList.remove(FLASH);

    growAbove(400);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.instances[1]).toBe(card);
    expect(scrollIntoView.mock.calls[1][0]).toMatchObject({ block: "center" });
    expect(card.className).toContain(FLASH);

    growAbove(600);
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
    expect(scrollIntoView.mock.instances[2]).toBe(card);
  });

  it("an unchanged layout pass does not scroll again", async () => {
    mount("anchor-still");
    await landed();
    layoutTick();
    layoutTick();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it.each(["wheel", "touchstart", "keydown", "mousedown"])("the founder's %s ends the anchoring for good", async (type) => {
    mount(`anchor-user-${type}`);
    await landed();
    growAbove(300);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event(type));
    growAbove(500);
    growAbove(500);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(observers.every((o) => !o.live)).toBe(true);
  });

  it("stops by itself after the settle window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount("anchor-settle");
    await landed();
    act(() => vi.advanceTimersByTime(4100));
    growAbove(800);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(observers.every((o) => !o.live)).toBe(true);
  });

  it("unmounting mid-settle disconnects the observer and drops the listeners", async () => {
    const view = mount("anchor-unmount");
    await landed();
    const removed = vi.spyOn(window, "removeEventListener");
    view.unmount();
    expect(observers.length).toBeGreaterThan(0);
    expect(observers.every((o) => !o.live)).toBe(true);
    expect(removed.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["wheel", "touchstart", "keydown", "mousedown"]));
    removed.mockRestore();
  });

  it("growth below the card, or of the card itself, never moves the view", async () => {
    mount("anchor-below");
    await landed();
    growBelow(400);
    growBelow(900);
    layoutTick();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("a scroll that grows the lane below the card on every call does not feed itself", async () => {
    mount("anchor-pingpong-below");
    await landed();
    scrollIntoView.mockImplementation(() => grow(37));
    growBelow(10);
    for (let i = 0; i < 200; i++) layoutTick();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("a scroll that shifts the card on every call is bounded inside the window and silent after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount("anchor-pingpong-above");
    await landed();
    scrollIntoView.mockImplementation(() => {
      above += 25;
      grow(25);
    });
    growAbove(10);
    for (let i = 0; i < 200; i++) layoutTick();
    const inWindow = scrollIntoView.mock.calls.length;
    expect(inWindow).toBeGreaterThan(1);
    expect(inWindow).toBeLessThanOrEqual(10);
    expect(observers.every((o) => !o.live)).toBe(true);

    act(() => vi.advanceTimersByTime(4100));
    for (let i = 0; i < 200; i++) growAbove(50);
    expect(scrollIntoView).toHaveBeenCalledTimes(inWindow);
  });

  it("a second deep link stops the first card's anchor and anchors the new card", async () => {
    const view = mount("anchor-relink");
    const first = await landed();
    const firstObserver = observers[0];
    expect(firstObserver.live).toBe(true);

    view.relink("card-1");
    const second = screen.getByTestId("action-card-1");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(scrollIntoView.mock.instances[1]).toBe(second);
    expect(firstObserver.live).toBe(false);
    expect(observers.filter((o) => o.live)).toHaveLength(1);

    growAbove(300);
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
    expect(scrollIntoView.mock.instances[2]).toBe(second);
    expect(scrollIntoView.mock.instances.filter((i) => i === first)).toHaveLength(1);
  });
});

describe("a deep-linked card taller than the viewport lands with its header in view", () => {
  const HEADER_BOTTOM = 112;
  const WINDOW = 931;
  const VIEW = WINDOW - HEADER_BOTTOM;
  const CARD_Y = 2000;
  let scrollY = 0;
  let cardHeight = 0;
  let scroller: HTMLElement;
  const cardTop = () => HEADER_BOTTOM + CARD_Y + above - scrollY;

  beforeEach(() => {
    scrollY = 0;
    scroller = document.createElement("div");
    scroller.className = "ws-scroll";
    document.body.appendChild(scroller);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEW });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollY });
    vi.stubGlobal("innerHeight", WINDOW);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = (top: number, height: number) =>
        ({ top, bottom: top + height, left: 0, right: 0, height, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
      if (this === scroller) return rect(HEADER_BOTTOM, VIEW);
      if (this.dataset.testid === "action-card-2") return rect(cardTop(), cardHeight);
      return rect(0, 0);
    });
    scrollIntoView.mockImplementation(function (this: HTMLElement, opts?: ScrollIntoViewOptions) {
      if (this.dataset.testid !== "action-card-2") return;
      const y = CARD_Y + above;
      if (opts?.block === "start") scrollY = y;
      else if (opts?.block === "center") scrollY = y - (VIEW - cardHeight) / 2;
      else if (opts?.block === "end") scrollY = y + cardHeight - VIEW;
    });
  });
  afterEach(() => scroller.remove());

  const expectHeaderInView = () => {
    expect(cardTop()).toBeGreaterThanOrEqual(HEADER_BOTTOM);
    expect(cardTop()).toBeLessThan(WINDOW);
  };

  it("puts the top of a 1100px card just below the channel header, not 140px above it", async () => {
    cardHeight = 1100;
    mount("tall-land", scroller);
    await landed();
    expectHeaderInView();
    expect(cardTop()).toBe(HEADER_BOTTOM);
  });

  it("keeps the tall card's top in view after late layout above it, every time it re-anchors", async () => {
    cardHeight = 1400;
    mount("tall-regrow", scroller);
    await landed();
    expectHeaderInView();
    for (const by of [400, 250, 900]) {
      growAbove(by);
      expectHeaderInView();
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(4);
    expect(scrollIntoView.mock.calls.every(([opts]) => (opts as ScrollIntoViewOptions).block === "start")).toBe(true);
  });

  it("a card that fits is still centred, including after a re-anchor", async () => {
    cardHeight = 300;
    mount("short-centre", scroller);
    await landed();
    expect(cardTop()).toBe(HEADER_BOTTOM + (VIEW - 300) / 2);
    growAbove(500);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(cardTop()).toBe(HEADER_BOTTOM + (VIEW - 300) / 2);
  });
});
