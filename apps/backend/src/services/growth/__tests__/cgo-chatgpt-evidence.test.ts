import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/services/tools/chatgpt-ads/read_performance", () => ({ readChatgptPerformance: m.read }));
import { readChatgptEvidence } from "../cgo-evidence";
const now = new Date("2026-10-08T12:00:00Z");
const campaign = { id: "campaign-a", name: "Campaign", status: "active", spend: 4, conversions: 2, impressions: 10, bidding_type: "clicks", requested_period_confirmed: true };
beforeEach(() => m.read.mockResolvedValue({ currency: "USD", period: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" }, campaigns: [campaign] }));
it("uses the tenant-scoped seven-day reader and does not infer tracking from conversions", async () => {
  const result = await readChatgptEvidence("tenant-a", now);
  expect(m.read).toHaveBeenCalledWith("tenant-a", 7, undefined, now);
  expect(result.campaigns?.[0]).toMatchObject({ delivery_state: "observed_delivery", ad_sets: [expect.objectContaining({ spend_7d_usd: 4, conversions_7d: 2, tracking: "unknown" })] });
});
it("an active campaign with an ended schedule is ended, even with historical impressions", async () => {
  m.read.mockResolvedValue({ currency: "USD", period: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" }, campaigns: [{ ...campaign, end_time: now.getTime() / 1000 - 1 }] });
  expect((await readChatgptEvidence("tenant-a", now)).campaigns?.[0].delivery_state).toBe("ended");
});
it("does not treat activation as observed delivery", async () => {
  m.read.mockResolvedValue({ currency: "USD", period: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" }, campaigns: [{ ...campaign, impressions: 0 }] });
  expect((await readChatgptEvidence("tenant-a", now)).campaigns?.[0].delivery_state).toBe("active_unverified");
});
it("withholds figures whose period is unconfirmed", async () => {
  m.read.mockResolvedValue({ currency: "USD", period: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" }, period_unconfirmed: true, campaigns: [{ ...campaign, period_unconfirmed: true, requested_period_confirmed: false }] });
  expect((await readChatgptEvidence("tenant-a", now)).campaigns?.[0]).toMatchObject({ delivery_state: "active_unverified", ad_sets: [expect.objectContaining({ spend_7d_usd: null, conversions_7d: null })] });
});
it("does not label non-USD amounts as dollars", async () => {
  m.read.mockResolvedValue({ currency: "INR", period: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" }, campaigns: [campaign] });
  expect((await readChatgptEvidence("tenant-a", now)).campaigns?.[0].ad_sets[0].spend_7d_usd).toBeNull();
});
it.each([{ truncated: true }, { rows_dropped: 1 }, { names_unclaimable: 1 }, { reporting_warning: "metrics unavailable" }])("does not publish a partial comparison: %s", async (warning) => {
  m.read.mockResolvedValue({ currency: "USD", period: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" }, campaigns: [campaign], ...warning });
  expect(await readChatgptEvidence("tenant-a", now)).toMatchObject({ status: "could not read" });
});
it("distinguishes a confirmed empty inventory from unverified inventory", async () => {
  m.read.mockResolvedValue({ no_campaigns_for_tenant: true });
  expect(await readChatgptEvidence("tenant-a", now)).toMatchObject({ status: "read", campaigns: [] });
  m.read.mockResolvedValue({ unverified: true });
  expect(await readChatgptEvidence("tenant-a", now)).toMatchObject({ status: "could not read" });
});
