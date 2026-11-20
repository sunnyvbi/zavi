// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/responsive", () => ({ useIsCompact: () => false, useMediaMatch: () => false }));
vi.mock("../navigation/useWorkspaceLocation", () => ({ useWorkspaceLocation: () => "/workspace?tab=channels" }));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => "/workspace?tab=channels",
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => null }));
vi.mock("./LockedChannelPreview", () => ({ LockedChannelPreview: () => null }));
const startPreview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/channelPreviewOnOpen", () => ({ startChannelPreviewOnOpen: startPreview }));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

type Lock = ChannelEntry["lock"];
const entry = (slug: string, lock: Lock, waiting = 0): ChannelEntry =>
  ({ channel: { slug, name: slug, connectors: [] }, count: 0, waiting, subtitle: null, lock }) as unknown as ChannelEntry;

const starter: Lock = { kind: "plan", label: "Starter plan", tier: "starter" };
const pro: Lock = { kind: "plan", label: "Pro plan", tier: "pro" };
const ENTRIES = [
  entry("geo", null),
  entry("reddit_organic", starter),
  entry("seo", starter, 3),
  entry("meta_ads", pro),
];

const row = (slug: string) => document.querySelector<HTMLButtonElement>(`button[data-channel-slug="${slug}"]`)!;

function renderPage() {
  const onUpgrade = vi.fn();
  render(<ChannelsPage entries={ENTRIES} loading={false} onShow={() => {}} onUpgrade={onUpgrade} directUpgrade renderDetail={() => null} />);
  return onUpgrade;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("zavi:channels-view", "list");
  Element.prototype.scrollIntoView = () => {};
  startPreview.mockClear();
});
afterEach(cleanup);

describe("opening a Starter channel that has not previewed", () => {
  it("starts its preview and still opens the upgrade", () => {
    const onUpgrade = renderPage();
    fireEvent.click(row("reddit_organic"));
    expect(startPreview).toHaveBeenCalledWith("reddit_organic");
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("no preview for a channel that already has preview cards, a Pro channel, or an open one", () => {
    const onUpgrade = renderPage();
    fireEvent.click(row("seo"));
    fireEvent.click(row("meta_ads"));
    fireEvent.click(row("geo"));
    expect(startPreview).not.toHaveBeenCalled();
    expect(onUpgrade).toHaveBeenCalledTimes(2);
  });
});
