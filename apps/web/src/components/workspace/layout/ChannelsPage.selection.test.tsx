// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => "/workspace?tab=channels&channel=geo",
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => "/workspace?tab=channels&channel=geo",
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => null }));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

const entry = (slug: string, name: string): ChannelEntry =>
  ({ channel: { slug, name, connectors: [] }, count: 0, waiting: 0, subtitle: null, lock: null }) as unknown as ChannelEntry;

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("the channel list beside an open channel", () => {
  it("selects and hovers with the sidebar's own fills, and draws no side bar", () => {
    const view = render(
      <ChannelsPage
        entries={[entry("seo", "SEO"), entry("geo", "GEO"), entry("blog", "Blog")]}
        loading={false}
        onShow={() => {}}
        onUpgrade={() => {}}
        renderDetail={() => <div data-testid="detail" />}
      />,
    );
    const rows = Array.from(view.container.querySelectorAll("button[data-channel-slug]"));
    const active = rows.filter((r) => r.getAttribute("aria-current") === "page");
    expect(active.length).toBeGreaterThan(0);
    for (const row of active) {
      expect(row.getAttribute("data-channel-slug")).toBe("geo");
      expect(tokens(row)).toContain("bg-ink/10");
      expect(tokens(row)).not.toContain("bg-bone");
      expect(row.querySelector("[data-nav-accent], .w-\\[2px\\], .w-\\[3px\\]")).toBeNull();
    }
    const idle = rows.filter((r) => r.getAttribute("aria-current") !== "page");
    expect(idle.length).toBeGreaterThan(0);
    for (const row of idle) {
      expect(tokens(row)).toContain("hover:bg-ink/[0.04]");
      expect(tokens(row)).not.toContain("hover:bg-creamDeep");
    }
  });
});
