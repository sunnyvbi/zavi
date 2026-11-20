// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  data: null as unknown,
  cachedAt: null as number | null,
  refreshSilent: vi.fn(),
  dashboardFetches: 0,
}));

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: vi.fn() }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: h.data, cachedAt: h.cachedAt, loading: false, refreshing: false, error: null, refresh: () => {}, refreshSilent: h.refreshSilent }),
}));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_ads } from "./platforms/linkedin_ads";
import { announceChannelDashboardStale, setCampaignStates, useCampaignStates } from "./campaignLinks";

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const payload = (status: string, ad_delivery: string | null) => ({
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-10-01", to: "2026-10-30" },
  account: { name: "Main", account_count: 1, campaign_count: 1, active_count: 1, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: [{ id: "501", ad_account_id: "9001", currency: "USD", name: "Pilot", status, ad_delivery, ads_not_running: 0, spend: 0, clicks: 0, conversions: 0, cpa: null, url: null }],
});
const draw = () => render(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);

beforeEach(() => {
  h.data = null;
  h.cachedAt = null;
  h.refreshSilent.mockReset();
  act(() => setCampaignStates("linkedin_ads", {}));
});
afterEach(() => cleanup());

describe("the LinkedIn dashboard read feeds the campaign list", () => {
  it("publishes the live answer the page already fetched", () => {
    h.data = payload("PAUSED", null);
    draw();
    const { result } = renderHook(() => useCampaignStates("linkedin_ads"));
    expect(result.current).toEqual({ "501": { status: "PAUSED", ad_delivery: null, ads_not_running: 0 } });
  });

  it("must catch: a first paint from the tab's cached copy does not set the pill, the answer behind it does", () => {
    h.data = payload("ACTIVE", "serving");
    h.cachedAt = Date.now() - 20 * 60_000;
    const view = draw();
    const { result } = renderHook(() => useCampaignStates("linkedin_ads"));
    expect(result.current).toEqual({});
    h.data = payload("PAUSED", null);
    h.cachedAt = null;
    view.rerender(<ChannelMetricsRow slug="linkedin_ads" metrics={[]} platform={linkedin_ads} loading={false} connected hasConnectors />);
    expect(result.current["501"].status).toBe("PAUSED");
  });

  it("a launch or pause elsewhere on the page re-reads this dashboard once, and another channel's does not", () => {
    h.data = payload("PAUSED", null);
    draw();
    expect(h.refreshSilent).not.toHaveBeenCalled();
    act(() => announceChannelDashboardStale("reddit_ads"));
    expect(h.refreshSilent).not.toHaveBeenCalled();
    act(() => announceChannelDashboardStale("linkedin_ads"));
    expect(h.refreshSilent).toHaveBeenCalledTimes(1);
  });
});
