import { describe, expect, it } from "vitest";
import { aggregateWindow, buildBriefs, META_BRIEF_THRESHOLDS, windowConfidence, type BriefDailyRow, type BriefThresholds } from "../brief";

const ASOF = new Date("2026-10-30T12:00:00Z");

function row(date: string, o: Partial<BriefDailyRow>): BriefDailyRow {
  return {
    date,
    campaign_id: "g1",
    campaign_name: "Group",
    ad_set_id: "c1",
    ad_set_name: "Ad set",
    spend_usd: 0,
    impressions: 0,
    clicks: 0,
    ctr_percent: 0,
    cpm_usd: 0,
    conversions: 0,
    purchases: 0,
    sign_ups: 0,
    leads: 0,
    purchase_value_usd: 0,
    judged_on: "conversions",
    ...o,
  };
}

function month(shape: Partial<BriefDailyRow>): BriefDailyRow[] {
  return Array.from({ length: 30 }, (_, i) => row(`2026-10-${String(i + 1).padStart(2, "0")}`, shape));
}

const LEAD_GEN: BriefThresholds = { min_clicks: 21, min_spend_usd: 70, min_results_for_call: 10, results: "conversions" };

describe("brief thresholds are parameters, not Meta's constants", () => {
  it("defaults keep Meta's floors so Meta briefs do not move", () => {
    expect(META_BRIEF_THRESHOLDS).toEqual({ min_clicks: 30, min_spend_usd: 50, min_results_for_call: 10, results: "purchases" });
    const a = aggregateWindow(month({ spend_usd: 10, clicks: 4, impressions: 400 }).slice(0, 7));
    expect(windowConfidence(a)).toBe("inadequate");
  });

  it("must catch: a settled week of 25 clicks and 80 dollars is readable under LinkedIn's floors and unreadable under Meta's", () => {
    const rows = month({ spend_usd: 80 / 7, clicks: 25 / 7, impressions: 500, conversions: 2 / 7, leads: 2 / 7 });
    const [meta] = buildBriefs(rows, ASOF);
    const [li] = buildBriefs(rows, ASOF, undefined, LEAD_GEN);
    expect(meta.confidence).toBe("inadequate");
    expect(meta.posture).toBe("NO_DECISION");
    expect(li.confidence).not.toBe("inadequate");
    expect(li.posture).not.toBe("NO_DECISION");
  });

  it("must catch: with results judged on conversions, a lead-gen line with leads and no purchases is converting, never a cut candidate", () => {
    const rows = month({ spend_usd: 20, clicks: 15, impressions: 1500, conversions: 3, leads: 3, purchases: 0 });
    const [li] = buildBriefs(rows, ASOF, undefined, LEAD_GEN);
    expect(li.funnel_label).toBe("converting_healthy");
    expect(li.posture).not.toBe("CUT_CANDIDATE");
    const [meta] = buildBriefs(rows, ASOF);
    expect(meta.funnel_label).toBe("underperforming_settled");
  });

  it("the engine alone never cuts a line for zero results: spend, clicks and nothing back is click_no_convert, a funnel to investigate", () => {
    const [li] = buildBriefs(month({ spend_usd: 20, clicks: 15, impressions: 1500, conversions: 0, leads: 0 }), ASOF, undefined, LEAD_GEN);
    expect(li.funnel_label).toBe("click_no_convert");
    expect(li.posture).toBe("INVESTIGATE_FUNNEL");
  });

  it("the thin-sample note names the result the line is judged on", () => {
    const [li] = buildBriefs(month({ spend_usd: 20, clicks: 15, impressions: 1500, conversions: 1, leads: 1 }), ASOF, undefined, LEAD_GEN);
    expect(li.confidence).toBe("thin");
    expect(li.notes.join(" ")).toMatch(/7 settled conversions < 10/);
  });

  it("a null metric does not count as a number when the window is summed", () => {
    const a = aggregateWindow([row("2026-10-01", { clicks: 5, conversions: null }), row("2026-10-02", { clicks: null, conversions: 2 })]);
    expect(a).toMatchObject({ clicks: 5, conversions: 2, days: 2 });
  });
});
