import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import type { DashboardContext } from "./_contract";
import type { TiktokAdvertiser } from "@/services/connectors/tiktok-ads/composio-read";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), proxy: vi.fn() }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolve }));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: mocks.proxy }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({
  ensureAdAccounts: async () => ({
    connected: true,
    accounts: advertisers.map((a) => ({ ...a, source: "business_center" })),
    selected_id: advertisers[0]?.advertiser_id ?? null,
    needs: "nothing",
    checked_at: null,
  }),
}));

import { build, type TiktokAdsPayload } from "./tiktok-ads";

let connection: OwnedComposioAccount;
let advertisers: TiktokAdvertiser[];
let tenant = 0;
const context = (overrides: Partial<DashboardContext> = {}) => ({
  tenantId: `tenant-${tenant}`, rangeDays: 30, refresh: false, meteredRefresh: false, ...overrides,
}) as DashboardContext;
const advertiser = (id: string, currency: string | null): TiktokAdvertiser => ({ advertiser_id: id, name: id, currency, status: "ENABLE", timezone: "UTC" });
const read = async (overrides: Partial<DashboardContext> = {}) => await build(context(overrides)) as TiktokAdsPayload;

beforeEach(() => {
  tenant++;
  mocks.resolve.mockReset();
  mocks.proxy.mockReset();
  connection = { tenant_id: `tenant-${tenant}`, toolkit: "tiktok_ads", connected_account_id: "A", auth_config_id: "config" } as OwnedComposioAccount;
  advertisers = [advertiser("1", "USD")];
  mocks.resolve.mockImplementation(async () => connection);
  mocks.proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
    const url = new URL(endpoint, "https://example.test");
    const id = url.searchParams.get("advertiser_id");
    const rows: Record<string, unknown>[] = url.pathname === "/bc/get/" ? [{ bc_info: { bc_id: "bc" } }]
      : url.pathname === "/bc/asset/get/" ? advertisers.map((a) => ({ asset_id: a.advertiser_id }))
      : url.pathname === "/advertiser/info/" ? advertisers.map((a) => ({ ...a, name: `${connection.connected_account_id}-${a.name}` }))
      : url.pathname === "/campaign/get/" ? [{ campaign_id: `campaign-${id}`, campaign_name: `Campaign ${id}`, operation_status: "ENABLE" }]
      : url.pathname === "/adgroup/get/" ? [{ adgroup_id: `group-${id}`, campaign_id: `campaign-${id}`, operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_TIME_DONE", budget: 20.01, budget_mode: "BUDGET_MODE_DAY" }]
      : [{ dimensions: { campaign_id: `campaign-${id}` }, metrics: { spend: id === "1" ? "100" : "1000", impressions: "1000", clicks: "100", conversion: "10", total_complete_payment_rate: "200" } }];
    return { ok: true, status: 200, json: { code: 0, data: { list: rows } } };
  });
});

describe("TikTok dashboard reports", () => {
  it("carries video views when TikTok reports them and each campaign's daily budget", async () => {
    const inner = mocks.proxy.getMockImplementation()!;
    mocks.proxy.mockImplementation(async (call: { endpoint: string }) => {
      const url = new URL(call.endpoint, "https://example.test");
      const out = await inner(call);
      if (url.pathname !== "/report/integrated/get/" || !url.searchParams.get("metrics")?.includes("video_watched_2s")) return out;
      return { ok: true, status: 200, json: { code: 0, data: { list: [{ dimensions: { campaign_id: "campaign-1" }, metrics: { spend: "100", impressions: "1000", clicks: "100", conversion: "10", total_complete_payment_rate: "200", video_watched_2s: "640" } }] } } };
    });
    const data = await read();
    expect(data.totals).toMatchObject({ spend: 100, views: 640 });
    expect(data.campaigns[0]).toMatchObject({ views: 640, daily_budget: 20.01 });
    expect(data.daily_budget).toEqual({ total_daily_budget_usd: 20.01, active_campaigns: 1, known_daily_budget_usd: 20.01, known_campaigns: 1 });
  });
  it("keeps the report and leaves views unknown when TikTok refuses the views metric", async () => {
    const inner = mocks.proxy.getMockImplementation()!;
    mocks.proxy.mockImplementation(async (call: { endpoint: string }) => {
      const url = new URL(call.endpoint, "https://example.test");
      if (url.pathname === "/report/integrated/get/" && url.searchParams.get("metrics")?.includes("video_watched_2s")) return { ok: true, status: 200, json: { code: 40002, message: "Invalid metric" } };
      return inner(call);
    });
    const data = await read();
    expect(data.error_code).toBeNull();
    expect(data.totals).toMatchObject({ spend: 100, views: null });
    expect(data.campaigns[0].views).toBeNull();
  });
  it("includes each campaign's child delivery status, scoped to its advertiser", async () => {
    advertisers.push(advertiser("2", "USD"));
    const data = await read();
    expect(data.campaigns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "campaign-1", ad_groups: [expect.objectContaining({ id: "group-1", secondary_status: "ADGROUP_STATUS_TIME_DONE" })] }),
      expect.objectContaining({ id: "campaign-2", ad_groups: [expect.objectContaining({ id: "group-2", secondary_status: "ADGROUP_STATUS_TIME_DONE" })] }),
    ]));
  });
  it("aggregates compatible currencies with nonzero current and prior results", async () => {
    advertisers.push(advertiser("2", "USD"));
    const data = await read();
    expect(data.account?.currency).toBe("USD");
    expect(data.totals).toMatchObject({ spend: 1100, conversions: 20, cpa: 55, conv_value: 400, roas: 0.36 });
    expect(data.totals).toMatchObject(data.prev_totals!);
    expect(data.campaigns.every((campaign) => campaign.currency === "USD")).toBe(true);
  });

  it("preserves a non-USD currency without conversion", async () => {
    advertisers = [advertiser("1", "INR")];
    const data = await read();
    expect(data.account?.currency).toBe("INR");
    expect(data.totals?.spend).toBe(100);
    expect(data.campaigns[0]).toMatchObject({ currency: "INR", spend: 100 });
  });

  it.each(["INR", null])("withholds monetary totals when a second currency is %s", async (currency) => {
    advertisers.push(advertiser("2", currency));
    const data = await read();
    expect(data.account?.currency).toBeNull();
    expect(data.totals).toMatchObject({ spend: null, conv_value: null, cpa: null, roas: null, conversions: 20, clicks: 200, ctr: 10 });
    expect(data.totals).toMatchObject(data.prev_totals!);
    expect(data.campaigns.find((campaign) => campaign.advertiser_id === "2")).toMatchObject({ spend: 1000, currency });
  });

  it("reuses a report for the same account but rebuilds after reconnect", async () => {
    expect((await read()).account?.name).toBe("A-1");
    mocks.proxy.mockClear();
    expect((await read()).account?.name).toBe("A-1");
    expect(mocks.proxy).not.toHaveBeenCalled();
    connection = { ...connection, connected_account_id: "B" };
    expect((await read()).account?.name).toBe("B-1");
    expect(mocks.proxy).toHaveBeenCalled();
  });

  it.each(["refresh", "meteredRefresh"] as const)("honors %s and removes a failed cached read", async (flag) => {
    await read();
    mocks.proxy.mockResolvedValue({ ok: false, status: 503, json: {} });
    const failed = await read({ [flag]: true });
    expect(failed).toMatchObject({ connected: true, error_code: "tiktok_ads_read_failed", totals: null, prev_totals: null, campaigns: [] });
    expect((await read()).totals).toBeNull();
  });

  it("does not cache malformed responses as successful zeros", async () => {
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: {} });
    expect(await read()).toMatchObject({ error_code: "tiktok_ads_bad_response", totals: null });
    mocks.proxy.mockClear();
    await read();
    expect(mocks.proxy).toHaveBeenCalled();
  });

  it("distinguishes an account lookup failure from no connection", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("unavailable"));
    expect(await read()).toMatchObject({ connected: true, error_code: "tiktok_ads_read_failed", totals: null });
    mocks.resolve.mockResolvedValueOnce(null);
    expect(await read()).toMatchObject({ connected: false, error_code: null, totals: null });
  });

  it("keeps a rate-limit outcome distinct from token revocation", async () => {
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { code: 40100, message: "too frequent" } });
    expect(await read()).toMatchObject({ connected: true, error_code: "tiktok_ads_rate_limited", totals: null });
  });
});
