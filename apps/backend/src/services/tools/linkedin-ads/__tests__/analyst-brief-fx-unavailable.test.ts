import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInDailyAnalyticsRow } from "@/services/connectors/linkedin-ads/daily";

const m = vi.hoisted(() => ({ fxDown: false }));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountAccess: async () => ({ kind: "own" }) }));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInCampaigns: async () => [{ id: "1", name: "C1", status: "ACTIVE", objective: "WEBSITE_CONVERSIONS", budget: null, campaign_group_id: "5" }],
  listLinkedInCampaignGroups: async () => [{ id: "5", name: "Spring", status: "ACTIVE", total_budget: null, run_start_at: null, run_end_at: null }],
  listLinkedInAdAccounts: async () => [{ id: "500", name: "Own", currency: "EUR", status: "ACTIVE" }],
  readLinkedInAdAnalytics: async () => [{ pivot: "urn:li:sponsoredCampaign:1", impressions: 30_000, clicks: 600, spend: 360, conversions: 3, leads: 0 }],
}));
vi.mock("@/services/connectors/linkedin-ads/daily", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLinkedInDailyAnalytics: async () => {
    const rows: LinkedInDailyAnalyticsRow[] = [];
    for (let d = 1; d <= 30; d++) {
      rows.push({ date: `2026-10-${String(d).padStart(2, "0")}`, pivot: "urn:li:sponsoredCampaign:1", spend: 12, impressions: 1000, reach: 500, clicks: 20, conversions: 0, leads: 0, conversion_value: 0, missing_metrics: [] });
    }
    return { rows, truncated: false, read_through: "2026-10-30", partial_reason: null };
  },
}));
vi.mock("@/services/ads-wallet/fx", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  adsFx: async (currency: string) => {
    if (m.fxDown) throw new Error("fx down");
    return { currency, units_per_usd: 1, as_of: null, source: "ExchangeRate-API" };
  },
}));

import { linkedinAdsAnalystBriefTool, type LinkedInBrief } from "../analyst_brief";

const ctx = { tenant_id: "t1", log: () => {} } as never;
const brief = async () => (await linkedinAdsAnalystBriefTool.execute(ctx, { account_id: "500" })) as { briefs: LinkedInBrief[]; fx_note?: string };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  m.fxDown = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the brief when Zavi has no exchange rate for the account currency", () => {
  it("with a rate, the same line is graded", async () => {
    const [b] = (await brief()).briefs;
    expect(b.unread_metrics).toEqual([]);
    expect(b.confidence).not.toBe("inadequate");
  });

  it("must catch: without a rate, no posture is given and the note blames the missing rate, never LinkedIn leaving a number out", async () => {
    m.fxDown = true;
    const out = await brief();
    const [b] = out.briefs;
    expect(out.fx_note).toMatch(/exchange rate/);
    expect(b.recommended_posture).toBe("NO_DECISION");
    expect(b.confidence).toBe("inadequate");
    expect(b.unread_metrics).toEqual([]);
    expect(b.notes.join(" ")).toMatch(/exchange rate/);
    expect(b.notes.join(" ")).not.toMatch(/LinkedIn left/);
  });
});
