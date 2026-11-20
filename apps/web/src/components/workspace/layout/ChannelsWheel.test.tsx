// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => "/workspace?tab=channels",
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => "/workspace?tab=channels",
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => null }));

import { ChannelsWheel } from "./ChannelsWheel";
import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

const entry = (
  slug: string,
  name: string,
  over: Partial<ChannelEntry> = {},
): ChannelEntry =>
  ({
    channel: { slug, name, connectors: [] },
    count: 0,
    waiting: 0,
    subtitle: null,
    lock: null,
    ...over,
  }) as unknown as ChannelEntry;

const ENTRIES = [
  entry("google_ads", "Google Ads", { waiting: 3, topAction: "Pause 3 keywords with no conversions" }),
  entry("reddit_organic", "Reddit", { waiting: 12, topAction: "Reply to a thread about pricing" }),
  entry("seo", "SEO", { subtitle: "Done" }),
  entry("meta_ads", "Meta Ads", {
    waiting: 4,
    lock: { kind: "plan", label: "Pro plan", tier: "pro" },
  }),
  entry("sms", "SMS", { lock: { kind: "soon" } }),
];

const node = (slug: string) =>
  document.querySelector<HTMLButtonElement>(`[data-channel-slug="${slug}"]`)!;
const touchDown = (el: Element) => {
  const ev = createEvent.pointerDown(el);
  Object.defineProperty(ev, "pointerType", { value: "touch" });
  fireEvent(el, ev);
};
const centre = () => document.querySelector<HTMLElement>("[data-wheel-centre]")!;

afterEach(cleanup);

describe("ChannelsWheel", () => {
  it("renders one node per channel with the List's counts", () => {
    render(<ChannelsWheel entries={ENTRIES} onOpen={() => {}} onUpgrade={() => {}} />);
    for (const e of ENTRIES) expect(node(e.channel.slug)).toBeTruthy();
    expect(document.querySelectorAll("[data-channel-slug]")).toHaveLength(ENTRIES.length);
    expect(node("google_ads").querySelector("[data-wheel-badge]")?.textContent).toBe("3");
    expect(node("reddit_organic").querySelector("[data-wheel-badge]")?.textContent).toBe("5+");
    expect(node("seo").querySelector("[data-wheel-badge]")).toBeNull();
    expect(node("meta_ads").querySelector("[data-wheel-badge]")).toBeNull();
    expect(centre().textContent).toContain("15actions across 2 channels");
  });

  it("still counts a channel's cards after the founder has opened it", () => {
    render(
      <ChannelsWheel
        entries={[entry("instagram_organic", "Instagram", { waiting: 7, noticeWaiting: 0 }), entry("seo", "SEO")]}
        onOpen={() => {}}
        onUpgrade={() => {}}
      />,
    );
    expect(centre().textContent).toContain("7actions across 1 channel");
    expect(node("instagram_organic").querySelector("[data-wheel-badge]")).toBeNull();
  });

  it("hovering a channel shows its real top action, and Open opens it", () => {
    const onOpen = vi.fn();
    render(<ChannelsWheel entries={ENTRIES} onOpen={onOpen} onUpgrade={() => {}} />);
    fireEvent.pointerEnter(node("google_ads"));
    expect(centre().textContent).toContain("What Zavi wants to do");
    expect(centre().textContent).toContain("Pause 3 keywords with no conversions");
    fireEvent.click(within(centre()).getByRole("button", { name: /Open Google Ads/ }));
    expect(onOpen).toHaveBeenCalledWith("google_ads");
  });

  it("leaving a channel clears the centre, unless the pointer reaches the centre first", () => {
    vi.useFakeTimers();
    try {
      render(<ChannelsWheel entries={ENTRIES} onOpen={() => {}} onUpgrade={() => {}} />);
      fireEvent.pointerEnter(node("google_ads"));
      fireEvent.pointerLeave(node("google_ads"));
      act(() => vi.advanceTimersByTime(200));
      fireEvent.pointerEnter(centre());
      act(() => vi.advanceTimersByTime(1000));
      expect(centre().textContent).toContain("Google Ads");
      fireEvent.pointerLeave(centre());
      act(() => vi.advanceTimersByTime(400));
      expect(centre().textContent).toContain("Point at a channel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the paid channels' arc and groups them together", () => {
    const mixed = [
      entry("seo", "SEO", { channel: { slug: "seo", name: "SEO", connectors: [], category: "organic" } } as never),
      entry("google_ads", "Google Ads", { channel: { slug: "google_ads", name: "Google Ads", connectors: [], category: "paid" } } as never),
      entry("blog", "Blog", { channel: { slug: "blog", name: "Blog", connectors: [], category: "organic" } } as never),
    ];
    render(<ChannelsWheel entries={mixed} onOpen={() => {}} onUpgrade={() => {}} />);
    expect(document.body.textContent).toContain("Paid ads");
    const order = [...document.querySelectorAll("[data-channel-slug]")].map((el) => el.getAttribute("data-channel-slug"));
    expect(order).toEqual(["seo", "blog", "google_ads"]);
  });

  it("pointing at an open channel asks for its actions; a locked one does not", () => {
    const onPeek = vi.fn();
    render(
      <ChannelsWheel entries={ENTRIES} onOpen={() => {}} onUpgrade={() => {}} onPeek={onPeek} />,
    );
    fireEvent.focus(node("google_ads"));
    expect(onPeek).toHaveBeenCalledWith(ENTRIES[0]);
    onPeek.mockClear();
    fireEvent.pointerEnter(node("meta_ads"));
    expect(onPeek).not.toHaveBeenCalled();
  });

  it("clicking a node opens that channel", () => {
    const onOpen = vi.fn();
    render(<ChannelsWheel entries={ENTRIES} onOpen={onOpen} onUpgrade={() => {}} />);
    fireEvent.click(node("reddit_organic"));
    expect(onOpen).toHaveBeenCalledWith("reddit_organic");
  });

  it("on touch, the first tap shows the centre and the second opens", () => {
    const onOpen = vi.fn();
    render(<ChannelsWheel entries={ENTRIES} onOpen={onOpen} onUpgrade={() => {}} />);
    const enter = createEvent.pointerOver(node("google_ads"));
    Object.defineProperty(enter, "pointerType", { value: "touch" });
    fireEvent(node("google_ads"), enter);
    touchDown(node("google_ads"));
    fireEvent.focus(node("google_ads"));
    fireEvent.click(node("google_ads"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(centre().textContent).toContain("Pause 3 keywords with no conversions");
    touchDown(node("google_ads"));
    fireEvent.click(node("google_ads"));
    expect(onOpen).toHaveBeenCalledWith("google_ads");
  });

  it("after a tap, Enter on the focused node opens it", () => {
    const onOpen = vi.fn();
    render(<ChannelsWheel entries={ENTRIES} onOpen={onOpen} onUpgrade={() => {}} />);
    touchDown(node("seo"));
    fireEvent.focus(node("seo"));
    fireEvent.click(node("seo"));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(node("seo"));
    expect(onOpen).toHaveBeenCalledWith("seo");
  });

  it("a coming-soon channel is not clickable", () => {
    const onOpen = vi.fn();
    const onUpgrade = vi.fn();
    render(<ChannelsWheel entries={ENTRIES} onOpen={onOpen} onUpgrade={onUpgrade} />);
    expect(node("sms").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(node("sms"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("a plan-locked channel opens the upgrade, never the channel or its actions", () => {
    const onOpen = vi.fn();
    const onUpgrade = vi.fn();
    render(<ChannelsWheel entries={ENTRIES} onOpen={onOpen} onUpgrade={onUpgrade} />);
    fireEvent.pointerEnter(node("meta_ads"));
    expect(centre().textContent).not.toContain("What Zavi wants to do");
    fireEvent.click(node("meta_ads"));
    expect(onUpgrade).toHaveBeenCalledWith(ENTRIES[3]);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("ChannelsPage view switch", () => {
  beforeEach(() => window.localStorage.clear());

  const renderPage = () =>
    render(
      <ChannelsPage
        entries={ENTRIES}
        loading={false}
        onShow={() => {}}
        onUpgrade={() => {}}
        renderDetail={() => null}
      />,
    );

  it("opens on the Wheel, and remembers the List once chosen", () => {
    renderPage();
    expect(centre()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wheel" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-need-you]")?.textContent).toBe("15 items need you");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(document.querySelector("[data-wheel-centre]")).toBeNull();
    expect(window.localStorage.getItem("zavi:channels-view")).toBe("list");
    cleanup();
    renderPage();
    expect(document.querySelector("[data-wheel-centre]")).toBeNull();
  });

  it("leaves Coming soon channels off the ring", () => {
    window.localStorage.setItem("zavi:channels-view", "wheel");
    renderPage();
    const ring = document.querySelector("[data-wheel-centre]")?.closest("div[class]")?.parentElement ?? document.body;
    const soonOnRing = [...document.querySelectorAll("[data-channel-slug]")].filter((el) => el.getAttribute("aria-label")?.includes("Coming soon"));
    expect(ring).toBeTruthy();
    expect(soonOnRing).toEqual([]);
  });

  it("on the Wheel, the header and the centre count the same channels", () => {
    const withSoonWork = ENTRIES.map((e) => (e.lock?.kind === "soon" ? { ...e, waiting: 17 } : e));
    window.localStorage.setItem("zavi:channels-view", "wheel");
    render(<ChannelsPage entries={withSoonWork} loading={false} onShow={() => {}} onUpgrade={() => {}} renderDetail={() => null} />);
    const header = Number(document.querySelector("[data-need-you]")?.textContent?.match(/\d+/)?.[0] ?? 0);
    const centreTotal = Number(centre().textContent?.match(/\d+/)?.[0] ?? -1);
    expect(header).toBe(centreTotal);
  });
});
