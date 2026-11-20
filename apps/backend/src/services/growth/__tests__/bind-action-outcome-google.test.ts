
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/growth/action-outcomes", async (orig) => {
  const actual = await orig<typeof import("@/services/growth/action-outcomes")>();
  return {
    targetKindForClass: actual.targetKindForClass,
    recordActionOutcome: vi.fn(),
    enrichBaseline: vi.fn(),
    readMetaSnapshot: vi.fn(),
    readGoogleSnapshot: vi.fn(),
  };
});

import { bindActionOutcome } from "../bind-action-outcome";
import {
  recordActionOutcome,
  enrichBaseline,
  readMetaSnapshot,
  readGoogleSnapshot,
  targetKindForClass,
} from "@/services/growth/action-outcomes";

const record = vi.mocked(recordActionOutcome);
const enrich = vi.mocked(enrichBaseline);
const metaRead = vi.mocked(readMetaSnapshot);
const googleRead = vi.mocked(readGoogleSnapshot);

const DEC = "11111111-1111-1111-1111-111111111111";
const TEN = "22222222-2222-2222-2222-222222222222";

const SNAP = {
  spend: 120.5,
  roas: 2.1,
  conversions: 9,
  purchase_value: 253.05,
  impressions: 4200,
};

const budgetBody = {
  campaign_id: "987654321",
  daily_budget_usd: 80,
  expected_current_daily_budget_usd: 60,
  rationale: "scale the winner",
  over_cap: false,
};

const statusBody = {
  campaign_id: "123456789",
  status: "PAUSED" as const,
  rationale: "cpa 2x account average",
  over_cap: false,
};

const bind = (
  decisionClass: string,
  body: unknown,
  decisionOutcome: "approved" | "rejected" = "approved",
) =>
  bindActionOutcome({ decisionId: DEC, tenantId: TEN, decisionClass, decisionOutcome, body });

beforeEach(() => {
  vi.clearAllMocks();
  record.mockResolvedValue(77);
  googleRead.mockResolvedValue(SNAP);
  metaRead.mockResolvedValue(SNAP);
});

describe("bindActionOutcome — google_ads business tier", () => {
  it("binds a campaign budget change to a campaign subject on the 14-day window", async () => {
    await bind("google_ads.update_campaign_budget", budgetBody);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      actionClass: "google_ads.update_campaign_budget",
      decisionOutcome: "approved",
      subjectType: "campaign",
      subjectId: "987654321",
      targetMetric: "spend",
      measurementWindowDays: 14,
      outcomeTier: "business",
    });
  });

  it("binds a status change, and reads its baseline from GOOGLE not Meta", async () => {
    await bind("google_ads.set_status", statusBody);

    expect(record.mock.calls[0][0]).toMatchObject({
      actionClass: "google_ads.set_status",
      subjectType: "campaign",
      subjectId: "123456789",
    });
    expect(googleRead).toHaveBeenCalledTimes(1);
    expect(googleRead.mock.calls[0][0]).toBe(TEN);
    expect(googleRead.mock.calls[0][1]).toBe("123456789");
    expect(metaRead).not.toHaveBeenCalled();
    expect(enrich).toHaveBeenCalledWith({
      id: 77,
      status: "enriched",
      baselineMetrics: SNAP,
    });
  });

  it("strips the _auto / _review autonomy suffix before matching", async () => {
    await bind("google_ads.update_campaign_budget_review", budgetBody);
    await bind("google_ads.set_status_auto", statusBody);

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0][0]).toMatchObject({
      actionClass: "google_ads.update_campaign_budget",
    });
    expect(record.mock.calls[1][0]).toMatchObject({ actionClass: "google_ads.set_status" });
  });

  it("keeps a REJECTED business-tier binding (what happened after you said no)", async () => {
    await bind("google_ads.set_status", statusBody, "rejected");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ decisionOutcome: "rejected" });
  });

  it("fails closed on a malformed body instead of guessing a subject", async () => {
    await bind("google_ads.set_status", { campaign_id: "", status: "PAUSED", over_cap: false });
    await bind("google_ads.update_campaign_budget", { campaign_id: "1", over_cap: false });

    expect(record).not.toHaveBeenCalled();
    expect(googleRead).not.toHaveBeenCalled();
  });

  it("stamps baseline no_data when Google reports no rows, never a fabricated $0", async () => {
    googleRead.mockResolvedValue(null);
    await bind("google_ads.set_status", statusBody);
    expect(enrich).toHaveBeenCalledWith({ id: 77, status: "no_data" });
  });

  it("does NOT regress Meta: a meta class still reads the Meta snapshot", async () => {
    await bind("meta_ads.set_status", {
      level: "campaign",
      object_id: "555",
      status: "PAUSED",
      over_cap: false,
    });
    expect(metaRead).toHaveBeenCalledTimes(1);
    expect(googleRead).not.toHaveBeenCalled();
  });
});

describe("reader parity between bind and reconcile", () => {
  const cases: Array<[string, "google_object" | "meta_object"]> = [
    ["google_ads.set_status", "google_object"],
    ["google_ads.update_campaign_budget", "google_object"],
    ["google_ads.set_status_review", "google_object"],
    ["meta_ads.set_status", "meta_object"],
    ["meta_ads.update_ad_set_budget", "meta_object"],
  ];

  it.each(cases)("%s resolves to %s on the reconcile side", (cls, expected) => {
    expect(targetKindForClass(cls)).toBe(expected);
  });

  it("defaults an unknown or legacy class to Meta so no existing row changes behavior", () => {
    expect(targetKindForClass("engineer.ship-pr")).toBe("meta_object");
    expect(targetKindForClass(null)).toBe("meta_object");
    expect(targetKindForClass(undefined)).toBe("meta_object");
  });

  it.each(cases)("%s picks the SAME platform on the bind side", async (cls, expected) => {
    vi.clearAllMocks();
    record.mockResolvedValue(77);
    googleRead.mockResolvedValue(SNAP);
    metaRead.mockResolvedValue(SNAP);

    const body = cls.startsWith("google_ads.")
      ? cls.includes("budget")
        ? budgetBody
        : statusBody
      : cls.includes("budget")
        ? { ad_set_id: "555", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, over_cap: false }
        : { level: "campaign", object_id: "555", status: "PAUSED", over_cap: false };

    await bind(cls, body);

    if (expected === "google_object") {
      expect(googleRead).toHaveBeenCalledTimes(1);
      expect(metaRead).not.toHaveBeenCalled();
    } else {
      expect(metaRead).toHaveBeenCalledTimes(1);
      expect(googleRead).not.toHaveBeenCalled();
    }
  });
});
