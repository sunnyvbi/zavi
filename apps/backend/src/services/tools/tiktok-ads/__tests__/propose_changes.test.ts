import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  live: null as null | Record<string, unknown>,
  accounts: [{ advertiser_id: "111", name: "Main", currency: "USD" }, { advertiser_id: "222", name: "Euro", currency: "EUR" }],
  selected: "111" as string | null,
  emitted: [] as Array<{ cls: string; body: Record<string, unknown> }>,
}));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({ tiktokAdsAccount: async () => ({ connected_account_id: "ca1" }), tiktokCampaignsUrl: (id: string) => `https://ads/${id}` }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({
  ensureAdAccounts: async () => ({ connected: true, accounts: m.accounts, selected_id: m.selected, needs: "nothing", checked_at: "x" }),
}));
vi.mock("@/services/connectors/tiktok-ads/objects", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/tiktok-ads/objects")>()),
  readTiktokObject: async (_a: unknown, _adv: string, level: string) => level === "campaign" ? { level: "campaign", id: "102", campaign_id: "102", ad_group_id: null, name: "Parent", status: "ACTIVE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" } : m.live,
}));

import { tiktokAdsProposeBudgetChangeTool, tiktokAdsProposeStatusChangeTool } from "../propose_changes";
import { describeTiktokAction } from "../_exec-action";
import { listTikTokAdsTools } from "@/services/mcp/internal/tiktok-ads";

const emit = async (cls: string, body: unknown) => {
  m.emitted.push({ cls, body: body as Record<string, unknown> });
  return "act1";
};
const ctx = { tenant_id: "T", emit_decision: emit, log: () => {} };

beforeEach(() => {
  m.live = { level: "ad_group", id: "201", campaign_id: "102", name: "Group", status: "ACTIVE", budget: 30, budget_mode: "BUDGET_MODE_DAY" };
  m.selected = "111";
  m.emitted = [];
});

describe("tiktok_ads_propose_budget_change", () => {
  it("files the card from what TikTok says now, on the chosen account", async () => {
    const out = await tiktokAdsProposeBudgetChangeTool.execute(ctx, { level: "ad_group", object_id: "201", daily_budget_usd: 36, rationale: "CPA $12 over 7 days" });
    expect(out).toMatchObject({ action_id: "act1", status: "waiting_for_approval" });
    expect(m.emitted).toEqual([{ cls: "tiktok_ads.update_budget", body: expect.objectContaining({ advertiser_id: "111", advertiser_name: "Main", level: "ad_group", object_id: "201", campaign_id: "102", ad_group_id: "201", expected_current_daily_budget_usd: 30, daily_budget_usd: 36 }) }]);
    const card = describeTiktokAction("tiktok_ads.update_budget", m.emitted[0].body);
    expect(card.sentence).toContain("Main (111)");
    expect(card.rows[0]).toEqual({ item: "Ad account", before: "Main (111)", after: "Main (111)" });
  });
  it("refuses a run with no approval card, an unsaved account, a non-USD account, a missing object, a floor breach", async () => {
    const input = { level: "ad_group", object_id: "201", daily_budget_usd: 36, rationale: "r" };
    await expect(tiktokAdsProposeBudgetChangeTool.execute({ tenant_id: "T", log: () => {} }, input)).rejects.toMatchObject({ code: "tiktok_ads_propose_unavailable" });
    await expect(tiktokAdsProposeBudgetChangeTool.execute(ctx, { ...input, advertiser_id: "999" })).rejects.toMatchObject({ code: "tiktok_ads_unknown_account" });
    await expect(tiktokAdsProposeBudgetChangeTool.execute(ctx, { ...input, advertiser_id: "222" })).rejects.toMatchObject({ code: "tiktok_ads_currency_unsupported" });
    m.selected = null;
    await expect(tiktokAdsProposeBudgetChangeTool.execute(ctx, input)).rejects.toMatchObject({ code: "tiktok_ads_account_not_chosen" });
    m.selected = "111";
    await expect(tiktokAdsProposeBudgetChangeTool.execute(ctx, { ...input, daily_budget_usd: 15 })).rejects.toMatchObject({ code: "tiktok_ads_budget_below_floor" });
    m.live = null;
    await expect(tiktokAdsProposeBudgetChangeTool.execute(ctx, input)).rejects.toMatchObject({ code: "tiktok_ads_object_not_found" });
    expect(m.emitted).toEqual([]);
  });
});

describe("tiktok_ads_propose_status_change", () => {
  it("files a pause on a non-USD account without labelling its local budget as dollars", async () => {
    await tiktokAdsProposeStatusChangeTool.execute(ctx, { advertiser_id: "222", level: "ad_group", object_id: "201", status: "PAUSED", rationale: "stop" });
    expect(m.emitted[0].body).toMatchObject({ advertiser_id: "222", status: "PAUSED", daily_budget_usd: null });
  });
  it("a pause card carries the live status; a resume carries the daily budget it will hold", async () => {
    await tiktokAdsProposeStatusChangeTool.execute(ctx, { level: "ad_group", object_id: "201", status: "PAUSED", rationale: "no conversions" });
    expect(m.emitted[0]).toEqual({ cls: "tiktok_ads.set_status", body: expect.objectContaining({ status: "PAUSED", expected_current_status: "ACTIVE", daily_budget_usd: 30 }) });
    m.live = { ...m.live, status: "PAUSED" };
    await tiktokAdsProposeStatusChangeTool.execute(ctx, { level: "ad_group", object_id: "201", status: "ACTIVE", rationale: "back" });
    expect(m.emitted[1].body).toMatchObject({ status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: 30 });
    expect(describeTiktokAction("tiktok_ads.set_status", m.emitted[1].body).title).toBe('Turn the TikTok ad group "Group" back on');
  });
  it("never a resume without a daily budget of its own; never a no-op", async () => {
    m.live = { ...m.live, status: "PAUSED", budget_mode: "BUDGET_MODE_INFINITE", budget: 0 };
    await expect(tiktokAdsProposeStatusChangeTool.execute(ctx, { level: "ad_group", object_id: "201", status: "ACTIVE", rationale: "r" })).rejects.toMatchObject({ code: "tiktok_ads_budget_unknown" });
    await expect(tiktokAdsProposeStatusChangeTool.execute(ctx, { level: "ad_group", object_id: "201", status: "PAUSED", rationale: "r" })).rejects.toMatchObject({ code: "tiktok_ads_no_change" });
  });
});

it("the MCP server lists the three propose tools as writes beside the reads", () => {
  const tools = listTikTokAdsTools().map((t) => `${t.tool_name}:${t.effect}`);
  expect(tools).toEqual(["list_accounts:read", "list_campaigns:read", "list_ad_groups:read", "search_locations:read", "targeting_options:read", "propose_budget_change:write", "propose_status_change:write", "launch_readiness:read", "propose_launch:write"]);
});
