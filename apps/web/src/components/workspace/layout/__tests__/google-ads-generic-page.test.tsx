// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { GadsPayload } from "../../agent/google-ads/types";
import { ChannelDrawer, ChannelDetailPage, type ChannelDetail } from "../ChannelDrawer";
import { makeAction } from "../../actions/__tests__/fixtures";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";

vi.mock("@/components/workspace/WorkspaceShell", async orig => ({ ...(await orig<Record<string, unknown>>()), useWorkspaceOptional: () => ({ role: "owner" }) }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../../agent/GoogleAdsPanel", () => ({
  GoogleAdsPanel: () => <div>LEGACY GOOGLE ADS PANEL</div>,
}));

const googleAds = (CHANNELS as readonly Channel[]).find((c) => c.slug === "google_ads")!;

function payload(over: Partial<GadsPayload> = {}): GadsPayload {
  return {
    connected: true,
    currency: "USD",
    error_code: null,
    window_days: 30,
    period: { from: "2026-08-17", to: "2026-09-15" },
    prev_period: { from: "2026-07-18", to: "2026-08-16" },
    account: { name: "The main account", customer_id: "123-456-7890", campaign_count: 2 },
    kpis: [
      { key: "spend", label: "Spend", unit: "usd", value: 18420, prev: 16446, delta_pct: 12, delta_abs: 1974, delta_good: null },
      { key: "cpa", label: "Cost per conversion", unit: "usd", value: 54.51, prev: 57.61, delta_pct: -5.4, delta_abs: -3.1, delta_good: true },
      { key: "conversions", label: "Conversions", unit: "count", value: 338, prev: 319, delta_pct: 6, delta_abs: 19, delta_good: true },
      { key: "roas", label: "ROAS", unit: "ratio", value: 3.12, prev: 3.04, delta_pct: 2.6, delta_abs: 0.08, delta_good: true },
      {
        key: "pacing",
        label: "Spend vs plan",
        unit: "pct",
        value: 94,
        prev: null,
        delta_pct: null,
        delta_abs: null,
        delta_good: null,
        pacing: { spend: 18420, plan: 19600, plan_basis: "auto", pct: 94, capped_campaigns: 3, campaigns: 7, days_elapsed: 15, days_in_month: 30 },
      },
    ],
    campaigns: [
      { id: "1", name: "Top campaign", status: "ENABLED", limited_by_budget: true, spend: 5240, conversions: 128, cpa: 40.94, conv_value: 22300, url: null },
      { id: "2", name: "Second campaign", status: "PAUSED", limited_by_budget: false, spend: 0, conversions: 0, cpa: null, conv_value: 0, url: null },
    ],
    totals: { campaigns: 2, spend: 18420, conversions: 338, cpa: 54.5, conv_value: 57400, roas: 3.12 },
    actions: [],
    counts: { all: 0, needs_you: 0, autonomous: 0 },
    ...over,
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const RANKED = makeAction("update_ad", {
  id: "ca-1",
  channel_slug: "google_ads",
  title: "Raise the budget on the campaign that is capped",
});

const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function route(d: GadsPayload | null = payload(), history: unknown = NO_HISTORY) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/channels/google_ads/actions")) {
      return ok({ actions: [RANKED], more: 0, store: "channel_actions" });
    }
    if (u.includes("/api/channels/google_ads/metrics")) return ok({ metrics: [] });
    if (u.includes("/api/channels/google_ads/history")) return ok(history);
    if (u.includes("/api/agents/google_ads/dashboard")) {
      return d ? ok(d) : { ok: false, status: 500, json: async () => ({}) };
    }
    return ok({ snapshots: [], artifacts: [], briefs: [] });
  });
}

const detail = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  channel: googleAds,
  mode: "produce",
  connected: true,
  connectors: ["google_ads"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
  ...over,
});

async function open(d: Partial<ChannelDetail> = {}) {
  const r = render(
    <ChannelDrawer
      detail={detail(d)}
      actionCount={0}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    />,
  );
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return r;
}

const urls = () => apiFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  apiFetch.mockReset();
  __resetAgentDashCache();
});
afterEach(cleanup);

async function analytics() {
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("google_ads renders through the generic channel page", () => {
  it("does not mount the panel it replaced", async () => {
    route();
    await open();
    expect(screen.queryByText("LEGACY GOOGLE ADS PANEL")).toBeNull();
  });

  it("the drawer no longer imports the panel at all", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelDrawer.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/agent\/GoogleAdsPanel"/);
  });

  it("draws Overview, Analytics and Settings, because the row declares settings and numbers", async () => {
    route();
    await open();
    const bar = screen.getByRole("tablist", { name: /Google Ads views/i });
    expect(within(bar).getByRole("tab", { name: /Overview/ })).toBeTruthy();
    expect(within(bar).getByRole("tab", { name: /Analytics/ })).toBeTruthy();
    expect(within(bar).getByRole("tab", { name: /Settings/ })).toBeTruthy();
  });

  it("draws the window picker and Refresh for the numbers they control", async () => {
    route();
    await open();
    await analytics();
    expect(screen.getAllByText(/^Last 30 days$/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeTruthy();
    expect(urls().some((u) => u.includes("/api/agents/google_ads/dashboard"))).toBe(true);
  });

  it("draws no account line at desktop width, even when the payload names an account", async () => {
    route();
    await open();
    expect(screen.queryByTestId("account-strip")).toBeNull();
    const row = screen.getByTestId("channel-header");
    expect(row.textContent).not.toContain("The main account");
    expect(row.textContent).not.toMatch(/\d+ (active )?campaigns/);
    expect(row.textContent).not.toContain("Zavi proposes");
  });

  it("puts the tabs and the window controls in ONE row", async () => {
    route();
    await open();
    await analytics();
    const row = screen.getByTestId("channel-header");
    expect(within(row).getByRole("tablist", { name: /Google Ads views/i })).toBeTruthy();
    expect(within(row).getAllByText(/^Last 30 days$/).length).toBeGreaterThan(0);
    expect(within(row).getByRole("button", { name: /Refresh/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Refresh/ })).toHaveLength(1);
  });

  it("keeps the row, without an account line, when the payload names no account", async () => {
    route(payload({ kpis: [] }));
    await open();
    await analytics();
    expect(screen.queryByTestId("account-strip")).toBeNull();
    const row = screen.getByTestId("channel-header");
    expect(within(row).getByRole("tab", { name: /Overview/ })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /Refresh/ })).toBeTruthy();
  });

  it("centers the full-page advertising overview at the shared width", async () => {
    route();
    render(<ChannelDetailPage detail={detail()} actionCount={0} error={null} onClose={() => {}} onOpenConnectors={() => {}} />);
    await act(async () => {});
    expect(document.querySelector(".max-w-ca-content.mx-auto.w-full")).not.toBeNull();
  });

  it("fills the paid analytics tiles from the dashboard payload", async () => {
    route();
    await open();
    expect(document.querySelector('[data-metric="spend"]')?.textContent).toContain("$18,420");
    expect(screen.getByTestId("paid-analytics")).toBeTruthy();
    expect(screen.queryByLabelText("More numbers")).toBeNull();
    expect(screen.queryByTestId("metrics-empty")).toBeNull();
  });

  it("says the pacing tile is PACE and shows its arithmetic, and ROAS in dollars back", async () => {
    route();
    await open();
    const pace = document.querySelector('[data-metric="pacing"]')!;
    expect(pace.textContent).toContain("Plan pace");
    expect(pace.textContent).not.toContain("of plan");
    expect(pace.textContent).toContain("$18,420 of $19,600 · day 15 of 30");
    const roasTile = document.querySelector('[data-metric="roas"]')!;
    expect(roasTile.textContent).toContain("$3.12 back per $1 spent");
  });

  it("keeps the monthly plan editor under the pacing card", async () => {
    route();
    await open();
    await analytics();
    const plan = screen.getByTestId("monthly-plan");
    expect(plan.textContent).toContain("$18,420 of $19,600 this month");
    expect(within(plan).getByRole("button", { name: /Edit plan/ })).toBeTruthy();
  });

  it("draws the paid campaign table with statuses and totals for displayed rows", async () => {
    route();
    await open();
    const table = screen.getByRole("tabpanel", { name: "Campaign results", hidden: true });
    expect(within(table).getByText("Top campaign")).toBeTruthy();
    expect(within(table).getByText("Limited by budget")).toBeTruthy();
    expect(within(table).getByText("Paused")).toBeTruthy();
    expect(within(table).getAllByText("-").length).toBeGreaterThan(0);
    const footer = table.querySelector("tfoot")!;
    expect(footer.textContent).toContain("2 campaigns");
    expect(footer.textContent).toContain("$5,240");
    expect(footer.textContent).toContain("128");
  });

  it("draws the ranked action list with no section heading", async () => {
    route();
    await open();
    const section = screen.getByTestId("action-section");
    expect(within(section).queryByText("What Zavi wants to do")).toBeNull();
    expect(within(section).getByText(RANKED.title)).toBeTruthy();
  });

  it("keeps Overview to the numbers and the actions", async () => {
    route();
    await open();
    expect(screen.queryByText("Measured on")).toBeNull();
    expect(screen.queryByText("Last worked")).toBeNull();
    expect(screen.queryByTestId("channel-run-note")).toBeNull();
    expect(screen.queryByTestId("account-strip")).toBeNull();
    expect(screen.getByText(RANKED.title)).toBeTruthy();
  });

  it("keeps the schedule, one tab over", async () => {
    route();
    await open();
    await act(async () => {
      screen.getByRole("tab", { name: /Settings/ }).click();
    });
    expect(screen.getByTestId("channel-run-note")).toBeTruthy();
  });

  it("reads history without putting the legacy run log among pending actions", async () => {
    route(payload(), {
      runs: [
        {
          run_id: "r1",
          executor: "performance-marketer",
          trigger: "manual",
          status: "success",
          enqueued_at: null,
          started_at: null,
          finished_at: new Date().toISOString(),
          redo_of_action_id: null,
        },
      ],
      closed: [],
      pre_switch: [],
    });
    await open();
    expect(apiFetch.mock.calls.some((call) => String(call[0]).includes("/api/channels/google_ads/history"))).toBe(true);
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    expect(screen.getByTestId("action-section")).toBeTruthy();
  });

  it("draws no run drawer on a channel that has genuinely never run", async () => {
    route();
    await open();
    expect(screen.queryByTestId("run-drawer")).toBeNull();
  });

  it("asks for no run-artifacts, because this page draws no Outputs strip", async () => {
    route();
    await open();
    expect(urls().some((u) => u.includes("/api/run-artifacts"))).toBe(false);
  });
});

describe("google_ads — the states the panel used to own", () => {
  it("shows the Connect card, and nothing under it, when the payload says not connected", async () => {
    route(payload({ connected: false }));
    await open({ connected: false });
    expect(screen.getByTestId("connect-card").textContent).toContain("Connect Google Ads");
    expect(screen.queryByTestId("account-strip")).toBeNull();
    expect(screen.queryByTestId("extra-table")).toBeNull();
    expect(screen.getByText(RANKED.title)).toBeTruthy();
  });

  it("offers Reconnect inside a short warning alert, never a red error, when the account stopped accepting Zavi's access", async () => {
    route(payload({ error_code: "google_ads_token_revoked" }));
    await open();
    const notice = screen.getByTestId("channel-read-problem");
    expect(notice.querySelector("strong")?.textContent).toBe("Google Ads stopped accepting Zavi's access.");
    expect(notice.textContent).not.toContain("could not be read");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.className).toContain("bg-warnBg");
    expect(notice.className).not.toMatch(/(?:bg|text|border)-red/);
    const reconnect = within(notice).getByRole("button", { name: "Reconnect Google Ads" });
    expect(reconnect.textContent).toBe("Reconnect");
    expect(reconnect.className).toContain("focus-visible:ring-2");
    expect(reconnect.className).not.toMatch(/red/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("account-strip")).toBeNull();
    expect(screen.queryByTestId("connect-card")).toBeNull();
  });

  it("says a read failed without claiming the account is gone", async () => {
    route(payload({ error_code: "google_ads_unavailable" }));
    await open();
    expect(screen.getByText(/could not read your Google Ads account just now/)).toBeTruthy();
    expect(screen.queryByTestId("connect-card")).toBeNull();
  });

  it("a dead dashboard degrades to the empty sentence, with the list intact", async () => {
    route(null);
    await open();
    expect(screen.queryByTestId("connect-card")).toBeNull();
    expect(screen.queryByTestId("account-strip")).toBeNull();
    expect(screen.queryByTestId("extra-table")).toBeNull();
    expect(screen.getByTestId("channel-value-empty")).toBeTruthy();
    expect(screen.getByText(RANKED.title)).toBeTruthy();
  });
});
