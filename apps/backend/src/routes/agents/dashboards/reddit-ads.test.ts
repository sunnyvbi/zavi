import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import type { DashboardContext } from "./_contract";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), exec: vi.fn() }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolve }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: mocks.exec }));

import { build, type RedditAdsPayload } from "./reddit-ads";

let tenant = 0;
let accounts: Array<{ id: string; name: string; currency: string }>;
let fail: string | null;
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data }, error: null, outcome_unknown: false });
const read = async (overrides: Partial<DashboardContext> = {}) =>
  (await build({ tenantId: `tenant-${tenant}`, rangeDays: 30, refresh: false, meteredRefresh: false, ...overrides } as DashboardContext)) as RedditAdsPayload;

beforeEach(() => {
  tenant++;
  fail = null;
  accounts = [{ id: "a2_one", name: "Main", currency: "USD" }];
  mocks.resolve.mockReset();
  mocks.exec.mockReset();
  mocks.resolve.mockResolvedValue({ tenant_id: `tenant-${tenant}`, toolkit: "reddit_ads", connected_account_id: "ca", auth_config_id: "ac" } as OwnedComposioAccount);
  mocks.exec.mockImplementation(async ({ tool_slug, arguments: args }: { tool_slug: string; arguments: Record<string, unknown> }) => {
    if (fail === tool_slug) return { ok: false, status: 401, data: null, error: "Unauthorized", outcome_unknown: false };
    const acct = String(args.ad_account_id ?? "");
    switch (tool_slug) {
      case "REDDIT_ADS_LIST_MY_BUSINESSES":
        return ok([{ id: "biz" }]);
      case "REDDIT_ADS_LIST_AD_ACCOUNTS_BY_BUSINESS":
        return ok(accounts);
      case "REDDIT_ADS_LIST_CAMPAIGNS":
        return ok([
          { id: `${acct}-live`, name: "Live", configured_status: "ACTIVE", ad_account_id: acct },
          { id: `${acct}-paused`, name: "Paused", configured_status: "PAUSED", ad_account_id: acct, goal_type: "DAILY_SPEND", goal_value: 25_000_000 },
          { id: `${acct}-gone`, name: "Gone", configured_status: "ARCHIVED", ad_account_id: acct },
          { id: `${acct}-unfunded`, name: "Unfunded", configured_status: "ACTIVE", effective_status: "CAMPAIGN_NOT_FUNDED", ad_account_id: acct },
        ]);
      case "REDDIT_ADS_LIST_AD_GROUPS":
        return ok([
          { id: `${acct}-g1`, ad_account_id: acct, campaign_id: `${acct}-live`, configured_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 10_000_000 },
          { id: `${acct}-g2`, ad_account_id: acct, campaign_id: `${acct}-live`, configured_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 5_500_000 },
          { id: `${acct}-g3`, ad_account_id: acct, campaign_id: `${acct}-live`, configured_status: "ARCHIVED", goal_type: "DAILY_SPEND", goal_value: 99_000_000 },
          { id: `${acct}-g4`, ad_account_id: acct, campaign_id: `${acct}-paused`, configured_status: "ACTIVE", is_campaign_budget_optimization: true },
          { id: `${acct}-g5`, ad_account_id: acct, campaign_id: `${acct}-unfunded`, configured_status: "ACTIVE", goal_type: "LIFETIME_SPEND", goal_value: 300_000_000 },
        ]);
      case "REDDIT_ADS_GET_A_REPORT":
        return ok({
          metrics: [
            { campaign_id: `${acct}-live`, spend: 50_000_000, impressions: 10_000, clicks: 200, conversion_sign_up_clicks: 4, conversion_purchase_clicks: 1 },
            { CAMPAIGN_ID: `${acct}-paused`, SPEND: 10_000_000, IMPRESSIONS: 0, CLICKS: 0 },
          ],
        });
      default:
        throw new Error(`unexpected ${tool_slug}`);
    }
  });
});

describe("Reddit Ads dashboard", () => {
  it("reads six metrics and the campaigns through Composio's REDDIT_ADS tools", async () => {
    const d = await read();
    expect(d.connected).toBe(true);
    expect(d.error_code).toBeNull();
    expect(d.totals).toEqual({ spend: 60, impressions: 10_000, clicks: 200, conversions: 5, ctr: 2, cpc: 0.3, cpa: 12 });
    expect(d.campaigns.map((c) => [c.name, c.status])).toEqual([["Live", "ACTIVE"], ["Paused", "PAUSED"], ["Unfunded", "CAMPAIGN_NOT_FUNDED"]]);
    expect(d.account).toMatchObject({ name: "Main", campaign_count: 3, active_count: 1, currency: "USD" });
    const tools = new Set(mocks.exec.mock.calls.map(([a]) => (a as { tool_slug: string }).tool_slug));
    expect([...tools].every((t) => t.startsWith("REDDIT_ADS_"))).toBe(true);
  });

  it("carries each campaign's daily budget: its own under campaign budget, else the sum of its live ad groups", async () => {
    const d = await read();
    const budgets = Object.fromEntries(d.campaigns.map((c) => [c.name, c.daily_budget]));
    expect(budgets).toEqual({ Live: 15.5, Paused: 25, Unfunded: null });
  });

  it("leaves a mixed daily and lifetime campaign's budget unread instead of a partial sum", async () => {
    const base = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation(async (a: { tool_slug: string; arguments: Record<string, unknown> }) =>
      a.tool_slug === "REDDIT_ADS_LIST_AD_GROUPS"
        ? ok([
            { id: "g1", ad_account_id: "a2_one", campaign_id: "a2_one-live", configured_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 10_000_000 },
            { id: "g2", ad_account_id: "a2_one", campaign_id: "a2_one-live", configured_status: "ACTIVE", goal_type: "LIFETIME_SPEND", goal_value: 90_000_000 },
          ])
        : base(a),
    );
    const d = await read();
    expect(d.campaigns.find((c) => c.name === "Live")?.daily_budget).toBeNull();
  });

  it("keeps the dashboard when only the ad-group read fails, with budgets unread", async () => {
    fail = "REDDIT_ADS_LIST_AD_GROUPS";
    const d = await read();
    expect(d.error_code).toBeNull();
    expect(d.totals?.spend).toBe(60);
    expect(Object.fromEntries(d.campaigns.map((c) => [c.name, c.daily_budget]))).toEqual({ Live: null, Paused: 25, Unfunded: null });
  });

  it("leaves a campaign with no report rows unread instead of a measured zero", async () => {
    const d = await read();
    expect(d.campaigns.find((c) => c.name === "Unfunded")).toMatchObject({ spend: null, clicks: null, conversions: null, cpa: null });
    expect(d.campaigns.find((c) => c.name === "Paused")).toMatchObject({ spend: 10, clicks: 0 });
  });

  it("is an empty, unconnected payload when no account is linked", async () => {
    mocks.resolve.mockResolvedValue(null);
    const d = await read();
    expect(d).toMatchObject({ connected: false, totals: null, campaigns: [] });
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("names a revoked token instead of showing zeros", async () => {
    fail = "REDDIT_ADS_LIST_MY_BUSINESSES";
    const d = await read({ refresh: true });
    expect(d).toMatchObject({ connected: true, error_code: "reddit_ads_token_revoked", totals: null });
  });

  it("withholds money totals across mixed currencies", async () => {
    accounts.push({ id: "a2_two", name: "EU", currency: "EUR" });
    const d = await read();
    expect(d.account?.currency).toBeNull();
    expect(d.totals).toMatchObject({ spend: null, cpc: null, cpa: null, clicks: 400 });
  });
});
