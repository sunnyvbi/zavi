import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lock: vi.fn(), account: vi.fn(), accounts: vi.fn(), objects: vi.fn(), report: vi.fn(), campaign: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: mocks.lock }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.account }));
vi.mock("@/services/connectors/reddit-ads/adapter", () => ({ listObjects: mocks.objects, getObject: mocks.campaign }));
vi.mock("@/services/connectors/reddit-ads/composio-read", () => ({ listAdAccounts: mocks.accounts, campaignReport: mocks.report, ZERO_SUMS: { spend: 0, impressions: 0, clicks: 0, conversions: 0 } }));
import { redditAnalyticsRead } from "../reddit-analytics";
const query = { advertiser_id: "a2_x", campaign_id: "c_1", level: "groups", since: "2026-10-01", until: "2026-10-30" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a" });
  mocks.account.mockResolvedValue({ connected_account_id: "A" });
  mocks.campaign.mockResolvedValue({ id: "c_1" });
  mocks.accounts.mockResolvedValue([{ id: "a2_x", name: "Upcar", currency: "USD", business_id: null }]);
  mocks.objects.mockResolvedValue([
    { id: "g_1", campaign_id: "c_1", name: "Drivers", configured_status: "ACTIVE" },
    { id: "g_2", campaign_id: "c_1", name: "Old", configured_status: "ARCHIVED" },
    { id: "g_3", campaign_id: "c_9", name: "Elsewhere", configured_status: "ACTIVE" },
  ]);
  mocks.report.mockResolvedValue(new Map([["g_1", { spend: 61.239, impressions: 4000, clicks: 40, conversions: 3 }]]));
});
async function run(q: Record<string, unknown> = query) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await redditAnalyticsRead({ params: {}, query: q } as unknown as Request, res as unknown as Response);
  return res;
}
it("returns the campaign's own live ad groups with the report window's numbers", async () => {
  const res = await run();
  expect(mocks.objects).toHaveBeenCalledWith({ connected_account_id: "A" }, "a2_x", "ad_group");
  expect(mocks.report).toHaveBeenCalledWith({ connected_account_id: "A" }, "a2_x", "2026-10-01", "2026-10-30", "ad_group");
  expect(res.json).toHaveBeenCalledWith({ currency: "USD", complete: true, rows: [{ id: "g_1", name: "Drivers", status: "ACTIVE", spend: 61.24, conversions: 3, cpa: 20.41, value: null, clicks: 40, impressions: 4000 }] });
});
it("reads ads at the ad level", async () => {
  mocks.objects.mockResolvedValue([{ id: "ad_5", campaign_id: "c_1", ad_group_id: "g_1", configured_status: "PAUSED" }]);
  const res = await run({ ...query, level: "ads" });
  expect(mocks.report).toHaveBeenCalledWith(expect.anything(), "a2_x", "2026-10-01", "2026-10-30", "ad");
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ id: "ad_5", name: "ad_5", spend: 0, cpa: null })] }));
});
it("refuses an ad account this workspace does not own, before any object read", async () => {
  expect((await run({ ...query, advertiser_id: "a2_other" })).status).toHaveBeenCalledWith(404);
  mocks.account.mockResolvedValueOnce(null);
  expect((await run()).status).toHaveBeenCalledWith(404);
  mocks.campaign.mockRejectedValueOnce(new Error("not in this account"));
  expect((await run()).status).toHaveBeenCalledWith(404);
  expect(mocks.objects).not.toHaveBeenCalled();
});
it("does not read without authentication, on a locked plan, or with invalid input", async () => {
  mocks.auth.mockResolvedValueOnce(null);
  await run();
  expect(mocks.account).not.toHaveBeenCalled();
  mocks.lock.mockResolvedValueOnce({ body: { locked: true } });
  expect((await run()).status).toHaveBeenCalledWith(403);
  expect((await run({ ...query, advertiser_id: "1 OR 1=1" })).status).toHaveBeenCalledWith(400);
});
