
import { describe, it, expect } from "vitest";
import {
  buildTotals,
  totalsBytes,
  TOTALS_BYTE_BUDGET,
} from "@/services/tools/_shared/totals";

const SPEC = {
  sum: ["spend_usd", "purchase_value_usd", "conversions", "clicks", "impressions"] as const,
  ratios: {
    roas: ["purchase_value_usd", "spend_usd"] as const,
    cpa_usd: ["spend_usd", "conversions"] as const,
    ctr_percent: ["clicks", "impressions"] as const,
  },
  scope: "test",
  complete: true,
};

describe("buildTotals", () => {
  it("recomputes ratios from summed components — never averages per-row ratios", () => {
    const rows = [
      { spend_usd: 900, purchase_value_usd: 1800, conversions: 90, clicks: 0, impressions: 0, roas: 2 },
      { spend_usd: 100, purchase_value_usd: 0, conversions: 10, clicks: 0, impressions: 0, roas: 0 },
    ];
    const t = buildTotals(rows, SPEC);
    expect(t.roas).toBe(1.8);
    expect(t.roas).not.toBe(1);
    expect(t.spend_usd).toBe(1000);
    expect(t.cpa_usd).toBe(10);
  });

  it("returns null (not Infinity, not 0) when a denominator is zero", () => {
    const rows = [{ spend_usd: 0, purchase_value_usd: 0, conversions: 0, clicks: 0, impressions: 0 }];
    const t = buildTotals(rows, SPEC);
    expect(t.roas).toBeNull();
    expect(t.cpa_usd).toBeNull();
    expect(t.ctr_percent).toBeNull();
  });

  it("counts entities and tolerates missing / non-numeric fields", () => {
    const rows = [{ spend_usd: 10 }, { spend_usd: "not a number" }, null, { }];
    const t = buildTotals(rows, SPEC);
    expect(t.entities).toBe(4);
    expect(t.spend_usd).toBe(10);
  });

  it("carries the incomplete-source note so a PAGE total is never read as an ACCOUNT total", () => {
    const t = buildTotals([{ spend_usd: 5 }], {
      ...SPEC,
      complete: false,
      note: "One API page only (limit 200); more campaigns exist.",
    });
    expect(t.complete).toBe(false);
    expect(String(t.note)).toContain("page");
  });

  it("stays under the 512-byte sibling budget for a realistic wide block", () => {
    const t = buildTotals([{ spend_usd: 1083.6 }], {
      sum: [
        "spend_usd", "impressions", "clicks", "conversions",
        "purchases", "leads", "purchase_value_usd",
      ],
      ratios: {
        roas: ["purchase_value_usd", "spend_usd"],
        cpa_usd: ["spend_usd", "conversions"],
        cost_per_booking_usd: ["spend_usd", "purchases"],
        ctr_percent: ["clicks", "impressions"],
      },
      scope: "21 campaigns · status=ALL · 2026-08-31..2026-09-07",
      complete: false,
      note: "One API page only (limit 200); more campaigns exist. These are PAGE totals, not account totals.",
    });
    expect(totalsBytes(t)).toBeLessThanOrEqual(TOTALS_BYTE_BUDGET);
  });
});
