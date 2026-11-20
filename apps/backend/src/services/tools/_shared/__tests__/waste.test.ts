import { describe, it, expect } from "vitest";
import { buildWaste, wasteBytes } from "../waste";
import { TOTALS_BYTE_BUDGET } from "../totals";
import { GOOGLE_CONVERSION_FIELDS, GOOGLE_SECONDARY_OUTCOME } from "../../google-ads/_shared";

const spec = {
  labelFields: ["text", "campaign_name", "name"],
  spendField: "spend_usd",
  conversionFields: ["conversions"],
  outcomeLabel: "sales or signups",
  window: "LAST_30_DAYS",
  currency: "USD",
  entity: "search terms",
  complete: true,
} as const;

describe("buildWaste", () => {
  it("names the biggest zero-conversion line first", () => {
    const w = buildWaste(
      [
        { text: "cheap car rental", spend_usd: 12.5, conversions: 0 },
        { text: "car rental", spend_usd: 379.4, conversions: 0 },
        { text: "rent a car airport", spend_usd: 88, conversions: 0 },
      ],
      spec,
    );
    expect(w?.lines[0]).toEqual({ label: "car rental", spend: 379.4 });
    expect(w?.lines_total).toBe(3);
    expect(w?.spend_total).toBe(479.9);
  });

  it("never names a row that converted", () => {
    const w = buildWaste(
      [
        { text: "expensive but works", spend_usd: 900, conversions: 1 },
        { text: "dead weight", spend_usd: 10, conversions: 0 },
      ],
      spec,
    );
    expect(w?.lines.map((l) => l.label)).toEqual(["dead weight"]);
    expect(w?.spend_total).toBe(10);
  });

  it("ignores rows that spent nothing", () => {
    expect(buildWaste([{ text: "paused", spend_usd: 0, conversions: 0 }], spec)).toBeUndefined();
  });

  it("returns undefined rather than claiming a clean account", () => {
    expect(buildWaste([], spec)).toBeUndefined();
    expect(buildWaste([{ text: "fine", spend_usd: 5, conversions: 2 }], spec)).toBeUndefined();
  });

  it("counts an unnamed row's money without printing a blank line", () => {
    const w = buildWaste(
      [
        { spend_usd: 500, conversions: 0 },
        { text: "named", spend_usd: 20, conversions: 0 },
      ],
      spec,
    );
    expect(w?.lines.map((l) => l.label)).toEqual(["named"]);
    expect(w?.lines_total).toBe(2);
    expect(w?.spend_total).toBe(520);
  });

  it("strips escaped newline text out of a label, not just real whitespace", () => {
    const w = buildWaste(
      [{ text: String.raw`Instagram post: 40% to Turo.\n\nSame car, same street`, spend_usd: 608.44, conversions: 0 }],
      spec,
    );
    expect(w?.lines[0].label).not.toContain("\\n");
    expect(w?.lines[0].label).toBe("Instagram post: 40% to Turo. Same car, same stre");
    expect(w?.lines[0].label.length).toBeLessThanOrEqual(48);
  });

  it("does not call a lead-gen row waste when leads is the outcome", () => {
    const metaSpec = {
      ...spec,
      conversionFields: ["conversions", "leads"],
      outcomeLabel: "sales, signups or leads",
    } as const;
    const rows = [
      { text: "Lead campaign", spend_usd: 200, conversions: 0, leads: 50 },
      { text: "Actually dead", spend_usd: 80, conversions: 0, leads: 0 },
    ];
    const w = buildWaste(rows, metaSpec);
    expect(w?.lines.map((l) => l.label)).toEqual(["Actually dead"]);
    expect(w?.spend_total).toBe(80);
  });

  it("Google: all_conversions never clears a row; it is counted and named", () => {
    const rows = [
      { text: "Page views only", spend_usd: 500, conversions: 0, all_conversions: 100 },
      { text: "No results", spend_usd: 40, conversions: 0, all_conversions: 0 },
      { text: "Sells", spend_usd: 90, conversions: 2, all_conversions: 2 },
    ];
    const w = buildWaste(rows, { ...spec, conversionFields: GOOGLE_CONVERSION_FIELDS, secondaryField: GOOGLE_SECONDARY_OUTCOME });
    expect(w?.lines.map((l) => l.label)).toEqual(["Page views only", "No results"]);
    expect(w?.spend_total).toBe(540);
    expect(w?.secondary_total).toBe(1);
    expect(w?.scope).toContain("1 of them logged other actions (all_conversions)");
  });

  it("secondaryField stays inside the byte budget on a wide account", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      text: `A long keyword phrase with plenty of words in it, number ${i}`,
      spend_usd: 1000 - i, conversions: 0, all_conversions: i % 2,
    }));
    const w = buildWaste(rows, {
      ...spec, conversionFields: GOOGLE_CONVERSION_FIELDS, secondaryField: GOOGLE_SECONDARY_OUTCOME, complete: false,
      excludeWhen: { field: "x", values: ["y"], label: "n/a" },
    })!;
    expect(w.secondary_total).toBe(200);
    expect(wasteBytes(w)).toBeLessThanOrEqual(TOTALS_BYTE_BUDGET);
  });

  it("emits nothing rather than claim an outcome it never read", () => {
    const rows = [{ text: "Lead ad", spend_usd: 200, conversions: 0 }];
    const w = buildWaste(rows, {
      ...spec,
      conversionFields: ["conversions", "leads"],
      outcomeLabel: "sales, signups or leads",
    });
    expect(w, "claimed 'no leads' about a field the tool never fetched").toBeUndefined();
  });

  it("still works once the field is actually present, even at zero", () => {
    const rows = [{ text: "Dead ad", spend_usd: 200, conversions: 0, leads: 0 }];
    const w = buildWaste(rows, {
      ...spec,
      conversionFields: ["conversions", "leads"],
      outcomeLabel: "sales, signups or leads",
    });
    expect(w?.lines[0].label).toBe("Dead ad");
  });

  it("names the unit, so an account-currency figure is never read as dollars", () => {
    const w = buildWaste([{ text: "x", spend_usd: 10, conversions: 0 }], { ...spec, currency: "EUR" });
    expect(w?.scope).toContain("EUR");
  });

  it("carries the zero-is-not-proof caveat, since the rich block it replaces is truncated away", () => {
    const w = buildWaste([{ text: "x", spend_usd: 10, conversions: 0 }], spec);
    expect(w?.scope.toLowerCase()).toContain("not proof");
  });

  it("states the window, so a 30-day figure is never read as monthly", () => {
    const w = buildWaste([{ text: "x", spend_usd: 1, conversions: 0 }], spec);
    expect(w?.scope).toContain("LAST_30_DAYS");
  });

  it("marks a partial pull instead of implying it saw everything", () => {
    const w = buildWaste([{ text: "x", spend_usd: 1, conversions: 0 }], { ...spec, complete: false });
    expect(w?.scope).toContain("(partial pull)");
    expect(w?.complete).toBe(false);
  });

  it("stays inside the sibling byte budget on a wide, verbose account", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      campaign_name: `Instagram post: 40% to Turo. 0% to us. Same car, same street, ${i} reasons to switch today`,
      spend_usd: 1000 - i,
      conversions: 0,
    }));
    const w = buildWaste(rows, { ...spec, entity: "campaigns" })!;
    expect(wasteBytes(w)).toBeLessThanOrEqual(TOTALS_BYTE_BUDGET);
    expect(w.lines_total).toBe(400);
    expect(w.lines[0].spend).toBe(1000);
  });

  it("excludeWhen leaves out rows not judged on these outcomes, counts them, and still fits the budget", () => {
    const ex = { field: "judged_on", values: ["reach_and_clicks"], label: "their objective buys reach or clicks, not results" };
    const rows = Array.from({ length: 400 }, (_, i) => ({
      campaign_name: `A long promotional campaign name with plenty of body copy, number ${i}`,
      spend_usd: 1000 - i,
      conversions: 0,
      judged_on: i % 2 ? "reach_and_clicks" : "conversions",
    }));
    const w = buildWaste(rows, { ...spec, entity: "campaigns", excludeWhen: ex })!;
    expect(w.lines_total).toBe(200);
    expect(w.excluded_total).toBe(200);
    expect(w.scope).toContain("200 more left out: their objective buys reach or clicks");
    expect(wasteBytes(w)).toBeLessThanOrEqual(TOTALS_BYTE_BUDGET);
  });

  it("excludeWhen with nothing excluded adds no key", () => {
    const w = buildWaste([{ text: "x", spend_usd: 5, conversions: 0, judged_on: "unknown" }], {
      ...spec,
      excludeWhen: { field: "judged_on", values: ["reach_and_clicks"], label: "n/a" },
    });
    expect(w && "excluded_total" in w).toBe(false);
  });
});
