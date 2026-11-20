import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owned: vi.fn(), pages: vi.fn(), proxyPages: vi.fn(), tool: vi.fn() }));
vi.mock("./adapter", async (original) => ({ ...await original<typeof import("./adapter")>(), ownedAccount: mocks.owned, pages: mocks.pages, proxyPages: mocks.proxyPages, tool: mocks.tool }));
import { metric, performance, REPORT_FIELDS, reportMetrics } from "./reporting";
import { eventFresh, readiness, tracking } from "./readiness";
const now = new Date("2026-10-09T01:00:00Z");
const row = Object.fromEntries(REPORT_FIELDS.map((f) => [f, 0]));
const lower = Object.fromEntries(REPORT_FIELDS.map((f) => [f.toLowerCase(), 0]));
const details = { id: "account", currency: "USD", time_zone_id: "America/Los_Angeles", admin_approval: "VALID" };
beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.owned.mockResolvedValue({ account: {}, details });
  mocks.pages.mockResolvedValue([]);
  mocks.proxyPages.mockResolvedValue([]);
});
describe("goal-specific Reddit measurement", () => {
  it("separates signup, lead, purchase and revenue, converting micros and cents independently", () => {
    expect(reportMetrics({ ...row, SPEND: 12500000, CLICKS: 12, IMPRESSIONS: 100, CONVERSION_SIGN_UP_CLICKS: 2, CONVERSION_SIGN_UP_VIEWS: 1, CONVERSION_LEAD_CLICKS: 4, CONVERSION_PURCHASE_CLICKS: 1, CONVERSION_PURCHASE_TOTAL_VALUE: 2599 }, "SIGN_UP")).toEqual({ spend: 12.5, impressions: 100, clicks: 12, signups: 3, leads: 4, purchases: 1, revenue: 25.99, goal_conversions: 3 });
    expect(reportMetrics({ ...lower, spend: "2000000", conversion_purchase_total_value: "150" })).toMatchObject({ spend: 2, revenue: 1.5 });
    expect(reportMetrics(row).goal_conversions).toBeNull();
  });
  it("fails a missing or malformed metric and keeps a null metric unread instead of reporting zero", () => {
    expect(metric({ SPEND: null }, "SPEND")).toBeNull();
    expect(reportMetrics({ ...row, CONVERSION_LEAD_VIEWS: null }, "LEAD")).toMatchObject({ leads: null, goal_conversions: null, signups: 0 });
    expect(reportMetrics({ ...row, SPEND: null })).toMatchObject({ spend: null });
    expect(() => metric({}, "SPEND")).toThrow("incomplete");
    expect(() => metric({ SPEND: "not a number" }, "SPEND")).toThrow("invalid");
    expect(() => metric({ SPEND: -1 }, "SPEND")).toThrow("invalid");
    expect(() => reportMetrics({ ...row, CLICKS: undefined })).toThrow("CLICKS");
  });
  it.each([false, true, "", "   ", [], [1], {}, "0x10", "Infinity", NaN, Infinity])("rejects a malformed metric %j", (value) => {
    expect(() => metric({ SPEND: value }, "SPEND")).toThrow("invalid");
  });
  it.each([0, "0", "12.5", " 12.5 ", "1e3"])("accepts a numeric metric %j", (value) => {
    expect(metric({ SPEND: value }, "SPEND")).toBe(Number(value));
  });
  it("windows the report on the account's calendar and marks the account's today provisional", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.proxyPages.mockResolvedValue([{ ...row, ad_group_id: "group", date: "2026-10-08" }, { ...row, AD_GROUP_ID: "group", DATE: "2026-10-07T00:00:00Z" }]);
    const r = await performance("tenant", "account", 7, "ad_group", "LEAD");
    expect(r).toMatchObject({ account_timezone: "America/Los_Angeles", window: { since: "2026-10-02", until: "2026-10-08" }, conversion_event: "LEAD", fetched_at: now.toISOString() });
    expect(r.rows.map((x) => [x.object_id, x.date, x.provisional])).toEqual([["group", "2026-10-08", true], ["group", "2026-10-07", false]]);
    expect(mocks.proxyPages).toHaveBeenCalledWith({}, "https://ads-api.reddit.com/api/v3/ad_accounts/account/reports", { starts_at: "2026-10-02T00:00:00Z", ends_at: "2026-10-09T00:00:00Z", time_zone_id: "America/Los_Angeles", fields: REPORT_FIELDS, breakdowns: ["AD_GROUP_ID", "DATE"] });
    expect(mocks.pages).not.toHaveBeenCalled();
  });
  it("refuses a report without an account timezone or a row without its object and date", async () => {
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { ...details, time_zone_id: undefined } });
    await expect(performance("tenant", "account", 7, "campaign")).rejects.toMatchObject({ code: "reddit_ads_timezone_unknown" });
    mocks.proxyPages.mockResolvedValue([{ ...row, campaign_id: "c1" }]);
    await expect(performance("tenant", "account", 7, "campaign")).rejects.toMatchObject({ code: "reddit_ads_bad_response" });
  });
  it.each(["", "not-a-date", "2026-2-03", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-10-00", "2026-10-08junk", "2026-10-08T99:00:00Z"])("rejects an invalid report date %j", async (date) => {
    mocks.proxyPages.mockResolvedValue([{ ...row, campaign_id: "c1", date }]);
    await expect(performance("tenant", "account", 7, "campaign")).rejects.toMatchObject({ code: "reddit_ads_bad_response" });
  });
  it.each(["2024-02-29", "2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000+05:30"])("accepts a valid leap-day report date %j", async (date) => {
    mocks.proxyPages.mockResolvedValue([{ ...row, campaign_id: "c1", date }]);
    expect((await performance("tenant", "account", 7, "campaign")).rows[0].date).toBe("2024-02-29");
  });
  it("checks the specific event's freshness rather than unrelated pixel activity", async () => {
    expect(eventFresh("2026-10-08T00:00:00Z", now)).toBe(true);
    expect(eventFresh("2026-09-20T00:00:00Z", now)).toBe(false);
    expect(eventFresh("2026-10-10T00:00:00Z", now)).toBe(false);
    expect(eventFresh(null, now)).toBe(false);
    mocks.pages.mockResolvedValue([{ id: "pixel" }]);
    mocks.tool.mockResolvedValue({ data: { page_visit: now.toISOString(), sign_up: null } });
    expect(await tracking({} as never, "account", "pixel", "SIGN_UP", now)).toMatchObject({ event: "SIGN_UP", last_fired_at: null, event_fresh: false });
    await expect(tracking({} as never, "account", "foreign", "SIGN_UP", now)).rejects.toMatchObject({ code: "reddit_ads_pixel_not_owned" });
  });
  it("reports stale goal tracking as the failure while keeping read, write and CAPI access distinct", async () => {
    mocks.pages.mockResolvedValue([{ id: "pixel", name: "Site" }]);
    mocks.tool.mockResolvedValue({ data: { sign_up: null } });
    const r = await readiness("tenant", "account", "pixel", "SIGN_UP");
    expect(r).toMatchObject({ read_access: "verified", write_access: "unverified", conversion_access: "unverified", execution_state: "read_only", account_ready: true, supported_currency: true, time_zone: "America/Los_Angeles", pixels: [{ id: "pixel", name: "Site" }], failure_reason: expect.stringContaining("SIGN_UP event"), capi: { state: "setup_required", automatic_optimization_ready: false } });
    expect(r.next_recovery_step).toBe(r.failure_reason);
  });
  it("names approval, currency, timezone and unreadable tracking problems without throwing", async () => {
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { ...details, admin_approval: "PENDING" } });
    expect((await readiness("tenant", "account")).failure_reason).toContain("approval");
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { ...details, currency: "EUR" } });
    expect(await readiness("tenant", "account")).toMatchObject({ supported_currency: false, failure_reason: expect.stringContaining("EUR") });
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { ...details, time_zone_id: undefined } });
    expect(await readiness("tenant", "account")).toMatchObject({ time_zone: null, failure_reason: expect.stringContaining("timezone") });
    mocks.pages.mockRejectedValueOnce(new Error("adsread permission missing"));
    await expect(readiness("tenant", "account", "pixel")).rejects.toThrow("permission missing");
    mocks.pages.mockResolvedValue([{ id: "pixel" }]);
    mocks.tool.mockRejectedValue(new Error("pixel activity unavailable"));
    expect(await readiness("tenant", "account", "pixel")).toMatchObject({ tracking: null, failure_reason: "pixel activity unavailable" });
    expect(await readiness("tenant", "account")).toMatchObject({ failure_reason: null, next_recovery_step: expect.stringContaining("Select an account pixel") });
  });
});
