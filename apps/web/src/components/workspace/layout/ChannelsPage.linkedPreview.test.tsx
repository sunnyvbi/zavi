// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => "/workspace?tab=channels&channel=seo",
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => "/workspace?tab=channels&channel=seo",
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({ ChannelActionChat: () => null }));
vi.mock("./LockedChannelPreview", () => ({
  LockedChannelPreview: ({ entry }: { entry: { channel: { slug: string } } }) => (
    <div data-testid="locked-preview">{entry.channel.slug}</div>
  ),
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

const starter = { kind: "plan", label: "Starter plan", tier: "starter" } as const;
const entry = (slug: string, name: string, lock: ChannelEntry["lock"], waiting: number): ChannelEntry =>
  ({ channel: { slug, name, connectors: [] }, count: 0, waiting, subtitle: null, lock }) as unknown as ChannelEntry;

const scrolled: string[] = [];
beforeEach(() => {
  scrolled.length = 0;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-plan-group") ?? this.getAttribute("data-channel-slug") ?? "");
  };
});
afterEach(cleanup);

describe("ChannelsPage opened by a link to a locked channel", () => {
  it("shows the List, opens the preview for an owner, and scrolls to the plan header", async () => {
    const onUpgrade = vi.fn();
    render(
      <ChannelsPage
        entries={[entry("seo", "SEO", starter, 4), entry("geo", "GEO", starter, 3)]}
        loading={false}
        directUpgrade
        onShow={() => {}}
        onUpgrade={onUpgrade}
        renderDetail={() => null}
      />,
    );
    expect((await screen.findByTestId("locked-preview")).textContent).toBe("seo");
    expect(screen.getByText("7 actions waiting for you")).toBeTruthy();
    expect(scrolled).toContain("starter");
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("after an owner closes the linked preview, the row goes back to the plans", async () => {
    const onUpgrade = vi.fn();
    render(
      <ChannelsPage
        entries={[entry("seo", "SEO", starter, 4)]}
        loading={false}
        directUpgrade
        onShow={() => {}}
        onUpgrade={onUpgrade}
        renderDetail={() => null}
      />,
    );
    await screen.findByTestId("locked-preview");
    const row = () => screen.getAllByRole("button").find((b) => b.getAttribute("aria-expanded") === "true")!;
    fireEvent.click(row());
    expect(screen.queryByTestId("locked-preview")).toBeNull();
    fireEvent.click(screen.getAllByRole("button").find((b) => /SEO/.test(b.textContent ?? ""))!);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("ignores a link to a channel that is not locked by a plan", () => {
    render(
      <ChannelsPage
        entries={[entry("geo", "GEO", starter, 3)]}
        loading={false}
        directUpgrade
        onShow={() => {}}
        onUpgrade={() => {}}
        renderDetail={() => null}
      />,
    );
    expect(screen.queryByTestId("locked-preview")).toBeNull();
    expect(scrolled).toEqual([]);
  });
});
