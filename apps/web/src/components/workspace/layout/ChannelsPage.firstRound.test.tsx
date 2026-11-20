// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ href: "/workspace?tab=channels", push: vi.fn() }));
vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => nav.href,
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => nav.href,
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: nav.push,
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => <div data-testid="chat-column" /> }));
vi.mock("./LockedChannelPreview", () => ({ LockedChannelPreview: () => <div data-testid="locked-preview" /> }));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";
import { useChannelChatOpener } from "../actions/channelChat";

type Lock = ChannelEntry["lock"];
const entry = (slug: string, name: string, lock: Lock, waiting = 0): ChannelEntry =>
  ({
    channel: { slug, name, connectors: [] },
    count: 0,
    waiting,
    subtitle: waiting > 0 ? `${waiting} actions waiting` : null,
    lock,
  }) as unknown as ChannelEntry;

const shut: Lock = { kind: "plan", label: "Starter plan", tier: "starter" };
const open: Lock = { kind: "plan", label: "Starter plan", tier: "starter", open: true };
const ENTRIES = [entry("geo", "GEO", null), entry("seo", "SEO", open, 3), entry("reddit_organic", "Reddit", shut, 2)];

function AskFromCard() {
  const openChat = useChannelChatOpener();
  return (
    <button type="button" onClick={() => openChat?.({ target: "channel" })}>
      ask from a card
    </button>
  );
}

function renderPage(onUpgrade = vi.fn(), over: { directUpgrade?: boolean; onPlanGate?: (entry: ChannelEntry) => void } = {}) {
  render(
    <ChannelsPage
      entries={ENTRIES}
      loading={false}
      onShow={() => {}}
      onUpgrade={onUpgrade}
      onPlanGate={over.onPlanGate}
      directUpgrade={over.directUpgrade ?? true}
      renderDetail={(slug) => (
        <div data-testid="detail" data-slug={slug}>
          <AskFromCard />
        </div>
      )}
    />,
  );
  return onUpgrade;
}

const row = (slug: string) => document.querySelector<HTMLButtonElement>(`button[data-channel-slug="${slug}"]`)!;

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  nav.href = "/workspace?tab=channels";
  nav.push.mockClear();
});
afterEach(cleanup);

describe("the List, with a first-round-open channel", () => {
  beforeEach(() => window.localStorage.setItem("zavi:channels-view", "list"));

  it("lists it with the open channels, with its count, outside the plan group", () => {
    renderPage();
    const group = document.querySelector<HTMLElement>('[data-plan-group="starter"]')!;
    expect(group.getAttribute("data-has-channel")).toBe("reddit_organic");
    expect(group.contains(row("seo"))).toBe(false);
    expect(row("seo").textContent).toContain("3 actions waiting");
    expect(group.textContent).toContain("2 actions waiting for you");
  });

  it("a click opens the channel: no upgrade, no blurred preview", () => {
    const onUpgrade = renderPage();
    fireEvent.click(row("seo"));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(String(nav.push.mock.calls[0]![0])).toContain("channel=seo");
    expect(screen.queryByTestId("locked-preview")).toBeNull();
  });

  it("a plan-locked channel without the flag still goes to the upgrade", () => {
    const onUpgrade = renderPage();
    fireEvent.click(row("reddit_organic"));
    expect(nav.push).not.toHaveBeenCalled();
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect((onUpgrade.mock.calls[0]![0] as ChannelEntry).channel.slug).toBe("reddit_organic");
  });

  it("and a member still gets its blurred preview first", () => {
    const onUpgrade = renderPage(vi.fn(), { directUpgrade: false });
    fireEvent.click(row("reddit_organic"));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(screen.getByTestId("locked-preview")).toBeTruthy();
  });
});

describe("the Wheel, with a first-round-open channel", () => {
  it("opens it on a click and shows its count; the shut one upgrades", () => {
    const onUpgrade = renderPage();
    expect(row("seo").querySelector("[data-wheel-badge]")?.textContent).toBe("3");
    expect(row("reddit_organic").querySelector("[data-wheel-badge]")).toBeNull();
    fireEvent.click(row("seo"));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(String(nav.push.mock.calls[0]![0])).toContain("channel=seo");
    fireEvent.click(row("reddit_organic"));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe("a first-round-open channel, opened", () => {
  it("renders its page, not the list's upgrade", () => {
    nav.href = "/workspace?tab=channels&channel=seo";
    renderPage();
    expect(screen.getByTestId("detail").getAttribute("data-slug")).toBe("seo");
  });

  it("the chat rail and a card's Ask Zavi open the upgrade, and the chat never mounts", () => {
    nav.href = "/workspace?tab=channels&channel=seo";
    const onUpgrade = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect((onUpgrade.mock.calls[0]![0] as ChannelEntry).channel.slug).toBe("seo");
    fireEvent.click(screen.getByText("ask from a card"));
    expect(onUpgrade).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("chat-column")).toBeNull();
  });

  it("the chat doors go to the plan gate, not the upgrade click, when the page is given one", () => {
    nav.href = "/workspace?tab=channels&channel=seo";
    const onPlanGate = vi.fn();
    const onUpgrade = renderPage(vi.fn(), { onPlanGate });
    fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));
    fireEvent.click(screen.getByText("ask from a card"));
    expect(onPlanGate).toHaveBeenCalledTimes(2);
    expect((onPlanGate.mock.calls[0]![0] as ChannelEntry).channel.slug).toBe("seo");
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-column")).toBeNull();
  });

  it("an unlocked channel opens its chat as before", () => {
    nav.href = "/workspace?tab=channels&channel=geo";
    const onUpgrade = renderPage();
    fireEvent.click(screen.getByText("ask from a card"));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-column")).toBeTruthy();
  });

  it("a link to a plan-locked channel without the flag opens no page", () => {
    nav.href = "/workspace?tab=channels&channel=reddit_organic";
    renderPage();
    expect(screen.queryByTestId("detail")).toBeNull();
  });
});
