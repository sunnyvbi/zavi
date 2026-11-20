import { describe, it, expect } from "vitest";
import { agoText, chipLabel, figureKey, formatWindow, isNeutralMetric, parseFigureReceipts, parseTrendLead, receiptSource } from "./receiptData";
import { syncLine } from "../settings/useConnectorSyncStatus";

describe("parseTrendLead", () => {
  it("lifts a short opening sentence into the pill", () => {
    expect(parseTrendLead("**Green** up 6.2% vs Aug 1-27. Net revenue is $41,380.")).toEqual({
      tone: "green",
      pill: "Up 6.2% vs Aug 1-27",
      body: "Net revenue is $41,380.",
    });
  });

  it("reads Red and a colon", () => {
    const t = parseTrendLead("**Red**: down 8.1% vs the week before.\n\nNew customers fell to 91.");
    expect(t?.tone).toBe("red");
    expect(t?.pill).toBe("Down 8.1% vs the week before");
    expect(t?.body.startsWith("New customers")).toBe(true);
  });

  it("keeps a long opening sentence in the prose and labels the pill", () => {
    const t = parseTrendLead(
      "**Amber** net revenue held about level with the week before while orders dipped a little and order value rose. More.",
    );
    expect(t?.tone).toBe("amber");
    expect(t?.pill).toBe("Holding flat");
    expect(t?.body.startsWith("net revenue held")).toBe(true);
  });

  it("ignores a reply that does not open with a tone", () => {
    expect(parseTrendLead("Net revenue is **Green** territory.")).toBeNull();
    expect(parseTrendLead("Here is the plan.")).toBeNull();
  });
});

describe("formatters", () => {
  it("formats windows the way the wireframe does", () => {
    expect(formatWindow({ since: "2026-09-01", until: "2026-09-27" })).toBe("Sep 1-27");
    expect(formatWindow({ since: "2026-08-30", until: "2026-09-02" })).toBe("Aug 30 - Sep 2");
    expect(formatWindow({ since: "2026-09-27", until: "2026-09-27" })).toBe("Sep 27");
    expect(formatWindow({ since: "2025-12-28", until: "2026-01-03" })).toBe("Dec 28, 2025 - Jan 3, 2026");
    expect(formatWindow(undefined)).toBeNull();
  });

  it("says how long ago, and nothing for a bad or future time", () => {
    const now = new Date("2026-09-28T18:00:00Z");
    expect(agoText("2026-09-28T16:00:00Z", now)).toBe("2h ago");
    expect(agoText("2026-09-28T17:59:30Z", now)).toBe("just now");
    expect(agoText("2026-09-25T08:00:00Z", now)).toBe("3 days ago");
    expect(agoText("not a date", now)).toBeNull();
    expect(agoText("2026-09-29T18:00:00Z", now)).toBeNull();
  });

  it("builds the chip label from source, window and age", () => {
    const now = new Date("2026-09-28T18:12:00Z");
    expect(
      chipLabel({ kind: "catalog", sourceSlug: "stripe", window: { since: "2026-09-01", until: "2026-09-27" }, fetchedAt: "2026-09-28T16:12:00Z" }, now),
    ).toBe("Stripe · Sep 1-27 · 2h ago");
  });

  it("treats ad spend as neutral, not good or bad", () => {
    expect(isNeutralMetric("meta_ad_spend")).toBe(true);
    expect(isNeutralMetric("ad_spend_total")).toBe(true);
    expect(isNeutralMetric("Ad spend")).toBe(true);
    expect(isNeutralMetric("net_revenue")).toBe(false);
    expect(isNeutralMetric("meta_cpa")).toBe(false);
  });
});

describe("parseFigureReceipts", () => {
  it("keeps well-formed entries and drops junk", () => {
    const out = parseFigureReceipts([
      { figure: "$41,380", kind: "catalog", source: "Stripe", source_slug: "stripe", window: { since: "2026-09-01", until: "2026-09-27" }, params: [["grain", "day"], ["bad"]] },
      { figure: "", kind: "catalog" },
      { figure: "12", kind: "made_up" },
      "nope",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ figure: "$41,380", sourceSlug: "stripe", params: [["grain", "day"]] });
    expect(parseFigureReceipts(undefined)).toEqual([]);
  });
});

describe("syncLine", () => {
  const now = new Date("2026-09-28T18:00:00Z");
  it("is fresh within a day and a half of the daily sync", () => {
    expect(syncLine("2026-09-28T05:41:00Z", now)).toEqual({ text: "Last synced 12h ago", stale: false });
    expect(syncLine("2026-09-27T08:00:00Z", now)?.stale).toBe(false);
  });
  it("turns stale 12 hours after a missed daily sync", () => {
    expect(syncLine("2026-09-25T08:40:00Z", now)).toEqual({ text: "Last synced 3 days ago", stale: true });
  });
  it("shows nothing without a real time", () => {
    expect(syncLine(null, now)).toBeNull();
    expect(syncLine("garbage", now)).toBeNull();
  });
});

describe("chip label and owner-typed figures", () => {
  it("keeps the (call N) join key out of the chip but in the drawer's source", () => {
    const [r] = parseFigureReceipts([{ figure: "594", kind: "pulled", source: "Your database: a query (call 4)" }]);
    expect(chipLabel(r)).toBe("Your database: a query");
    expect(receiptSource(r)).toBe("Your database: a query (call 4)");
  });

  it("parses a figure the owner typed and labels it 'From you'", () => {
    const [r] = parseFigureReceipts([{ figure: "1,500", kind: "reported", source: "From you", source_slug: "founder_reported" }]);
    expect(r.kind).toBe("reported");
    expect(chipLabel(r)).toBe("From you");
  });
});

describe("figureKey — typed by unit (bug #21)", () => {
  it("$70, 70% and a bare 70 never share a key", () => {
    const keys = ["$70", "70%", "70", "170"].map(figureKey);
    expect(new Set(keys).size).toBe(4);
    expect(figureKey("$70")).toBe("$70");
    expect(figureKey("70%")).toBe("70%");
    expect(figureKey("70")).toBe("#70");
  });
  it("the same value and unit is one key", () => {
    expect(figureKey("$70.00")).toBe(figureKey("$70"));
    expect(figureKey("$1,587")).toBe(figureKey("$1587"));
    expect(figureKey("12.5 %")).toBe(figureKey("12.5%"));
  });
  it("a sign, a single marked digit, and decimals stay apart", () => {
    expect(figureKey("-12%")).not.toBe(figureKey("12%"));
    expect(figureKey("$4")).toBe("$4");
    expect(figureKey("4%")).toBe("4%");
    expect(figureKey("$1.25")).not.toBe(figureKey("$125"));
    expect(figureKey("3")).toBe("#3");
  });
});
