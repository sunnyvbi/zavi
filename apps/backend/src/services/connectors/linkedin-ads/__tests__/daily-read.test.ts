import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const get = vi.fn();
vi.mock("../http", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAdsGet: (...args: unknown[]) => get(...args) }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tenant-token" }));

import { LINKEDIN_DAILY_CHUNK_DAYS, readLinkedInDailyAnalytics, readLinkedInDailyAnalyticsWithToken, toDailyRow } from "../daily";
import { LINKEDIN_ADS_DAILY_LIMIT } from "../http";

type Params = { dateRange: { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } }; pivot: string; timeGranularity: string };
const URN = "urn:li:sponsoredCampaign:7";
const day = (d: number, over: Record<string, unknown> = {}) => ({
  dateRange: { start: { year: 2026, month: 10, day: d } },
  pivotValues: [URN],
  costInLocalCurrency: "12.50",
  impressions: 400,
  clicks: 9,
  externalWebsiteConversions: 1,
  oneClickLeads: 0,
  ...over,
});
const busy = () => new ExpectedToolError("linkedin_ads_http_error", "busy", { status: 429, http_status: 429, retry_at: "2026-10-31T00:00:00.000Z" });
const chunkDays = (p: Params) => p.dateRange.start.day;
const window = { pivot: "CAMPAIGN" as const, since: "2026-10-01", until: "2026-10-30" };

beforeEach(() => {
  get.mockReset();
});

describe("a LinkedIn day row keeps a missing metric unknown", () => {
  it("a day LinkedIn leaves conversions out is null and listed, while a reported zero stays a zero", () => {
    const row = toDailyRow(day(3, { externalWebsiteConversions: undefined, impressions: 0 }));
    expect(row).toMatchObject({ date: "2026-10-03", pivot: URN, conversions: null, impressions: 0, clicks: 9, spend: 12.5 });
    expect(row?.missing_metrics).toEqual(["reach", "conversions", "conversion_value"]);
    expect(JSON.stringify(row)).not.toContain('"conversions":0');
  });

  it("an unparseable amount is unknown, not a number", () => {
    const row = toDailyRow(day(3, { costInLocalCurrency: "n/a", conversionValueInLocalCurrency: "" }));
    expect(row?.spend).toBeNull();
    expect(row?.conversion_value).toBeNull();
    expect(row?.missing_metrics).toEqual(expect.arrayContaining(["spend", "conversion_value"]));
  });

  it("a row with no day or no pivot is a bad answer, never a silent skip", async () => {
    get.mockResolvedValue({ elements: [{ pivotValues: [URN], clicks: 1 }] });
    await expect(readLinkedInDailyAnalyticsWithToken("tok", "11", window)).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
  });
});

describe("a 30-day daily read is chunked like the budget ledger and says when it is partial", () => {
  it("asks LinkedIn for DAILY rows per pivot in 7-day chunks with every metric the brief needs", async () => {
    get.mockResolvedValue({ elements: [day(1)] });
    const out = await readLinkedInDailyAnalytics("tenant", "11", { ...window, pivot: "CAMPAIGN_GROUP" });
    expect(get).toHaveBeenCalledTimes(Math.ceil(30 / LINKEDIN_DAILY_CHUNK_DAYS));
    const first = get.mock.calls[0];
    expect(first[1]).toBe("adAnalytics");
    expect(first[2]).toMatchObject({ q: "analytics", pivot: "CAMPAIGN_GROUP", timeGranularity: "DAILY", accounts: ["urn:li:sponsoredAccount:11"], dateRange: { start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 10, day: 7 } } });
    expect(first[3].fields.split(",")).toEqual(expect.arrayContaining(["dateRange", "pivotValues", "costInLocalCurrency", "impressions", "approximateMemberReach", "clicks", "externalWebsiteConversions", "oneClickLeads", "conversionValueInLocalCurrency"]));
    expect(out.truncated).toBe(false);
    expect(out.read_through).toBe("2026-10-30");
  });

  it("must catch: a 429 on the second chunk keeps the first chunk's days, says truncated and where the read stopped", async () => {
    get.mockImplementation(async (_t: string, _p: string, params: Params) => {
      if (chunkDays(params) === 8) throw busy();
      return { elements: [day(chunkDays(params))] };
    });
    const out = await readLinkedInDailyAnalyticsWithToken("tok", "11", window);
    expect(out).toMatchObject({ truncated: true, read_through: "2026-10-07", partial_reason: "rate_limited" });
    expect(out.rows.map((r) => r.date)).toEqual(["2026-10-01"]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("a 429 on the first chunk is an error, not an empty partial answer", async () => {
    get.mockRejectedValue(busy());
    await expect(readLinkedInDailyAnalyticsWithToken("tok", "11", window)).rejects.toMatchObject({ meta: { http_status: 429 } });
  });

  it("a chunk at LinkedIn's element cap is left out and the read says so", async () => {
    get.mockImplementation(async (_t: string, _p: string, params: Params) =>
      chunkDays(params) === 15 ? { elements: Array.from({ length: 15_000 }, () => day(15)) } : { elements: [day(chunkDays(params))] },
    );
    const out = await readLinkedInDailyAnalyticsWithToken("tok", "11", window);
    expect(out).toMatchObject({ truncated: true, read_through: "2026-10-14", partial_reason: "element_cap" });
    expect(out.rows).toHaveLength(2);
  });

  it("passes the campaign filter through and sorts rows by entity then day", async () => {
    get.mockImplementation(async (_t: string, _p: string, params: Params) => ({
      elements: [day(chunkDays(params) + 1, { pivotValues: ["urn:li:sponsoredCampaign:9"] }), day(chunkDays(params))],
    }));
    const out = await readLinkedInDailyAnalyticsWithToken("tok", "11", { ...window, campaigns: [URN, "urn:li:sponsoredCampaign:9"] });
    expect(get.mock.calls[0][2]).toMatchObject({ campaigns: [URN, "urn:li:sponsoredCampaign:9"] });
    const order = out.rows.map((r) => `${r.pivot.split(":").pop()}@${r.date.slice(-2)}`);
    expect(order).toEqual(["7@01", "7@08", "7@15", "7@22", "7@29", "9@02", "9@09", "9@16", "9@23", "9@30"]);
  });
});

describe("a read that breaks after some chunks keeps what was read, in order", () => {
  const dayLimit = () => new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT, { status: 429, http_status: 429 });

  it("must catch: a malformed row in the third chunk is a truncated read, never a thrown-away first two weeks", async () => {
    get.mockImplementation(async (_t: string, _p: string, params: Params) =>
      chunkDays(params) === 15 ? { elements: [day(15), { pivotValues: [URN], clicks: 3 }] } : { elements: [day(chunkDays(params))] },
    );
    const out = await readLinkedInDailyAnalyticsWithToken("tok", "11", window);
    expect(out).toMatchObject({ truncated: true, read_through: "2026-10-14", partial_reason: "read_failed" });
    expect(out.rows.map((r) => r.date)).toEqual(["2026-10-01", "2026-10-08"]);
  });

  it("a malformed row in the first chunk is still an error", async () => {
    get.mockResolvedValue({ elements: [{ pivotValues: [URN], clicks: 3 }] });
    await expect(readLinkedInDailyAnalyticsWithToken("tok", "11", window)).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
  });

  it("must catch: LinkedIn's daily limit mid-read is named as such, not as a slow-down that a retry in a minute would fix", async () => {
    get.mockImplementation(async (_t: string, _p: string, params: Params) => {
      if (chunkDays(params) === 8) throw dayLimit();
      return { elements: [day(chunkDays(params))] };
    });
    const out = await readLinkedInDailyAnalyticsWithToken("tok", "11", window);
    expect(out).toMatchObject({ truncated: true, read_through: "2026-10-07", partial_reason: "daily_limit" });
  });

  it("must catch: a truncated read is sorted by entity then day like a whole one", async () => {
    get.mockImplementation(async (_t: string, _p: string, params: Params) => {
      if (chunkDays(params) === 15) throw busy();
      return { elements: [day(chunkDays(params) + 1, { pivotValues: ["urn:li:sponsoredCampaign:9"] }), day(chunkDays(params))] };
    });
    const out = await readLinkedInDailyAnalyticsWithToken("tok", "11", window);
    expect(out.truncated).toBe(true);
    expect(out.rows.map((r) => `${r.pivot.split(":").pop()}@${r.date.slice(-2)}`)).toEqual(["7@01", "7@08", "9@02", "9@09"]);
  });
});
