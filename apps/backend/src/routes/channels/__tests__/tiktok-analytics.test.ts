import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lock: vi.fn(), accounts: vi.fn(), account: vi.fn(), report: vi.fn(), groups: vi.fn(), ads: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: mocks.lock }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({ ensureAdAccounts: mocks.accounts }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({ tiktokAdsAccount: mocks.account, viewsReport: mocks.report }));
vi.mock("@/services/connectors/tiktok-ads/objects", () => ({ listTiktokAdGroups: mocks.groups, listTiktokAds: mocks.ads }));
import { tiktokAnalyticsRead } from "../tiktok-analytics";
const query = { advertiser_id: "900", campaign_id: "71", level: "groups", since: "2026-10-01", until: "2026-10-30" };
const group = (id: string, campaign_id: string, status = "ACTIVE") => ({ level: "ad_group", id, campaign_id, ad_group_id: id, name: `Group ${id}`, status, budget: 30, budget_mode: "BUDGET_MODE_DAY" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a" });
  mocks.accounts.mockResolvedValue({ accounts: [{ advertiser_id: "900", name: "Upcar", currency: "usd" }] });
  mocks.account.mockResolvedValue({ connected_account_id: "A" });
  mocks.groups.mockResolvedValue([group("1", "71"), group("2", "71", "DELETED"), group("3", "99")]);
  mocks.report.mockResolvedValue(new Map([["1", { spend: 61.239, impressions: 4000, clicks: 40, conversions: 3, conv_value: 0, views: 900 }]]));
});
async function run(q: Record<string, unknown> = query) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await tiktokAnalyticsRead({ params: {}, query: q } as unknown as Request, res as unknown as Response);
  return res;
}
it("returns the campaign's own live ad groups with the report window's numbers", async () => {
  const res = await run();
  expect(mocks.accounts).toHaveBeenCalledWith("tenant-a");
  expect(mocks.groups).toHaveBeenCalledWith({ connected_account_id: "A" }, "900", ["71"]);
  expect(mocks.report).toHaveBeenCalledWith({ connected_account_id: "A" }, "900", "ad_group", "2026-10-01", "2026-10-30");
  expect(res.json).toHaveBeenCalledWith({ currency: "USD", complete: true, rows: [{ id: "1", name: "Group 1", status: "ACTIVE", spend: 61.24, conversions: 3, cpa: 20.41, value: 0, views: 900, clicks: 40, impressions: 4000 }] });
});
it("reads ads at the ad level", async () => {
  mocks.ads.mockResolvedValue([{ ...group("5", "71"), level: "ad" }]);
  const res = await run({ ...query, level: "ads" });
  expect(mocks.report).toHaveBeenCalledWith(expect.anything(), "900", "ad", "2026-10-01", "2026-10-30");
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ id: "5", spend: 0, views: 0, cpa: null })] }));
});
it("refuses an ad account this workspace has not saved, before any TikTok read", async () => {
  const res = await run({ ...query, advertiser_id: "901" });
  expect(res.status).toHaveBeenCalledWith(404);
  expect(mocks.account).not.toHaveBeenCalled();
  expect(mocks.groups).not.toHaveBeenCalled();
});
it("does not read without authentication, on a locked plan, or with invalid input", async () => {
  mocks.auth.mockResolvedValueOnce(null);
  await run();
  expect(mocks.accounts).not.toHaveBeenCalled();
  mocks.lock.mockResolvedValueOnce({ body: { locked: true } });
  expect((await run()).status).toHaveBeenCalledWith(403);
  expect((await run({ ...query, advertiser_id: "1 OR 1=1" })).status).toHaveBeenCalledWith(400);
  expect((await run({ ...query, tenant_id: "other" })).status).toHaveBeenCalledWith(400);
  expect(mocks.accounts).not.toHaveBeenCalled();
});
it("a TikTok failure is an error, never an empty successful report", async () => {
  mocks.report.mockRejectedValue(new Error("down"));
  const res = await run();
  expect(res.status).toHaveBeenCalledWith(502);
  expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ rows: [] }));
});
