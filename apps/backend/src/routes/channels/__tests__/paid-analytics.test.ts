import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lock: vi.fn(), creds: vi.fn(), fb: vi.fn(), currency: vi.fn(), search: vi.fn(), groups: vi.fn(), ads: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: mocks.lock }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ metaAdsCreds: mocks.creds, fbGet: mocks.fb, getAdAccountCurrency: mocks.currency }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: mocks.search }));
vi.mock("@/services/tools/meta-ads/list_ad_sets", () => ({ metaListAdSetsTool: { execute: mocks.groups } }));
vi.mock("@/services/tools/meta-ads/list_ads", () => ({ metaListAdsTool: { execute: mocks.ads } }));
vi.mock("@/services/tools/google-ads/list_ad_groups", () => ({ listAdGroupsTool: { execute: mocks.groups } }));
vi.mock("@/services/tools/google-ads/list_ads", () => ({ listAdsTool: { execute: mocks.ads } }));
import { paidAnalyticsRead, paidAnalyticsQuery } from "../paid-analytics";
const query = { campaign_id: "123", level: "groups", since: "2026-10-01", until: "2026-10-30" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a" });
  mocks.creds.mockResolvedValue({ ad_account_id: "act_99" });
  mocks.fb.mockResolvedValue({ account_id: "99" });
  mocks.currency.mockResolvedValue("INR");
  mocks.groups.mockResolvedValue({ ad_sets: [{ ad_set_id: "11", ad_set_name: "Example", spend_usd: 100, conversions: 2.5, cpa_usd: 40, purchase_value_usd: 200 }], totals: { complete: false } });
});
async function run(channel = "meta_ads", q: Record<string, unknown> = query) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await paidAnalyticsRead({ params: { channel }, query: q } as unknown as Request, res as unknown as Response);
  return res;
}
it("binds reads to the authenticated workspace and selected reporting dates", async () => {
  const res = await run();
  expect(mocks.groups).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }), { campaign_id: "123", time_range: { since: query.since, until: query.until } });
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ currency: "INR", complete: false, rows: [expect.objectContaining({ spend: 100, conversions: 2.5, value: 200 })] }));
});
it("refuses a Meta campaign belonging to another connected account", async () => {
  mocks.fb.mockResolvedValue({ account_id: "different" });
  const res = await run();
  expect(res.status).toHaveBeenCalledWith(404);
  expect(mocks.groups).not.toHaveBeenCalled();
});
it("does not call providers without authentication or when the plan is locked", async () => {
  mocks.auth.mockResolvedValueOnce(null);
  await run();
  expect(mocks.creds).not.toHaveBeenCalled();
  mocks.lock.mockResolvedValue({ body: { locked: true } });
  const res = await run();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(mocks.groups).not.toHaveBeenCalled();
});
it.each([{ campaign_id: "1 OR 1=1" }, { since: "2026-02-30" }, { since: "2026-01-01" }, { tenant_id: "other" }, { level: "write" }])("rejects invalid or overriding inputs %j", patch => {
  expect(paidAnalyticsQuery.safeParse({ ...query, ...patch }).success).toBe(false);
});
it("a provider failure is an error, never an empty successful report", async () => {
  mocks.groups.mockRejectedValue(new Error("private provider failure"));
  const res = await run();
  expect(res.status).toHaveBeenCalledWith(502);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain("private provider failure");
});
it("uses Google account-scoped reads and preserves account currency", async () => {
  mocks.search.mockResolvedValue([{ customer: { currencyCode: "EUR" } }]);
  mocks.ads.mockResolvedValue({ ads: [], totals: { complete: true } });
  const res = await run("google_ads", { ...query, level: "ads" });
  expect(mocks.ads).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }), { campaign_id: "123", custom_range: { since: query.since, until: query.until } });
  expect(res.json).toHaveBeenCalledWith({ rows: [], currency: "EUR", complete: true });
});
it("reads a YouTube Ads campaign through the Google account, under the YouTube plan lock", async () => {
  mocks.search.mockResolvedValue([{ customer: { currencyCode: "USD" } }]);
  mocks.groups.mockResolvedValue({ ad_groups: [{ ad_group_id: "7", ad_group_name: "Viewers", spend_usd: 12, conversions: 1, cpa_usd: 12, conversions_value_usd: 30 }], totals: { complete: true } });
  const res = await run("youtube_ads");
  expect(mocks.lock.mock.calls).toEqual([["tenant-a", "youtube_ads"], ["tenant-a", "google_ads"]]);
  expect(mocks.groups).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }), { campaign_id: "123", custom_range: { since: query.since, until: query.until } });
  expect(res.json).toHaveBeenCalledWith({ rows: [{ id: "7", name: "Viewers", status: null, spend: 12, conversions: 1, cpa: 12, value: 30 }], currency: "USD", complete: true });
});
it("refuses the YouTube read when the Google Ads plan is locked, before any provider call", async () => {
  mocks.lock.mockImplementation(async (_tenant: string, slug: string) => slug === "google_ads" ? { body: { error: { code: "plan_locked" } } } : null);
  const res = await run("youtube_ads");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(mocks.search).not.toHaveBeenCalled();
  expect(mocks.groups).not.toHaveBeenCalled();
});
