// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return { ...real, fetchLivePricingClient: async () => real.PRICING_FALLBACK };
});

const REAL_TITLES = ["Rewrite the homepage title", "Add a pricing page"];
const listMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/channelActionsApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workspace/channelActionsApi")>();
  return { ...real, listChannelActions: listMock };
});

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";
import { fillerLine } from "./LockedChannelPreview";

beforeEach(() => {
  window.localStorage.setItem("zavi:channels-view", "list");
});

const starter: ChannelEntry["lock"] = { kind: "plan", label: "Starter plan", tier: "starter" };
const entry = (slug: string, name: string, waiting: number): ChannelEntry =>
  ({
    channel: { slug, name, connectors: [] },
    count: 0,
    waiting,
    subtitle: waiting > 0 ? `${waiting} actions waiting` : "What it does",
    lock: starter,
  }) as unknown as ChannelEntry;

function renderPage(entries: ChannelEntry[], onUpgrade = vi.fn()) {
  render(
    <ChannelsPage
      entries={entries}
      loading={false}
      onShow={() => {}}
      onUpgrade={onUpgrade}
      renderDetail={() => null}
    />,
  );
  return onUpgrade;
}

afterEach(() => {
  cleanup();
  listMock.mockReset();
});

const rowButton = (slug: string) =>
  document.querySelector<HTMLButtonElement>(`button[data-channel-slug="${slug}"]`)!;

describe("LockedChannelPreview", () => {
  it("opens one blurred row per waiting action, labelled by type", async () => {
    listMock.mockResolvedValue({
      actions: [],
      more: 0,
      store: "channel_actions",
      locked_preview: { count: 3, types: ["fix", "fix", "page"] },
    });
    const onUpgrade = renderPage([entry("seo", "SEO", 3)]);
    fireEvent.click(rowButton("seo"));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(rowButton("seo").getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.querySelectorAll("[data-locked-row]")).toHaveLength(3));
    expect(listMock).toHaveBeenCalledWith("seo");
    expect(screen.getByText("3 actions ready")).toBeTruthy();
    for (const li of document.querySelectorAll("[data-locked-row]")) {
      const btn = li.querySelector("button");
      expect(btn?.querySelector("[data-filler]")).toBeTruthy();
      expect(btn?.textContent).not.toMatch(/View/);
    }
    const fillers = [...document.querySelectorAll("[data-filler]")];
    expect(fillers).toHaveLength(3);
    for (const f of fillers) {
      expect(f.getAttribute("aria-hidden")).toBe("true");
      expect(f.className).toContain("select-none");
      expect(f.className).toMatch(/blur-/);
      expect(REAL_TITLES).not.toContain(f.textContent);
    }
    expect(new Set(fillers.map((f) => f.textContent?.length)).size).toBeGreaterThan(1);
    for (const t of REAL_TITLES) expect(document.body.textContent).not.toContain(t);
  });

  it("a row and the one Upgrade button both open the upgrade dialog", async () => {
    listMock.mockResolvedValue({
      actions: [],
      more: 0,
      store: "channel_actions",
      locked_preview: { count: 2, types: ["video_post", "check"] },
    });
    const onUpgrade = renderPage([entry("youtube_organic", "YouTube", 2)]);
    fireEvent.click(rowButton("youtube_organic"));
    await waitFor(() => expect(document.querySelectorAll("[data-locked-row]")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: /^View this action/ })[1]!);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    const preview = document.querySelector("[data-locked-preview]")!;
    fireEvent.click([...preview.querySelectorAll("button")].find((b) => b.textContent === "Upgrade to see them")!);
    expect(onUpgrade).toHaveBeenCalledTimes(2);
    expect(onUpgrade.mock.calls[0]![0].channel.slug).toBe("youtube_organic");
  });

  it("a locked channel with nothing waiting opens the dialog directly", () => {
    const onUpgrade = renderPage([entry("seo", "SEO", 0)]);
    fireEvent.click(rowButton("seo"));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-locked-preview]")).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("filler is made up on the client and never matches real text", () => {
    for (let i = 0; i < 20; i++) expect(REAL_TITLES).not.toContain(fillerLine(i));
  });
});
