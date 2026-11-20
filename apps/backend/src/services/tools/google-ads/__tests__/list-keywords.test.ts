import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { listKeywordsTool } from "../list_keywords";

const ctx = { tenant_id: "t-1" } as never;
const selectedFields = (query: string) =>
  query
    .slice(query.indexOf("SELECT") + 6, query.indexOf("FROM"))
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

function row(text: string, cost: number, conv: number, allConv: number) {
  return {
    campaign: { id: "1", name: "Search" },
    adGroup: { id: "2", name: "AG" },
    adGroupCriterion: { criterionId: text, status: "ENABLED", keyword: { text, matchType: "BROAD" } },
    metrics: {
      costMicros: String(cost * 1_000_000),
      impressions: "100",
      clicks: "10",
      conversions: String(conv),
      allConversions: String(allConv),
    },
  };
}

beforeEach(() => {
  gadsSearch.mockReset().mockResolvedValue([]);
});

describe("google_ads_list_keywords", () => {
  it("selects both conversion columns", async () => {
    await listKeywordsTool.execute(ctx, { campaign_id: "1" });
    const [, query] = gadsSearch.mock.calls[0] as [string, string];
    const fields = selectedFields(query);
    expect(fields).toContain("metrics.conversions");
    expect(fields).toContain("metrics.all_conversions");
  });

  it("maps all_conversions and names the column it counted", async () => {
    gadsSearch.mockResolvedValue([row("widgets", 30, 0, 4)]);
    const out = (await listKeywordsTool.execute(ctx, { campaign_id: "1" })) as {
      keywords: Array<Record<string, unknown>>;
      conversion_columns: string;
    };
    expect(out.keywords[0]).toMatchObject({ conversions: 0, all_conversions: 4 });
    expect(out.conversion_columns).toMatch(/Include in Conversions/);
  });

  it("keeps a keyword with all_conversions only on the waste list, flagged", async () => {
    gadsSearch.mockResolvedValue([row("page views only", 50, 0, 100), row("dead", 20, 0, 0), row("sells", 30, 2, 2)]);
    const out = (await listKeywordsTool.execute(ctx, { campaign_id: "1" })) as {
      waste?: { lines: Array<{ label: string }>; spend_total: number; secondary_total?: number; scope: string };
    };
    expect(out.waste?.lines.map((l) => l.label)).toEqual(["page views only", "dead"]);
    expect(out.waste?.spend_total).toBe(70);
    expect(out.waste?.secondary_total).toBe(1);
    expect(out.waste?.scope).toContain("unless the founder counts that action");
  });
});
