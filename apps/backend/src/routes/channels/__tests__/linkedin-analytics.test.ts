import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lock: vi.fn(), listed: vi.fn(), own: vi.fn(), analytics: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: mocks.lock }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ listLinkedInAdAccounts: mocks.listed, readLinkedInAdAnalytics: mocks.analytics }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ ownLinkedinAccountSet: mocks.own }));
import { linkedinAdAnalyticsRead } from "../linkedin-analytics";
const query = { since: "2026-10-01", until: "2026-10-30" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a" });
  mocks.listed.mockResolvedValue([{ id: "9001" }, { id: "9002" }]);
  mocks.own.mockResolvedValue({ accounts: [{ id: "9001", currency: "EUR" }], inactiveSelected: null });
  mocks.analytics.mockResolvedValue([
    { pivot: "urn:li:sponsoredCreative:701", impressions: 22000, clicks: 198, spend: 620.004, conversions: 0, leads: 14 },
    { pivot: null, impressions: 5, clicks: 0, spend: 1, conversions: 0, leads: 0 },
  ]);
});
async function run(q: Record<string, unknown> = query) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await linkedinAdAnalyticsRead({ params: {}, query: q } as unknown as Request, res as unknown as Response);
  return res;
}
it("reads each ad's numbers for the workspace's own accounts over the asked window", async () => {
  const res = await run();
  expect(mocks.analytics).toHaveBeenCalledTimes(1);
  expect(mocks.analytics).toHaveBeenCalledWith("tenant-a", "9001", { pivot: "CREATIVE", start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 10, day: 30 } });
  expect(res.json).toHaveBeenCalledWith({ rows: [{ id: "701", impressions: 22000, clicks: 198, spend: 620, leads: 14, currency: "EUR" }] });
});
it("does not read without authentication, on a locked plan, or with an invalid window, and says so when LinkedIn fails", async () => {
  mocks.auth.mockResolvedValueOnce(null);
  await run();
  expect(mocks.listed).not.toHaveBeenCalled();
  mocks.lock.mockResolvedValueOnce({ body: { locked: true } });
  expect((await run()).status).toHaveBeenCalledWith(403);
  expect((await run({ since: "2026-01-01", until: "2026-10-30" })).status).toHaveBeenCalledWith(400);
  mocks.analytics.mockRejectedValueOnce(new Error("throttled"));
  expect((await run()).status).toHaveBeenCalledWith(502);
});
