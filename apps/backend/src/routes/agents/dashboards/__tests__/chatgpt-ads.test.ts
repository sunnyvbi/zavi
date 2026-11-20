import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ list: vi.fn(), report: vi.fn(), get: vi.fn(), purchases: vi.fn(), bindings: vi.fn() }));
vi.mock("@/services/connectors/chatgpt-ads/client", () => ({ listChatgptAdsCampaigns: m.list }));
vi.mock("@/services/connectors/chatgpt-ads/http", () => ({ chatgptAdsGet: m.get }));
vi.mock("@/services/connectors/chatgpt-ads/purchases", () => ({ readOwnedPurchaseReturn: m.purchases }));
vi.mock("@/services/connectors/chatgpt-ads/key-provider", () => ({ getChatgptAdsApiKey: async () => "key" }));
vi.mock("@/services/connectors/chatgpt-ads/tenant-scope", async original => ({ ...await original<typeof import("@/services/connectors/chatgpt-ads/tenant-scope")>(), resolveTenantCampaignPrefix: async () => "zv-acme--" }));
vi.mock("@/services/tools/chatgpt-ads/read_performance", () => ({ chatgptAdsReadPerformanceTool: { execute: m.report } }));
vi.mock("@/services/connectors/chatgpt-ads/resources", () => ({ bindings: m.bindings }));
import { build } from "../chatgpt-ads";
const ours = { id: "c1", name: "zv-acme--Launch", status: "active", budget: { lifetime_spend_limit_micros: 100000000 } };
const ctx = { ctx: { tenant_id: "t1" }, rangeDays: 7, sb: {} } as Parameters<typeof build>[0];
beforeEach(() => {
  vi.resetAllMocks();
  m.bindings.mockResolvedValue([]);
  m.list.mockResolvedValue({ campaigns: [ours, { id: "c2", name: "zv-other--Foreign", status: "active" }], pages_exhausted: false });
  m.get.mockResolvedValue({ currency_code: "USD", timezone: "UTC" });
  m.report.mockResolvedValue({ campaigns: [{ ...ours, clicks: 3, spend: 2 }, { id: "c2", spend: 999 }], totals_across_your_campaigns_only: { spend: 1001 } });
});
it("preserves owned campaign status and budget when insights fail", async () => {
  m.report.mockRejectedValue(new Error("insights unavailable"));
  const result = await build(ctx);
  expect(result.campaigns).toEqual([ours]); expect(result.totals_across_your_campaigns_only).toEqual({});
  expect(result.warning).toMatch(/pause controls remain available/); expect(result.no_campaigns_for_tenant).toBe(false);
});
it("preserves owned inventory and successful metrics when account/purchase reads fail", async () => {
  m.get.mockRejectedValue(new Error("account unavailable")); m.purchases.mockRejectedValue(new Error("purchase unavailable"));
  const result = await build(ctx);
  expect(result.campaigns).toEqual([{ ...ours, clicks: 3, spend: 2 }]); expect(result.currency).toBeNull();
  expect(result.totals_across_your_campaigns_only).toEqual({ spend: 2, clicks: 3 });
  expect(JSON.stringify(result)).not.toContain("Foreign"); expect(JSON.stringify(result)).not.toContain("999");
});
it("does not call an incomplete inventory a first-use account", async () => {
  m.list.mockResolvedValue({ campaigns: [], pages_exhausted: true });
  const result = await build(ctx);
  expect(result.no_campaigns_for_tenant).toBe(false); expect(result.warning).toMatch(/incomplete/);
});
it("does not present an inventory failure as zero campaigns or spend", async () => {
  m.list.mockRejectedValue(new Error("inventory failed"));
  const result = await build(ctx);
  expect(result.error_code).toBe("chatgpt_ads_unavailable"); expect(result.no_campaigns_for_tenant).toBeUndefined();
  expect(result.totals_across_your_campaigns_only).toEqual({});
});
it("keeps metrics but withholds the selected date label when the report interval is unconfirmed", async () => {
  m.report.mockResolvedValue({
    campaigns: [{ ...ours, spend: 2, requested_period_confirmed: false }],
    period_unconfirmed: true,
    period: { time_range: JSON.stringify({ since: "2026-10-01", until: "2026-10-07", timezone: "UTC" }) },
  });
  const result = (await build(ctx)) as Record<string, any>;
  expect(result.campaigns[0].spend).toBe(2);
  expect(result.period).toBeNull();
  expect(result.warning).toContain("shorter or different interval");
});
it("passes a validated structured draft to the shared editor without authorizing spend", async () => {
  const draft = { type: "campaign_draft", name: "Buyer launch", bidding_type: "clicks", group: { name: "Buyer intent", context_hints: ["A real buyer question"] }, ads: [{ name: "Card one", title: "Explore the offer", body: "A sourced offer.", target_url: "https://client.example", tracking: "utm_source=chatgpt", image_spec: "Image still needed" }] };
  const q: any = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [{ body: { step: { deliverable: { presentation: draft } } } }] }) };
  const result = await build({ ...ctx, sb: { from: () => q } as any });
  expect(result.draft).toEqual(draft);
  expect(result.draft).not.toHaveProperty("lifetime_budget_micros");
});

it("distinguishes a readable empty account from failed inventory and tracking reads", async () => {
  m.list.mockResolvedValue({ campaigns: [], pages_exhausted: false });
  expect(await build(ctx)).toMatchObject({ account_read: { status: "complete" }, conversion_tracking: "not_configured" });
  m.bindings.mockRejectedValue(new Error("offline"));
  expect(await build(ctx)).toMatchObject({ account_read: { status: "complete" }, conversion_tracking: "unavailable" });
  m.list.mockRejectedValue(new Error("offline"));
  expect(await build(ctx)).toMatchObject({ account_read: { status: "unavailable" } });
});
