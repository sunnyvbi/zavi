import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), record: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async () => true, linkedinAccountStoppable: async () => true }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tenant-tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding, getAccountBinding: vi.fn() }));
vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinWalletGroups: async () => [], linkedinAccountAccess: async () => ({ kind: "own" }) }));

import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { linkedinAdsAnalystBriefTool, LINKEDIN_BRIEF_THRESHOLDS, type LinkedInBrief } from "../analyst_brief";
import { linkedinAdsDailySeriesTool, type LinkedInDailyRow } from "../daily_series";
import { linkedinAdsProposePauseCampaignTool } from "../propose_pause_campaign";

type Day = { spend: number; impressions: number; clicks: number; conversions: number | undefined; leads: number };
type Campaign = { id: string; objective: string; group: string; days: (date: string) => Day; history: { conversions: number; leads: number }; windowConversions?: number };

const NOW = new Date("2026-10-30T12:00:00.000Z");
const ACCOUNT = "11";
const campaigns = new Map<string, Campaign>();
let dailyFailsFrom: string | null = null;

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const busy = () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "60" }), json: async () => ({}), text: async () => JSON.stringify({ message: "throttled" }) });
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dates = (url: string) => {
  const [, sy, sm, sd, ey, em, ed] = url.match(/start:\(year:(\d+),month:(\d+),day:(\d+)\),end:\(year:(\d+),month:(\d+),day:(\d+)\)/) as string[];
  return { start: Date.UTC(+sy, +sm - 1, +sd), end: Date.UTC(+ey, +em - 1, +ed) };
};
const windowSum = (c: Campaign, start: number, end: number) => {
  const t = { spend: 0, impressions: 0, clicks: 0, conversions: 0 as number | undefined, leads: 0 };
  for (let ms = start; ms <= end; ms += 86_400_000) {
    const d = c.days(ymd(new Date(ms)));
    t.spend += d.spend;
    t.impressions += d.impressions;
    t.clicks += d.clicks;
    t.leads += d.leads;
    t.conversions = t.conversions === undefined || d.conversions === undefined ? undefined : t.conversions + d.conversions;
  }
  return t;
};
const analyticsRow = (id: string, d: Day, date?: string) => ({
  ...(date ? { dateRange: { start: { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10) } } } : {}),
  pivotValues: [`urn:li:sponsoredCampaign:${id}`],
  costInLocalCurrency: d.spend.toFixed(2),
  impressions: d.impressions,
  clicks: d.clicks,
  ...(d.conversions === undefined ? {} : { externalWebsiteConversions: d.conversions }),
  oneClickLeads: d.leads,
});

function route(url: string) {
  if (/adAccounts\?/.test(url) || url.endsWith("/adAccounts")) return ok({ elements: [{ id: Number(ACCOUNT), name: "Main", currency: "USD", status: "ACTIVE" }], metadata: {} });
  const single = /adAccounts\/11\/adCampaigns\/(\d+)/.exec(url);
  if (single) {
    const c = campaigns.get(single[1]);
    return ok({ id: Number(single[1]), name: `Campaign ${single[1]}`, status: "ACTIVE", account: `urn:li:sponsoredAccount:${ACCOUNT}`, objectiveType: c?.objective, campaignGroup: `urn:li:sponsoredCampaignGroup:${c?.group}` });
  }
  if (/adAccounts\/11\/adCampaigns\?/.test(url))
    return ok({
      elements: [...campaigns.values()].map((c) => ({ id: Number(c.id), name: `Campaign ${c.id}`, status: "ACTIVE", objectiveType: c.objective, campaignGroup: `urn:li:sponsoredCampaignGroup:${c.group}` })),
      metadata: {},
    });
  if (url.includes("adAnalytics")) {
    const { start, end } = dates(url);
    const wanted = [...url.matchAll(/sponsoredCampaign%3A(\d+)/g)].map((x) => x[1]);
    const picked = [...campaigns.values()].filter((c) => !wanted.length || wanted.includes(c.id));
    if (url.includes("timeGranularity=DAILY")) {
      if (dailyFailsFrom && ymd(new Date(start)) >= dailyFailsFrom) return busy();
      const elements = [];
      for (let ms = start; ms <= end; ms += 86_400_000) for (const c of picked) elements.push(analyticsRow(c.id, c.days(ymd(new Date(ms))), ymd(new Date(ms))));
      return ok({ elements });
    }
    const span = (end - start) / 86_400_000;
    if (span > 90) return ok({ elements: picked.map((c) => analyticsRow(c.id, { spend: 500, impressions: 50_000, clicks: 400, ...c.history })) });
    return ok({ elements: picked.map((c) => analyticsRow(c.id, { ...windowSum(c, start, end), ...(c.windowConversions === undefined ? {} : { conversions: c.windowConversions }) })) });
  }
  throw new Error(`unrouted ${url}`);
}

const steady = (d: Day) => () => d;
const ctx = { tenant_id: "t1", log: () => {}, emit_decision: m.record } as never;
const brief = async (level: "campaign" | "campaign_group" = "campaign") =>
  (await linkedinAdsAnalystBriefTool.execute(ctx, { account_id: ACCOUNT, level })) as { briefs: LinkedInBrief[]; truncated: boolean; warning?: string; thresholds: unknown };
const series = async () => (await linkedinAdsDailySeriesTool.execute(ctx, { account_id: ACCOUNT })) as { rows: LinkedInDailyRow[]; truncated: boolean; read_through: string | null; warning?: string; unread_metrics?: string[]; unread_note?: string };
const propose = (campaign_id: string) => linkedinAdsProposePauseCampaignTool.execute(ctx, { campaign_id, account_id: ACCOUNT, rationale: "spent with nothing back over 30 days" });
const briefFor = (out: { briefs: LinkedInBrief[] }, id: string) => out.briefs.find((b) => b.ad_set_id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetLinkedInAdsReadCache();
  campaigns.clear();
  dailyFailsFrom = null;
  m.fetch.mockReset();
  m.findBinding.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.record.mockReset();
  m.record.mockResolvedValue("card-1");
  m.fetch.mockImplementation(async (url: unknown) => route(String(url)));
  vi.stubGlobal("fetch", m.fetch);
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("linkedin_ads_analyst_brief grades from daily rows with LinkedIn's own floors", () => {
  it("uses provisional LinkedIn floors, not Meta's 30 clicks and 50 dollars", async () => {
    expect(LINKEDIN_BRIEF_THRESHOLDS).toEqual({ min_clicks: 21, min_spend_usd: 70, min_results_for_call: 10, results: "conversions" });
  });

  it("must catch: a lead-gen campaign with lead-form leads and no website conversion is converting, never CUT_CANDIDATE", async () => {
    campaigns.set("22", { id: "22", objective: "LEAD_GENERATION", group: "5", days: steady({ spend: 20, impressions: 2000, clicks: 15, conversions: 0, leads: 2 }), history: { conversions: 0, leads: 60 } });
    const out = await brief();
    const b = briefFor(out, "22");
    expect(b.judged_on).toBe("conversions");
    expect(b.funnel_diagnosis).toBe("converting_healthy");
    expect(b.recommended_posture).not.toBe("CUT_CANDIDATE");
    expect(b.pause_signal).toBe("has_results");
    expect(b.settled_window).toMatchObject({ conversions: 14, leads: 14, spend_usd: 140 });
    await expect(propose("22")).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate", meta: { pause_signal: "has_results" } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("must catch: spend and zero results on a campaign that never showed a result is tracking_unverified, so NO_DECISION and no pause card", async () => {
    campaigns.set("23", { id: "23", objective: "WEBSITE_CONVERSIONS", group: "5", days: steady({ spend: 20, impressions: 2000, clicks: 15, conversions: 0, leads: 0 }), history: { conversions: 0, leads: 0 } });
    const b = briefFor(await brief(), "23");
    expect(b.pause_signal).toBe("tracking_unverified");
    expect(b.recommended_posture).toBe("NO_DECISION");
    expect(b.notes.join(" ")).toMatch(/tracking is unverified/);
    await expect(propose("23")).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate", meta: { pause_signal: "tracking_unverified" } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("must catch: a week readable under LinkedIn's floors but not Meta's, with verified tracking and nothing back, is CUT_CANDIDATE and the pause tool files the card", async () => {
    campaigns.set("24", { id: "24", objective: "WEBSITE_CONVERSIONS", group: "5", days: steady({ spend: 12, impressions: 500, clicks: 4, conversions: 0, leads: 0 }), history: { conversions: 3, leads: 0 } });
    const b = briefFor(await brief(), "24");
    expect(b.settled_window).toMatchObject({ clicks: 28, spend_usd: 84 });
    expect(b.confidence).toBe("thin");
    expect(b.pause_signal).toBe("pause_candidate");
    expect(b.recommended_posture).toBe("CUT_CANDIDATE");
    await expect(propose("24")).resolves.toMatchObject({ action_id: "card-1" });
    expect(m.record).toHaveBeenCalledWith("linkedin_ads.set_status", expect.objectContaining({ campaign_id: "24", status: "PAUSED" }));
  });

  it("a campaign bought on reach and clicks is never cut on conversions", async () => {
    campaigns.set("26", { id: "26", objective: "BRAND_AWARENESS", group: "5", days: steady({ spend: 12, impressions: 500, clicks: 4, conversions: 0, leads: 0 }), history: { conversions: 3, leads: 0 } });
    const b = briefFor(await brief(), "26");
    expect(b.judged_on).toBe("reach_and_clicks");
    expect(b.recommended_posture).toBe("NO_DECISION");
  });

  it("must catch: the pause tool refuses the agent's own waste proposal for a reach campaign, even one whose history has conversions", async () => {
    campaigns.set("26", { id: "26", objective: "BRAND_AWARENESS", group: "5", days: steady({ spend: 12, impressions: 500, clicks: 4, conversions: 0, leads: 0 }), history: { conversions: 3, leads: 0 } });
    await expect(propose("26")).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate", meta: { pause_signal: "reach_and_clicks" } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("must catch: a settled day LinkedIn leaves conversions out is unknown in the series and silences the brief, never a zero and never a cut", async () => {
    campaigns.set("25", {
      id: "25",
      objective: "WEBSITE_CONVERSIONS",
      group: "5",
      days: (date) => ({ spend: 12, impressions: 500, clicks: 4, conversions: date === "2026-10-22" ? undefined : 0, leads: 0 }),
      history: { conversions: 3, leads: 0 },
      windowConversions: 0,
    });
    const s = await series();
    const day = s.rows.find((r) => r.ad_set_id === "25" && r.date === "2026-10-22")!;
    expect(day.conversions).toBeNull();
    expect(day.website_conversions).toBeNull();
    expect(day.missing_metrics).toContain("conversions");
    expect(s.rows.find((r) => r.ad_set_id === "25" && r.date === "2026-10-21")?.conversions).toBe(0);
    expect(s.unread_metrics).toContain("conversions");
    expect(s.unread_note).toMatch(/unknown, not zero/);
    const b = briefFor(await brief(), "25");
    expect(b.pause_signal).toBe("metrics_unread");
    expect(b.unread_metrics).toEqual(expect.arrayContaining(["conversions"]));
    expect(b.recommended_posture).toBe("NO_DECISION");
    expect(b.confidence).toBe("inadequate");
    expect(b.notes.join(" ")).toMatch(/unknown, not zero/);
  });

  it("must catch: a 429 on the second week of a 30-day read makes the series partial and every posture NO_DECISION", async () => {
    campaigns.set("24", { id: "24", objective: "WEBSITE_CONVERSIONS", group: "5", days: steady({ spend: 12, impressions: 500, clicks: 4, conversions: 0, leads: 0 }), history: { conversions: 3, leads: 0 } });
    campaigns.set("22", { id: "22", objective: "LEAD_GENERATION", group: "5", days: steady({ spend: 20, impressions: 2000, clicks: 15, conversions: 0, leads: 2 }), history: { conversions: 0, leads: 60 } });
    dailyFailsFrom = "2026-10-08";
    const s = await series();
    expect(s).toMatchObject({ truncated: true, read_through: "2026-10-07" });
    expect(s.warning).toMatch(/PARTIAL/);
    expect(new Set(s.rows.map((r) => r.date)).size).toBe(7);
    resetLinkedInAdsReadCache();
    const out = await brief();
    expect(out.truncated).toBe(true);
    expect(out.warning).toMatch(/NO_DECISION/);
    expect(out.briefs).toHaveLength(2);
    expect(out.briefs.map((b) => b.recommended_posture)).toEqual(["NO_DECISION", "NO_DECISION"]);
    expect(out.briefs.map((b) => b.confidence)).toEqual(["inadequate", "inadequate"]);
  });

  it("groups campaigns under their campaign group and judges a mixed group as unknown", async () => {
    campaigns.set("24", { id: "24", objective: "WEBSITE_CONVERSIONS", group: "5", days: steady({ spend: 12, impressions: 500, clicks: 4, conversions: 1, leads: 0 }), history: { conversions: 3, leads: 0 } });
    campaigns.set("26", { id: "26", objective: "BRAND_AWARENESS", group: "5", days: steady({ spend: 12, impressions: 500, clicks: 4, conversions: 0, leads: 0 }), history: { conversions: 0, leads: 0 } });
    const s = await series();
    expect(new Set(s.rows.map((r) => r.campaign_id))).toEqual(new Set(["5"]));
    expect(s.rows.find((r) => r.ad_set_id === "24")).toMatchObject({ judged_on: "conversions", spend: 12, spend_usd: 12, ctr_percent: 0.8, cpc: 3, cpm: 24, conversions: 1, website_conversions: 1, leads: 0, purchases: 0, sign_ups: 0 });
    expect(s.rows.find((r) => r.ad_set_id === "26")?.judged_on).toBe("reach_and_clicks");
  });
});
