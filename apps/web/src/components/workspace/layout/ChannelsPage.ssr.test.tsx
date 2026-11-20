// @vitest-environment jsdom

import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const href = { value: "/workspace?tab=channels&channel=meta_ads" };
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => href.value,
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => href.value,
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({
  ChannelActionChat: () => <div data-testid="channel-chat" />,
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

const channel = (slug: string, name: string) =>
  ({ channel: { slug, name, connectors: [] }, count: 0, waiting: 0, subtitle: null, lock: null }) as unknown as ChannelEntry;

beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

describe("ChannelsPage server markup on a phone", () => {
  it("hides the desktop channel list and chat rail at phone widths until the page hydrates", () => {
    const html = renderToString(
      <ChannelsPage
        entries={[channel("meta_ads", "Meta Ads"), channel("seo", "SEO")]}
        loading={false}
        onShow={() => {}}
        onUpgrade={() => {}}
        renderDetail={(slug) => <div data-testid="channel-detail" data-slug={slug} />}
      />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector('[data-testid="channel-detail"]')?.getAttribute("data-slug")).toBe("meta_ads");
    const list = doc.querySelector('nav[aria-label="Growth Channels"]');
    const rail = doc.querySelector('aside[aria-label="Chat"]');
    expect(list).toBeTruthy();
    expect(rail).toBeTruthy();
    expect(list!.className.split(/\s+/)).toContain("compact:hidden");
    expect(rail!.className.split(/\s+/)).toContain("compact:hidden");
  });
});
