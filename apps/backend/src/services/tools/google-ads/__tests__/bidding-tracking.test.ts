
import { beforeEach, describe, expect, it, vi } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({
  gadsSearch: (...a: unknown[]) => gadsSearch(...a),
  createGoogleAdsReadSession: (tenant: string) => (query: string) => gadsSearch(tenant, query),
}));

import { conversionTrackingHealthTool } from "../conversion_tracking_health";
import { judgeAction, MIN_CLICKS_FOR_DARK } from "../_bidding-tracking";
import { loadTracking } from "@/services/growth/unattended-policy";

const NOW = new Date("2026-10-11T12:00:00Z");
const BOOKED = "customers/7/conversionActions/501";
const VISIT = "customers/7/conversionActions/502";
const CAMPAIGN = "customers/7/campaigns/9001";

type Account = {
  bookedConversions14d: number;
  visitConversions: number;
  clicks: number;
  upload?: Record<string, unknown> | Record<string, unknown>[] | "fail";
  campaignStatus?: string;
  convCapped?: boolean;
};

function account(a: Account) {
  gadsSearch.mockImplementation(async (_t: string, q: string) => {
    if (q.includes("FROM conversion_action"))
      return [
        { conversionAction: { id: "501", resourceName: BOOKED, name: "Booked job (upload)", status: "ENABLED", primaryForGoal: true, category: "PURCHASE", origin: "WEBSITE", type: "UPLOAD_CLICKS" } },
        { conversionAction: { id: "502", resourceName: VISIT, name: "Quote page view", status: "ENABLED", primaryForGoal: false, category: "PAGE_VIEW", origin: "WEBSITE" } },
      ];
    if (q.includes("FROM customer ") && q.includes("LAST_14_DAYS") && a.convCapped)
      return Array.from({ length: 10000 }, (_, i) => ({ segments: { conversionAction: `customers/7/conversionActions/${900000 + i}` }, metrics: { allConversions: 0 } }));
    if (q.includes("FROM customer "))
      return [
        { segments: { conversionAction: BOOKED }, metrics: { conversions: a.bookedConversions14d, allConversions: a.bookedConversions14d } },
        { segments: { conversionAction: VISIT }, metrics: { conversions: 0, allConversions: a.visitConversions } },
      ];
    if (q.includes("FROM campaign_conversion_goal"))
      return [
        { campaign: { name: "Cleaning, metro search", status: a.campaignStatus ?? "ENABLED" }, campaignConversionGoal: { campaign: CAMPAIGN, category: "PURCHASE", origin: "WEBSITE", biddable: true } },
        { campaign: { name: "Cleaning, metro search", status: a.campaignStatus ?? "ENABLED" }, campaignConversionGoal: { campaign: CAMPAIGN, category: "PAGE_VIEW", origin: "WEBSITE", biddable: false } },
      ];
    if (q.includes("FROM conversion_goal_campaign_config")) return [{ campaign: { name: "Cleaning, metro search", status: a.campaignStatus ?? "ENABLED" }, conversionGoalCampaignConfig: { campaign: CAMPAIGN, goalConfigLevel: "CUSTOMER" } }];
    if (q.includes("FROM campaign ")) return [{ campaign: { resourceName: CAMPAIGN }, metrics: { clicks: a.clicks } }];
    if (q.includes("FROM offline_conversion_upload_conversion_action_summary")) {
      if (a.upload === "fail") throw new Error("Google Ads read failed: 400 unrecognized resource");
      const rows = Array.isArray(a.upload) ? a.upload : a.upload ? [a.upload] : [];
      return rows.map((u) => ({ offlineConversionUploadConversionActionSummary: { conversionActionId: "501", ...u } }));
    }
    throw new Error(`unexpected query ${q}`);
  });
}

type Out = { overall_status: string; suggestion: string; tracking_verdict: { status: string; reason: string | null; since: string | null; since_is_lower_bound: boolean } | null; bidding_tracking: { verdict: string; note: string | null; actions: Array<{ name: string; verdict: string; why: string }> } };
const run = async () => (await conversionTrackingHealthTool.execute({ tenant_id: "t-1", log: () => {} }, {})) as Out;

beforeEach(() => {
  gadsSearch.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

describe("must catch: the action Google bids on is dark while another action keeps the account 'healthy'", () => {
  it("cleaning service: booked-job uploads stopped, page views still count -> broken, overall_status unchanged", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200, upload: { status: "NO_RECENT_UPLOAD", lastUploadDateTime: "2026-09-02 10:00:00", successfulEventCount: 0, totalEventCount: 0, dailySummaries: [] } });
    const r = await run();
    expect(r.overall_status).toBe("healthy");
    expect(r.bidding_tracking.verdict).toBe("broken");
    expect(r.bidding_tracking.actions).toEqual([expect.objectContaining({ name: "Booked job (upload)", verdict: "dark" })]);
    expect(r.bidding_tracking.note).toMatch(/Google is bidding blind/);
    expect(r.bidding_tracking.note).toMatch(/2026-09-02/);
    expect(r.bidding_tracking.note).toMatch(/changes no spend/);
    expect(r.suggestion.startsWith("Google is bidding blind")).toBe(true);
    expect(r.tracking_verdict).toEqual({ status: "broken", reason: r.bidding_tracking.note, since: "2026-09-02", since_is_lower_bound: false });
  });

  it("loadTracking (what the spend controller reads) still says ok: the verdict never moves money", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200, upload: { status: "NO_RECENT_UPLOAD", successfulEventCount: 0, totalEventCount: 0 } });
    expect(await loadTracking("t-1", "google")).toEqual({ ok: true, firedEvents: null });
  });

  it("no upload ever seen: broken since at least the start of the window", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200 });
    expect((await run()).tracking_verdict).toMatchObject({ status: "broken", since: "2026-09-27", since_is_lower_bound: true });
  });

  it("uploads reach Google but most are rejected -> broken, naming Google's alert", async () => {
    account({
      bookedConversions14d: 3, visitConversions: 50, clicks: 900,
      upload: { status: "NEEDS_ATTENTION", successfulEventCount: 3, totalEventCount: 40, lastUploadDateTime: "2026-10-10 08:00:00", alerts: [{ error: { conversionUploadError: "EXPIRED_EVENT" }, errorPercentage: 0.9 }] },
    });
    const r = await run();
    expect(r.bidding_tracking.verdict).toBe("broken");
    expect(r.bidding_tracking.actions[0]).toMatchObject({ verdict: "uploads_failing", why: expect.stringMatching(/3 of 40 processed upload events accepted in 7 days \(EXPIRED_EVENT\)/) });
    expect(r.bidding_tracking.note).toMatch(/^Part of what Google bids on is not recording/);
  });

  it("a rejecting client is not hidden by a healthy client on the same action (rows are merged)", async () => {
    account({
      bookedConversions14d: 0, visitConversions: 50, clicks: 900,
      upload: [
        { client: "GOOGLE_ADS_API", status: "NEEDS_ATTENTION", successfulEventCount: 2, totalEventCount: 100, lastUploadDateTime: "2026-10-10 08:00:00" },
        { client: "GOOGLE_ADS_WEB_CLIENT", status: "EXCELLENT", successfulEventCount: 3, totalEventCount: 3, lastUploadDateTime: "2026-10-09 08:00:00" },
      ],
    });
    const r = await run();
    expect(r.bidding_tracking.actions[0]).toMatchObject({ verdict: "uploads_failing", why: expect.stringMatching(/5 of 103 processed/) });
  });
});

describe("must not catch", () => {
  it("uploads started recently: zero conversions yet, accepted uploads this week -> warming_up, not broken", async () => {
    account({
      bookedConversions14d: 0, visitConversions: 120, clicks: 800,
      upload: { status: "GOOD", successfulEventCount: 12, totalEventCount: 12, lastUploadDateTime: "2026-10-10 18:00:00", dailySummaries: [{ uploadDate: "2026-10-09", successfulCount: 5 }, { uploadDate: "2026-10-10", successfulCount: 7 }] },
    });
    const r = await run();
    expect(r.bidding_tracking.verdict).toBe("warming_up");
    expect(r.tracking_verdict?.status).toBe("warming_up");
    expect(r.bidding_tracking.note).toMatch(/started recently/);
  });

  it("pending events are not failures: 10 accepted, 90 still processing -> warming_up", async () => {
    account({ bookedConversions14d: 0, visitConversions: 60, clicks: 700, upload: { status: "GOOD", successfulEventCount: 10, pendingEventCount: 90, totalEventCount: 100, lastUploadDateTime: "2026-10-11 06:00:00" } });
    expect((await run()).bidding_tracking.verdict).toBe("warming_up");
  });

  it("a fresh upload still entirely pending -> warming_up, not dark", async () => {
    account({ bookedConversions14d: 0, visitConversions: 60, clicks: 700, upload: { status: "GOOD", successfulEventCount: 0, pendingEventCount: 25, totalEventCount: 25, lastUploadDateTime: "2026-10-10 22:00:00" } });
    expect((await run()).bidding_tracking.verdict).toBe("warming_up");
  });

  it("a stale bad upload day (no daily summaries, last upload weeks ago) does not override 14-day conversions", async () => {
    account({ bookedConversions14d: 30, visitConversions: 60, clicks: 700, upload: { status: "NEEDS_ATTENTION", successfulEventCount: 1, totalEventCount: 50, lastUploadDateTime: "2026-08-20 10:00:00" } });
    expect((await run()).bidding_tracking.verdict).toBe("ok");
  });

  it("a stale client row (no daily summaries, old upload) is not merged into a fresh client's counts", async () => {
    account({
      bookedConversions14d: 30, visitConversions: 60, clicks: 700,
      upload: [
        { client: "GOOGLE_ADS_API", status: "EXCELLENT", lastUploadDateTime: "2026-10-10 08:00:00", dailySummaries: [{ uploadDate: "2026-10-10", successfulCount: 10, failedCount: 0, pendingCount: 0 }] },
        { client: "GOOGLE_ADS_WEB_CLIENT", status: "NEEDS_ATTENTION", successfulEventCount: 1, totalEventCount: 50, lastUploadDateTime: "2026-08-20 10:00:00" },
      ],
    });
    expect((await run()).bidding_tracking.verdict).toBe("ok");
  });

  it("Google's UNKNOWN campaign status leaves the goal map incomplete", async () => {
    account({ bookedConversions14d: 30, visitConversions: 60, clicks: 700, campaignStatus: "UNKNOWN" });
    expect((await run()).bidding_tracking.verdict).toBe("unknown");
  });

  it("a campaign with an unknown status leaves the goal map incomplete: never ok", async () => {
    account({ bookedConversions14d: 30, visitConversions: 60, clicks: 700, campaignStatus: "" });
    expect((await run()).bidding_tracking.verdict).toBe("unknown");
  });

  it("the upload summary read failed and conversions are zero -> unknown, never broken", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200, upload: "fail" });
    expect((await run()).tracking_verdict).toMatchObject({ status: "unknown", reason: expect.stringMatching(/upload summary could not be read/) });
  });

  it("a manager-owned action with no upload row here is unknown (its uploads are summarised on the manager), with the reason", async () => {
    const MGR = "customers/3/conversionActions/501";
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200 });
    const base = gadsSearch.getMockImplementation()!;
    gadsSearch.mockImplementation(async (t: string, q: string) => {
      const rows = (await base(t, q)) as unknown;
      return JSON.parse(JSON.stringify(rows).split(BOOKED).join(MGR));
    });
    const r = await run();
    expect(r.tracking_verdict).toMatchObject({ status: "unknown", reason: expect.stringMatching(/belongs to another Google Ads account/) });
  });

  it("a manager-owned TAG action (not an upload) that is dark is still broken", async () => {
    const MGR = "customers/3/conversionActions/501";
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200 });
    const base = gadsSearch.getMockImplementation()!;
    gadsSearch.mockImplementation(async (t: string, q: string) => {
      const rows = JSON.parse(JSON.stringify((await base(t, q)) as unknown).split(BOOKED).join(MGR).split('"UPLOAD_CLICKS"').join('"WEBPAGE"'));
      return rows;
    });
    expect((await run()).tracking_verdict?.status).toBe("broken");
  });

  it("a manager-owned upload action with too few clicks is ok, not unknown", async () => {
    const MGR = "customers/3/conversionActions/501";
    account({ bookedConversions14d: 0, visitConversions: 4, clicks: 20 });
    const base = gadsSearch.getMockImplementation()!;
    gadsSearch.mockImplementation(async (t: string, q: string) => JSON.parse(JSON.stringify((await base(t, q)) as unknown).split(BOOKED).join(MGR)));
    expect((await run()).bidding_tracking.verdict).toBe("ok");
  });

  it("a current NEEDS_ATTENTION row with no counts still marks the uploads failing", async () => {
    account({ bookedConversions14d: 9, visitConversions: 60, clicks: 700, upload: { status: "NEEDS_ATTENTION", lastUploadDateTime: "2026-10-10 08:00:00" } });
    expect((await run()).bidding_tracking.actions[0]).toMatchObject({ verdict: "uploads_failing" });
  });

  it("a paused campaign does not bid: its dark action is not judged", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200, campaignStatus: "PAUSED" });
    expect((await run()).bidding_tracking.verdict).toBe("no_bidding_action");
  });

  it("a capped conversion read: a partial zero is unknown, never dark", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200, convCapped: true });
    expect((await run()).bidding_tracking.verdict).toBe("unknown");
  });

  it("SaaS: the bid-on trial signup records -> ok, no note", async () => {
    account({ bookedConversions14d: 41, visitConversions: 900, clicks: 3000 });
    const r = await run();
    expect(r.bidding_tracking).toMatchObject({ verdict: "ok", note: null });
    expect(r.suggestion).not.toMatch(/bidding blind/);
  });

  it("too few clicks to tell: zero conversions on a small campaign is not 'broken'", async () => {
    account({ bookedConversions14d: 0, visitConversions: 4, clicks: MIN_CLICKS_FOR_DARK - 1 });
    expect((await run()).bidding_tracking.verdict).toBe("ok");
  });

  it("the upload summary cannot be read: judged on conversions alone, never broken because of the failed read", async () => {
    account({ bookedConversions14d: 9, visitConversions: 40, clicks: 600, upload: "fail" });
    const r = await run();
    expect(r.bidding_tracking).toMatchObject({ verdict: "ok", upload_summary_read: "failed" });
  });

  it("scoped to one campaign: no account-wide bidding verdict", async () => {
    account({ bookedConversions14d: 0, visitConversions: 340, clicks: 1200 });
    const r = (await conversionTrackingHealthTool.execute({ tenant_id: "t-1", log: () => {} }, { campaign_id: "9001" })) as Out;
    expect(r.bidding_tracking).toBeNull();
  });
});

describe("judgeBiddingTracking", () => {
  it("an unresolved campaign goal map is never 'ok' or 'no_bidding_action'", async () => {
    const { judgeBiddingTracking } = await import("../_bidding-tracking");
    expect(judgeBiddingTracking([], false, "ok", NOW).verdict).toBe("unknown");
    const recording = { resource_name: BOOKED, name: "x", campaigns: [], conversions_14d: 5, campaign_clicks_14d: 500, upload: null, verdict: "recording" as const, why: "" };
    expect(judgeBiddingTracking([recording], false, "ok", NOW).verdict).toBe("unknown");
    expect(judgeBiddingTracking([recording], true, "ok", NOW).verdict).toBe("ok");
  });
});

describe("judgeAction", () => {
  const base = { resource_name: BOOKED, name: "x", campaigns: [], upload: null };
  it("unreadable conversions are unknown, never dark", () => {
    expect(judgeAction({ ...base, conversions_14d: null, campaign_clicks_14d: 5000 }, NOW).verdict).toBe("unknown");
  });
  it("unreadable clicks with zero conversions are unknown, never dark", () => {
    expect(judgeAction({ ...base, conversions_14d: 0, campaign_clicks_14d: null }, NOW).verdict).toBe("unknown");
  });
});
