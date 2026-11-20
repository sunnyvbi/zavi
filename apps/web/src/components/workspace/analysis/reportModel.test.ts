
import { describe, it, expect } from "vitest";
import { buildReport, isTimeSeries, parseSources, toCsv } from "@zavi/shared";

const TABLE = {
  kind: "table" as const,
  title: "Month · Sign-ups · Booked · Rate",
  columns: ["Month", "Sign-ups", "Booked", "Rate"],
  rows: [
    ["July", "1,587", "180", "11.3%"],
    ["August", "2,497", "166", "6.6%"],
    ["September*", "1,853", "167", "9.0%"],
  ],
  note: "*Sep 1-25 only.",
};

describe("buildReport", () => {
  it("names the report from its measures, not its column list", () => {
    expect(buildReport(TABLE)!.title).toBe("Sign-ups, Booked and Rate by month");
    expect(buildReport({ ...TABLE, title: "Funnel by month" })!.title).toBe("Funnel by month");
  });

  it("splits the dimension from the measures", () => {
    const m = buildReport(TABLE)!;
    expect(m.dimension).toBe("Month");
    expect(m.labels).toEqual(["July", "August", "September*"]);
    expect(m.measures.map((x) => [x.name, x.kind])).toEqual([
      ["Sign-ups", "count"],
      ["Booked", "count"],
      ["Rate", "percent"],
    ]);
  });

  it("gives each headline number its change vs the row before", () => {
    const k = buildReport(TABLE)!.kpis;
    expect(k[0]).toMatchObject({ name: "Sign-ups", value: "1,853", period: "September", change: "Down 25.8%", previous: "August", direction: "down" });
    expect(k[2]).toMatchObject({ name: "Rate", value: "9.0%", change: "Up 2.4 pts", previous: "August", direction: "up" });
  });

  it("draws a chart block and a KPI block too, and nothing else", () => {
    const c = buildReport({ kind: "chart", title: "Bookings", variant: "bar", series: [{ label: "Jul", value: 120 }] })!;
    expect(c.measures[0].values).toEqual([120]);
    const k = buildReport({ kind: "kpi", title: "Week", items: [{ label: "Revenue", value: "$4,210", delta: "+12% vs last week", tone: "up" }] })!;
    expect(k.kpis[0]).toMatchObject({ name: "Revenue", value: "$4,210", change: "+12% vs last week" });
    expect(buildReport({ kind: "html", title: "x", html: "<p>x</p>" })).toBeNull();
  });
});

describe("parseSources", () => {
  it("splits the note into pulled, checked and missing", () => {
    const s = parseSources(
      [
        "**Sources.** 6 of 12 numbers came straight from data pulled in this run, 2 check out as arithmetic on it.",
        "",
        "1. Your database: a query returned 1,587, 180",
        "",
        "Checks out against those: 11.3% = 180 / 1,587 · 6.6% = 166 / 2,497",
        "",
        "Not in this run's data: 65%. Worked out here or carried in from earlier context, so check it before acting.",
      ].join("\n"),
    )!;
    expect(s.summary).toBe("6 of 12 numbers came straight from data pulled in this run, 2 check out as arithmetic on it.");
    expect(s.pulled).toEqual(["Your database: a query returned 1,587, 180"]);
    expect(s.checked).toEqual(["11.3% = 180 / 1,587", "6.6% = 166 / 2,497"]);
    expect(s.missing).toMatch(/^Not in this run's data: 65%/);
  });
});

describe("toCsv", () => {
  it("quotes cells with commas", () => {
    expect(toCsv(["Month", "N"], [["July", "1,587"]])).toBe('Month,N\nJuly,"1,587"');
  });
});

describe("explainRates", () => {
  it("names a rate by the two columns every row divides to", () => {
    const m = buildReport(TABLE)!;
    expect(m.measures.find((x) => x.name === "Rate")!.formula).toBe("Booked ÷ Sign-ups");
    expect(m.measures.find((x) => x.name === "Booked")!.formula).toBeUndefined();
  });

  it("says nothing when one row does not fit", () => {
    const off = { ...TABLE, rows: [...TABLE.rows.slice(0, 2), ["September*", "1,853", "167", "12.0%"]] };
    expect(buildReport(off)!.measures.find((x) => x.name === "Rate")!.formula).toBeUndefined();
  });
});

describe("review round four", () => {
  it("keeps a numeric first column as the dimension", () => {
    const m = buildReport({ kind: "table", title: "t", columns: ["Year", "Revenue"], rows: [["2025", "100"], ["2026", "120"]] })!;
    expect(m.dimension).toBe("Year");
    expect(m.measures.map((x) => x.name)).toEqual(["Revenue"]);
    expect(m.kpis[0]).toMatchObject({ name: "Revenue", change: "Up 20%" });
  });

  it("never charts a KPI card's mixed units", () => {
    const m = buildReport({ kind: "kpi", title: "k", items: [{ label: "Revenue", value: "$4,210" }, { label: "Conversion", value: "9.0%" }] })!;
    expect(m.measures).toEqual([]);
  });

  it("only compares rows that are periods in time order", () => {
    const channels = { kind: "table" as const, title: "t", columns: ["Channel", "Sign-ups"], rows: [["Meta", "900"], ["Google", "400"]] };
    expect(buildReport(channels)!.kpis).toEqual([]);
    expect(isTimeSeries(["July", "August", "September*"])).toBe(true);
    expect(isTimeSeries(["September", "August"])).toBe(false);
    expect(isTimeSeries(["2026-07", "2026-08"])).toBe(true);
  });

  it("neutralizes spreadsheet formulas in the CSV but keeps negative numbers", () => {
    expect(toCsv(["A"], [["=HYPERLINK(1)"], ["-12%"], ["@x"]])).toBe("A\n'=HYPERLINK(1)\n-12%\n'@x");
  });
});

describe("review round five", () => {
  it("never names a rate from unlike units", () => {
    const t = { kind: "table" as const, title: "t", columns: ["Month", "Revenue", "Customers", "Churn"], rows: [["July", "$1,000", "100", "10%"], ["August", "$2,000", "200", "10%"]] };
    expect(buildReport(t)!.measures.find((m) => m.name === "Churn")!.formula).toBeUndefined();
  });

  it("gives a one-row report its headline number", () => {
    const t = { kind: "table" as const, title: "t", columns: ["Month", "Sign-ups"], rows: [["September", "1,853"]] };
    expect(buildReport(t)!.kpis[0]).toMatchObject({ name: "Sign-ups", value: "1,853", change: null });
  });

  it("reads month-day labels as days in order", () => {
    expect(isTimeSeries(["Sep 29", "Sep 30", "Oct 1"])).toBe(true);
    expect(isTimeSeries(["Sep '25", "Sep '26"])).toBe(true);
  });
});

