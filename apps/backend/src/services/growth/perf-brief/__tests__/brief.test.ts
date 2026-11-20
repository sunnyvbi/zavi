
import { describe, it, expect } from "vitest";
import {
  aggregateWindow,
  splitSettled,
  buildCampaignBrief,
  buildBriefs,
  windowConfidence,
} from "../brief";
import type { MetaDailyRow } from "@/services/tools/meta-ads/daily_series";

const ASOF = new Date("2026-06-28T12:00:00Z");

function row(date: string, o: Partial<MetaDailyRow>): MetaDailyRow {
  return {
    date,
    campaign_id: "c1",
    campaign_name: "New Conversions Campaign",
    ad_set_id: null,
    ad_set_name: null,
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
    ...o,
  };
}

function days(settledShape: Partial<MetaDailyRow>, maturingShape: Partial<MetaDailyRow>) {
  const rows: MetaDailyRow[] = [];
  for (let d = 11; d <= 24; d++) rows.push(row(`2026-06-${String(d).padStart(2, "0")}`, settledShape));
  for (let d = 25; d <= 28; d++) rows.push(row(`2026-06-${String(d).padStart(2, "0")}`, maturingShape));
  return rows;
}

describe("splitSettled", () => {
  it("excludes the maturing tail (last 72h) from judgement", () => {
    const rows = days({ spend_usd: 10 }, { spend_usd: 999 });
    const { settled, maturing, cutoff } = splitSettled(rows, ASOF);
    expect(cutoff).toBe("2026-06-25");
    expect(maturing.map((r) => r.date).sort()).toEqual(["2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28"]);
    expect(settled.every((r) => r.date < "2026-06-25")).toBe(true);
  });
});

describe("aggregateWindow", () => {
  it("sums and derives CTR / signup-CVR / CPA correctly", () => {
    const a = aggregateWindow([
      row("2026-06-11", { spend_usd: 100, impressions: 5000, clicks: 100, sign_ups: 26, purchases: 0 }),
      row("2026-06-12", { spend_usd: 100, impressions: 5000, clicks: 100, sign_ups: 26, purchases: 0 }),
    ]);
    expect(a.spend_usd).toBe(200);
    expect(a.clicks).toBe(200);
    expect(a.ctr_percent).toBe(2);
    expect(a.signup_cvr_percent).toBe(26);
    expect(a.cost_per_signup_usd).toBe(round2(200 / 52));
    expect(a.roas).toBe(0);
  });
});

describe("buildCampaignBrief — the New Conversions Campaign case", () => {
  it("strong signups + a FEW bookings (real 181->1 case, NOT zero) => INVESTIGATE_FUNNEL", () => {
    const rows: MetaDailyRow[] = [];
    for (let d = 11; d <= 24; d++) {
      const date = `2026-06-${String(d).padStart(2, "0")}`;
      const purch = d === 18 ? 2 : 0;
      const pv = d === 18 ? 360 : 0;
      rows.push(row(date, { spend_usd: 200, impressions: 5000, clicks: 100, sign_ups: 26, purchases: purch, purchase_value_usd: pv }));
    }
    for (let d = 25; d <= 28; d++) rows.push(row(`2026-06-${String(d).padStart(2, "0")}`, { spend_usd: 200, clicks: 100, sign_ups: 26 }));
    const b = buildCampaignBrief(rows, ASOF);
    expect(b.settled.sign_ups).toBe(182);
    expect(b.settled.purchases).toBe(2);
    expect(b.settled.purchases / b.settled.sign_ups).toBeLessThan(0.02);
    expect(b.funnel_label).toBe("top_funnel_working_bottleneck_below_click");
    expect(b.posture).toBe("INVESTIGATE_FUNNEL");
    expect(b.posture).not.toBe("CUT_CANDIDATE");
    expect(b.notes.join(" ")).toMatch(/Do NOT cut/i);
  });
});

describe("SCALE requires economics (codex catch)", () => {
  it("converting_healthy but ROAS < 1 => HOLD, not SCALE", () => {
    const rows = days(
      { spend_usd: 200, impressions: 6000, clicks: 120, sign_ups: 8, purchases: 4, purchase_value_usd: 100 },
      { spend_usd: 200, impressions: 6000, clicks: 120, sign_ups: 8, purchases: 4, purchase_value_usd: 100 },
    );
    const b = buildCampaignBrief(rows, ASOF);
    expect(b.funnel_label).toBe("converting_healthy");
    expect(b.settled.roas).toBeLessThan(1);
    expect(b.posture).toBe("HOLD");
  });
});

describe("ad-set rows stay separate (codex catch)", () => {
  it("buildBriefs keys on campaign + ad_set, not just campaign", () => {
    const mk = (asId: string, signups: number): MetaDailyRow[] =>
      Array.from({ length: 8 }, (_, i) =>
        row(`2026-06-${String(11 + i).padStart(2, "0")}`, { ad_set_id: asId, ad_set_name: `Set ${asId}`, spend_usd: 100, impressions: 5000, clicks: 100, sign_ups: signups }),
      );
    const briefs = buildBriefs([...mk("as1", 30), ...mk("as2", 1)], ASOF);
    expect(briefs.length).toBe(2);
    expect(briefs.map((b) => b.ad_set_id).sort()).toEqual(["as1", "as2"]);
  });
});

describe("naive-cut prevention", () => {
  it("inadequate settled volume => NO_DECISION (can't judge a near-dead campaign)", () => {
    const rows = days(
      { spend_usd: 5, impressions: 200, clicks: 3, sign_ups: 0, purchases: 0 },
      { spend_usd: 5, impressions: 200, clicks: 3 },
    );
    const b = buildCampaignBrief(rows, ASOF);
    expect(b.confidence).toBe("inadequate");
    expect(b.posture).toBe("NO_DECISION");
  });

  it("healthy converting + adequate volume => SCALE", () => {
    const rows = days(
      { spend_usd: 200, impressions: 6000, clicks: 120, sign_ups: 8, purchases: 4, purchase_value_usd: 1200 },
      { spend_usd: 200, impressions: 6000, clicks: 120, sign_ups: 8, purchases: 4, purchase_value_usd: 1200 },
    );
    const b = buildCampaignBrief(rows, ASOF);
    expect(b.confidence).toBe("adequate");
    expect(b.funnel_label).toBe("converting_healthy");
    expect(b.posture).toBe("SCALE");
  });

  it("low CTR => weak_creative_low_ctr (investigate, not scale)", () => {
    const rows = days(
      { spend_usd: 200, impressions: 100000, clicks: 120, sign_ups: 0, purchases: 0 },
      { spend_usd: 200, impressions: 100000, clicks: 120 },
    );
    const b = buildCampaignBrief(rows, ASOF);
    expect(b.settled.ctr_percent).toBeLessThan(0.6);
    expect(b.funnel_label).toBe("weak_creative_low_ctr");
    expect(b.posture).toBe("INVESTIGATE_FUNNEL");
  });
});

describe("objective: judged on what the campaign bought", () => {
  it("a reach-and-clicks campaign gets NO_DECISION and a note, never a conversion verdict", () => {
    const shape = { spend_usd: 200, impressions: 60000, clicks: 900, purchases: 0, sign_ups: 0, objective: "OUTCOME_AWARENESS", judged_on: "reach_and_clicks" as const };
    const b = buildCampaignBrief(days(shape, shape), ASOF);
    expect(b.judged_on).toBe("reach_and_clicks");
    expect(b.posture).toBe("NO_DECISION");
    expect(b.notes.join(" ")).toMatch(/reach and clicks/);
    expect(b.notes.join(" ")).toContain("in the account currency");
    expect(b.notes.join(" ")).not.toMatch(/\$\d/);
  });

  it("an unknown objective keeps today's posture", () => {
    const shape = { spend_usd: 200, impressions: 6000, clicks: 120, sign_ups: 8, purchases: 4, purchase_value_usd: 1200 };
    const b = buildCampaignBrief(days(shape, shape), ASOF);
    expect(b.judged_on).toBe("unknown");
    expect(b.posture).toBe("SCALE");
  });
});

describe("windowConfidence floors", () => {
  it("flags thin when purchases < 10 even with spend/clicks ok", () => {
    const a = aggregateWindow([
      row("2026-06-11", { spend_usd: 500, impressions: 20000, clicks: 400, purchases: 3 }),
    ]);
    expect(windowConfidence({ ...a, days: 7 })).toBe("thin");
    expect(windowConfidence({ ...a, days: 7, purchases: 12 })).toBe("adequate");
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
