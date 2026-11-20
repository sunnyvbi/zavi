import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lock: vi.fn(), token: vi.fn(), accounts: vi.fn(), campaigns: vi.fn(), stats: vi.fn(), list: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: mocks.lock }));
vi.mock("@/services/connectors/x-ads/client", () => ({ xAdsTenantToken: mocks.token, listXAdAccountsRaw: mocks.accounts, listXCampaignRows: mocks.campaigns, xCampaignStats: mocks.stats, xLinkClicksUnread: (s: { missing: Map<string, Set<string>> }, id: string) => !!s.missing.get(id)?.has("clicks") && !s.missing.get(id)?.has("impressions") }));
vi.mock("@/services/connectors/x-ads/resources", () => ({ listXResources: mocks.list }));
import { xAnalyticsRead } from "../x-analytics";
const query = { advertiser_id: "18ce5", campaign_id: "abc12", level: "groups", since: "2026-10-01", until: "2026-10-30" };
const stats = (rows: Record<string, { spend: number; impressions: number; clicks: number; conversions: number }>, engagements: Record<string, number>, conversionsRead = true) =>
  Object.assign(new Map(Object.entries(rows)), { conversionsRead, missing: new Map(), engagements: new Map(Object.entries(engagements)) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a" });
  mocks.token.mockResolvedValue({ key: "k", secret: "s" });
  mocks.accounts.mockResolvedValue([{ id: "18ce5", name: "Upcar" }]);
  mocks.campaigns.mockResolvedValue([{ campaign_id: "abc12", status: "ACTIVE", currency: "USD" }]);
  mocks.list.mockImplementation(async (_t: unknown, _a: string, resource: string) => resource === "line_items"
    ? [{ id: "g1", campaign_id: "abc12", name: "Drivers", entity_status: "ACTIVE" }, { id: "g2", campaign_id: "other", name: "Elsewhere", entity_status: "ACTIVE" }]
    : [{ id: "p1", line_item_id: "g1", tweet_id: "1900", entity_status: "PAUSED" }]);
  mocks.stats.mockResolvedValue(stats({ g1: { spend: 61.239, impressions: 4000, clicks: 40, conversions: 3 } }, { g1: 90 }));
});
async function run(q: Record<string, unknown> = query) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await xAnalyticsRead({ params: {}, query: q } as unknown as Request, res as unknown as Response);
  return res;
}
it("returns the campaign's own ad groups with the report window's numbers", async () => {
  const res = await run();
  expect(mocks.stats).toHaveBeenCalledWith({ key: "k", secret: "s" }, "18ce5", ["g1"], "2026-10-01", "2026-10-30", "LINE_ITEM");
  expect(res.json).toHaveBeenCalledWith({ currency: "USD", complete: true, rows: [{ id: "g1", name: "Drivers", status: "ACTIVE", spend: 61.24, conversions: 3, cpa: 20.41, value: null, clicks: 40, impressions: 4000, engagements: 90 }] });
});
it("reads promoted posts at the ad level, and leaves conversions unknown when X would not report them", async () => {
  mocks.stats.mockResolvedValue(stats({ p1: { spend: 5, impressions: 100, clicks: 2, conversions: 0 } }, {}, false));
  const res = await run({ ...query, level: "ads" });
  expect(mocks.list).toHaveBeenLastCalledWith({ key: "k", secret: "s" }, "18ce5", "promoted_tweets", { line_item_ids: "g1" });
  expect(mocks.stats).toHaveBeenCalledWith(expect.anything(), "18ce5", ["p1"], "2026-10-01", "2026-10-30", "PROMOTED_TWEET");
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ id: "p1", name: "Post 1900", status: "PAUSED", conversions: null, cpa: null, engagements: 0 })] }));
});
it("shows link clicks as unknown when X reported the ad group but left link clicks out", async () => {
  const unread = stats({ g1: { spend: 10, impressions: 500, clicks: 20, conversions: 0 } }, { g1: 5 });
  unread.missing.set("g1", new Set(["clicks"]));
  mocks.stats.mockResolvedValue(unread);
  const res = await run();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ id: "g1", clicks: null, impressions: 500 })] }));
});
it("refuses an ad account or campaign this login cannot see, before any ad group read", async () => {
  expect((await run({ ...query, advertiser_id: "zzzz9" })).status).toHaveBeenCalledWith(404);
  expect((await run({ ...query, campaign_id: "nope1" })).status).toHaveBeenCalledWith(404);
  expect(mocks.list).not.toHaveBeenCalled();
});
it("does not read without authentication, on a locked plan, or with invalid input", async () => {
  mocks.auth.mockResolvedValueOnce(null);
  await run();
  expect(mocks.token).not.toHaveBeenCalled();
  mocks.lock.mockResolvedValueOnce({ body: { locked: true } });
  expect((await run()).status).toHaveBeenCalledWith(403);
  expect((await run({ ...query, advertiser_id: "1 OR 1=1" })).status).toHaveBeenCalledWith(400);
  expect((await run({ ...query, since: "2026-01-01" })).status).toHaveBeenCalledWith(400);
});
