import { describe, it, expect } from "vitest";
import { anchorFor, cashShare, commissionEntries, monthIndex, rateForMonth } from "../commission";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const run = (lines: Parameters<typeof commissionEntries>[0]["lines"], anchor = d("2026-01-31"), share = 1) =>
  commissionEntries({ invoiceId: "in_1", lines, anchor, share, livemode: true, paidAt: d("2026-02-01") });
const sum = (e: { amount_cents: number }[]) => e.reduce((s, x) => s + x.amount_cents, 0);

describe("affiliate commission math", () => {
  it("numbers months robustly across short and long months", () => {
    expect(monthIndex(d("2026-01-31"), d("2026-01-31"))).toBe(1);
    expect(monthIndex(d("2026-01-31"), d("2026-02-28"))).toBe(2);
    expect(monthIndex(d("2026-01-31"), d("2026-03-31"))).toBe(3);
    expect(monthIndex(d("2026-01-31"), d("2027-01-31"))).toBe(13);
  });
  it("months 1-2 at 100%, 3-12 at 30%, then nothing", () => {
    expect([1, 2, 3, 12, 13, 0].map(rateForMonth)).toEqual([1, 1, 0.3, 0.3, 0, 0]);
  });
  it("monthly Starter ($20): $20, $20, then $6 a month to month 12, $0 after", () => {
    const at = (m: number) => sum(run([{ id: "li", amountCents: 2000, proration: false, periodStart: new Date(d("2026-01-31").getTime() + (m - 1) * 30.4375 * 86400000), months: 1 }]));
    expect([1, 2, 3, 12, 13].map(at)).toEqual([2000, 2000, 600, 600, 0]);
  });
  it("a six-month prepay as the first payment = 2 months at 100% + 4 at 30%", () => {
    const e = run([{ id: "li", amountCents: 60000, proration: false, periodStart: d("2026-01-31"), months: 6 }]);
    expect(e.map((x) => [x.month_index, x.rate])).toEqual([[1, 1], [2, 1], [3, 0.3], [4, 0.3], [5, 0.3], [6, 0.3]]);
    expect(sum(e)).toBe(10000 * 2 + 3000 * 4);
  });
  it("a six-month renewal at month 7 earns 30% for months 7-12 only", () => {
    const e = run([{ id: "li", amountCents: 60000, proration: false, periodStart: d("2026-07-31"), months: 6 }]);
    expect(e.map((x) => x.month_index)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(sum(e)).toBe(3000 * 6);
    const late = run([{ id: "li", amountCents: 60000, proration: false, periodStart: d("2027-01-31"), months: 6 }]);
    expect(late).toEqual([]);
  });
  it("a proration line earns 30% inside months 1-12 and never a 100% month", () => {
    const e = run([{ id: "pr", amountCents: 10000, proration: true, periodStart: d("2026-02-10"), months: 1 }]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ rate: 0.3, amount_cents: 3000, source_key: "in_1:pr:p" });
    expect(run([{ id: "pr", amountCents: 10000, proration: true, periodStart: d("2027-03-01"), months: 1 }])).toEqual([]);
    expect(run([{ id: "cr", amountCents: -5000, proration: true, periodStart: d("2026-02-10"), months: 1 }])).toEqual([]);
  });
  it("tax is excluded and customer balance scales the base down", () => {
    expect(cashShare({ amountPaidCents: 2200, totalCents: 2200, taxCents: 200 }, 2000)).toBeCloseTo(1, 6);
    expect(cashShare({ amountPaidCents: 1100, totalCents: 2200, taxCents: 200 }, 2000)).toBeCloseTo(0.5, 6);
    expect(cashShare({ amountPaidCents: 0, totalCents: 2200, taxCents: 200 }, 2000)).toBe(0);
    expect(sum(run([{ id: "li", amountCents: 2000, proration: false, periodStart: d("2026-01-31"), months: 1 }], d("2026-01-31"), 0.5))).toBe(1000);
  });
  it("the anchor is the earliest plan line, matures 30 days after payment, keys are stable", () => {
    expect(anchorFor([
      { id: "pr", amountCents: 500, proration: true, periodStart: d("2026-01-01"), months: 1 },
      { id: "li", amountCents: 2000, proration: false, periodStart: d("2026-01-15"), months: 1 },
    ])?.toISOString()).toBe(d("2026-01-15").toISOString());
    const e = run([{ id: "li", amountCents: 2000, proration: false, periodStart: d("2026-01-31"), months: 1 }]);
    expect(e[0].matures_at).toBe(d("2026-03-03").toISOString());
    expect(e[0].source_key).toBe("in_1:li:1");
  });
});
