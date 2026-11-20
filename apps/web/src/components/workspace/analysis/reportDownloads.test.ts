import { describe, it, expect } from "vitest";
import type { ReportModel } from "@zavi/shared";
import { reportFileStem, reportToMarkdown } from "./reportDownloads";

const model: ReportModel = {
  title: "Products read from your Shopify store (first 10 of 17)",
  dimension: null,
  labels: [],
  measures: [],
  kpis: [{ name: "Revenue", value: "$1,200", change: "+12%" } as ReportModel["kpis"][number]],
  columns: ["Product", "Status"],
  rows: [
    ["Gift | Card", "Active"],
    ["Snowboard", ""],
  ],
  note: null,
};

describe("report downloads", () => {
  it("names the file after the report title", () => {
    expect(reportFileStem(model.title)).toBe("products-read-from-your-shopify-store-first-10-of-17");
    expect(reportFileStem("!!!")).toBe("report");
  });

  it("writes the title, summary, numbers and an escaped table as markdown", () => {
    const md = reportToMarkdown(model, "Shopify is connected.");
    expect(md).toContain("# Products read from your Shopify store (first 10 of 17)");
    expect(md).toContain("Shopify is connected.");
    expect(md).toContain("- **Revenue:** $1,200 (+12%)");
    expect(md).toContain("| Product | Status |\n| --- | --- |");
    expect(md).toContain("| Gift \\| Card | Active |");
    expect(md).toContain("| Snowboard | - |");
  });
});
