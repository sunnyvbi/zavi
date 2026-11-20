import { describe, it, expect } from "vitest";
import { smartTruncateToolResult } from "@/services/agents/smart-truncate";
import { buildWaste } from "../waste";
import { buildTotals } from "../totals";

const CAP = 16 * 1024;

const wideRows = () =>
  Array.from({ length: 400 }, (_, i) => ({
    ad_id: `1202594688141${String(i).padStart(5, "0")}`,
    ad_name: `Instagram post: 40% to Turo. 0% to us. Same car, same street, variant ${i}`,
    spend_usd: 1000 - i,
    impressions: 100000 + i,
    clicks: 900 - i,
    conversions: i < 380 ? 0 : 3,
    leads: 0,
    purchase_value_usd: i < 380 ? 0 : 120,
  }));

describe("the waste block survives the real truncator", () => {
  const rows = wideRows();
  const payload = {
    window: "2026-08-19..2026-09-18",
    waste: buildWaste(rows, {
      labelFields: ["ad_name"],
      spendField: "spend_usd",
      conversionFields: ["conversions", "leads"],
      outcomeLabel: "sales, signups or leads",
      window: "2026-08-19..2026-09-18",
      currency: "USD",
      entity: "ads",
      complete: true,
    }),
    totals: buildTotals(rows, {
      sum: ["spend_usd", "impressions", "clicks", "conversions"],
      scope: `${rows.length} ads`,
      complete: true,
    }),
    ads: rows,
  };
  const raw = JSON.stringify(payload);
  const out = smartTruncateToolResult(raw, CAP);

  it("is actually truncating, or this test proves nothing", () => {
    expect(Buffer.byteLength(raw, "utf-8")).toBeGreaterThan(CAP * 2);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(CAP);
  });

  it("keeps the waste block after truncation", () => {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.waste, "waste sibling was dropped — the whole change is inert").toBeDefined();
  });

  it("keeps the biggest wasted line, and its money, through truncation", () => {
    const parsed = JSON.parse(out) as { waste: { lines: { label: string; spend: number }[]; spend_total: number } };
    expect(parsed.waste.lines[0].spend).toBe(1000);
    expect(parsed.waste.lines[0].label).toContain("Instagram post");
    expect(parsed.waste.spend_total).toBe(307990);
  });

  it("does not starve the totals sibling it travels with", () => {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.totals, "adding waste must not push totals out").toBeDefined();
  });

  it("adds only — every pre-existing key still present after truncation", () => {
    const before = JSON.parse(smartTruncateToolResult(JSON.stringify({ ...payload, waste: undefined }), CAP)) as Record<string, unknown>;
    const after = JSON.parse(out) as Record<string, unknown>;
    for (const k of Object.keys(before)) {
      expect(after[k], `key ${k} disappeared once waste was added`).toBeDefined();
    }
  });
});
