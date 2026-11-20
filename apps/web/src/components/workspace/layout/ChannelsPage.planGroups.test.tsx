// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
  return {
    ...real,
    fetchLivePricingClient: async () => ({
      ...real.PRICING_FALLBACK,
      tiers: real.PRICING_FALLBACK.tiers.map((t) =>
        t.slug === "starter" ? { ...t, usd: 25 } : t,
      ),
    }),
  };
});

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";

beforeEach(() => {
  window.localStorage.setItem("zavi:channels-view", "list");
});

type Lock = ChannelEntry["lock"];
const entry = (
  slug: string,
  name: string,
  lock: Lock = null,
  subtitle: string | null = null,
): ChannelEntry =>
  ({
    channel: { slug, name, connectors: [] },
    count: 0,
    waiting: 0,
    subtitle,
    lock,
  }) as unknown as ChannelEntry;
const starter: Lock = { kind: "plan", label: "Starter plan", tier: "starter" };
const pro: Lock = { kind: "plan", label: "Pro plan", tier: "pro" };
const soon: Lock = { kind: "soon" };

function renderPage(
  entries: ChannelEntry[],
  handlers: { onUpgrade?: () => void; onUpgradePlan?: (t: string) => void; currentPlan?: string | null; canComparePlans?: boolean } = {},
) {
  return render(
    <ChannelsPage
      entries={entries}
      loading={false}
      onShow={() => {}}
      onUpgrade={handlers.onUpgrade ?? (() => {})}
      onUpgradePlan={handlers.onUpgradePlan}
      renderDetail={() => null}
      currentPlan={handlers.currentPlan ?? null}
      canComparePlans={handlers.canComparePlans ?? true}
    />,
  );
}

afterEach(cleanup);

describe("ChannelsPage plan groups", () => {
  it("puts runnable channels first, then one header per plan, then coming soon", async () => {
    const view = renderPage([
      entry("meta_ads", "Meta Ads", pro, "Reads your ad account"),
      entry("tiktok_organic", "TikTok", soon),
      entry("seo", "SEO", null, "3 actions waiting"),
      entry("x_organic", "X", starter, "Writes your posts"),
    ]);
    await screen.findByText(/\$25\/mo/);
    const text = view.container.textContent ?? "";
    const order = ["SEO", "On Starter", "X", "On Pro", "Meta Ads", "Coming soon", "TikTok"].map(
      (s) => text.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const upgradeStarter = screen.getByRole("button", { name: "Upgrade to Starter" });
    const upgradePro = screen.getByRole("button", { name: "Upgrade to Pro" });
    expect(upgradeStarter.className).toContain("border-rule bg-cream text-ink");
    expect(upgradeStarter.className).toBe(upgradePro.className);
    expect(screen.getByText(/\$240\/mo/)).toBeTruthy();
    expect(screen.queryByText("On Growth")).toBeNull();
    expect(text).not.toContain("Upgrade to run this channel");
  });

  it("a header button opens the upgrade for that plan", () => {
    const onUpgradePlan = vi.fn();
    renderPage([entry("x_organic", "X", starter), entry("meta_ads", "Meta Ads", pro)], {
      onUpgradePlan,
    });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(onUpgradePlan).toHaveBeenCalledWith("pro");
  });

  it("an open row reads like a locked one: description, and the count said once as a pill", () => {
    renderPage([{ ...entry("seo", "SEO", null, "3 actions waiting"), waiting: 3, description: "Fixes your page titles" }]);
    const seo = screen.getByText("SEO").closest("button") as HTMLButtonElement;
    expect(within(seo).getByText("Fixes your page titles")).toBeTruthy();
    expect(within(seo).getByText("3 actions waiting").hasAttribute("data-waiting-highlight")).toBe(true);
    expect(within(seo).queryByText(/^3$/)).toBeNull();
  });

  it("a locked row's waiting count is highlighted, a description is not", () => {
    renderPage([
      { ...entry("seo", "SEO", starter, "3 actions waiting"), waiting: 3 },
      entry("geo", "GEO", starter, "Gets your site ready to be quoted in AI answers"),
    ]);
    const seo = screen.getByText("SEO").closest("button") as HTMLButtonElement;
    expect(within(seo).getByText("3 actions waiting").hasAttribute("data-waiting-highlight")).toBe(true);
    const geo = screen.getByText("GEO").closest("button") as HTMLButtonElement;
    expect(within(geo).getByText("Gets your site ready to be quoted in AI answers").hasAttribute("data-waiting-highlight")).toBe(false);
  });

  it("a locked row shows its subtitle and plan chip, and opens the upgrade, not the channel", () => {
    const onUpgrade = vi.fn();
    renderPage(
      [entry("meta_ads", "Meta Ads", pro, "2 actions waiting · upgrade to see them")],
      { onUpgrade },
    );
    const row = screen.getByText("Meta Ads").closest("button") as HTMLButtonElement;
    expect(within(row).getByText("2 actions waiting · upgrade to see them")).toBeTruthy();
    expect(within(row).getByText("Pro")).toBeTruthy();
    fireEvent.click(row);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("coming soon is one line of chips, not rows", () => {
    renderPage([
      entry("seo", "SEO"),
      entry("ugc", "UGC", soon),
      entry("generated_video", "AI UGC Videos", soon),
    ]);
    const line = screen.getByText("Coming soon").parentElement as HTMLElement;
    expect(within(line).getByText("UGC")).toBeTruthy();
    expect(within(line).getByText("AI UGC Videos")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /UGC/ })).toBeNull();
  });

  it("a coming-soon chip still says how much work waits behind it", () => {
    renderPage([entry("seo", "SEO"), { ...entry("ugc", "UGC", soon), waiting: 2 }]);
    const line = screen.getByText("Coming soon").parentElement as HTMLElement;
    expect(within(line).getByText("UGC · 2 waiting")).toBeTruthy();
  });

  it("the title shows the tenant's current plan, and nothing when it is unknown", () => {
    const { unmount } = renderPage([entry("seo", "SEO", starter)], { currentPlan: "free" });
    expect(document.querySelector("[data-current-plan]")?.textContent).toBe("You\u2019re on the Free plan \u00b7 Compare plans");
    unmount();
    renderPage([entry("seo", "SEO", starter)], { currentPlan: null });
    expect(document.querySelector("[data-current-plan]")).toBeNull();
  });

  it("a member sees their plan but no Compare plans link", () => {
    renderPage([entry("seo", "SEO", starter)], { currentPlan: "free", canComparePlans: false });
    expect(document.querySelector("[data-current-plan]")?.textContent).toBe("You\u2019re on the Free plan");
    expect(screen.queryByText("Compare plans")).toBeNull();
  });

  it("a Free tenant with nothing runnable opens straight on the first plan header", () => {
    renderPage([entry("seo", "SEO", starter), entry("meta_ads", "Meta Ads", pro)]);
    expect(screen.queryByText("No channels on Free")).toBeNull();
    expect(screen.getByText("On Starter")).toBeTruthy();
  });
});

describe("ChannelsPage plan header total and in-progress rows", () => {
  const withWaiting = (e: ChannelEntry, waiting: number, subtitle: string): ChannelEntry => ({
    ...e,
    waiting,
    subtitle,
  });

  it("says the plan's total once and turns the button into See them", () => {
    renderPage([
      withWaiting(entry("seo", "SEO", starter), 3, "3 actions waiting"),
      withWaiting(entry("x_organic", "X", starter), 2, "2 actions waiting"),
      entry("meta_ads", "Meta Ads", pro, "Reads your ad account"),
    ]);
    expect(screen.getByText("5 actions waiting for you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "See them · Upgrade" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
    expect(screen.getByText("3 actions waiting")).toBeTruthy();
  });

  it("with nothing waiting keeps today's header", () => {
    renderPage([entry("seo", "SEO", starter, "Fixes your page titles")]);
    expect(screen.queryByText(/waiting for you/)).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade to Starter" })).toBeTruthy();
  });

  it("a locked channel still running shows a banner naming the company", () => {
    render(
      <ChannelsPage
        entries={[
          { ...entry("seo", "SEO", starter, "Working on it"), running: true },
          { ...entry("x_organic", "X", starter, "Working on it"), running: true },
          withWaiting(entry("reddit_organic", "Reddit", starter), 2, "2 actions waiting"),
        ]}
        loading={false}
        companyName="Acme Bikes"
        onShow={() => {}}
        onUpgrade={() => {}}
        renderDetail={() => null}
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe(
      "Zavi is working on 2 channels for Acme Bikes. This takes a few minutes. You can leave this page.",
    );
    expect(screen.getAllByText("Working on it")).toHaveLength(2);
  });

  it("no banner when nothing locked is running", () => {
    renderPage([entry("seo", "SEO", starter, "Fixes your page titles")]);
    expect(screen.queryByText(/Zavi is working on/)).toBeNull();
  });
});
