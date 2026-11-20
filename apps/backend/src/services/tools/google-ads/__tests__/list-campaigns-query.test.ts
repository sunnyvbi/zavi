import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.fn();
vi.mock("../_client", () => ({ gadsSearch: (...a: unknown[]) => gadsSearch(...a) }));

import { listCampaignsTool } from "../list_campaigns";

const ctx = { tenant_id: "t-1" } as never;
const selectedFields = (query: string) =>
  query
    .slice(query.indexOf("SELECT") + 6, query.indexOf("FROM"))
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

beforeEach(() => {
  gadsSearch.mockReset().mockResolvedValue([]);
});

describe("google_ads_list_campaigns GAQL", () => {
  it("never selects campaign.start_date / campaign.end_date (removed in v25)", async () => {
    await listCampaignsTool.execute(ctx, { date_range: "LAST_30_DAYS", status: "ALL" });
    const [, query] = gadsSearch.mock.calls[0] as [string, string];
    const fields = selectedFields(query);
    expect(fields).not.toContain("campaign.start_date");
    expect(fields).not.toContain("campaign.end_date");
    expect(fields).toEqual([
      "campaign.id",
      "campaign.name",
      "campaign.status",
      "campaign.advertising_channel_type",
      "campaign.start_date_time",
      "campaign.end_date_time",
      "campaign.campaign_budget",
      "campaign_budget.amount_micros",
      "metrics.cost_micros",
      "metrics.impressions",
      "metrics.clicks",
      "metrics.conversions",
      "metrics.all_conversions",
      "metrics.conversions_value",
      "metrics.average_cpc",
      "metrics.ctr",
      "metrics.average_cpm",
    ]);
  });

  it("still returns the row shape callers expect, with null start/end times", async () => {
    gadsSearch.mockResolvedValue([
      {
        campaign: {
          id: "9",
          name: "Brand",
          status: "ENABLED",
          advertisingChannelType: "SEARCH",
          campaignBudget: "customers/1/campaignBudgets/5",
          startDateTime: "2026-09-10 00:00:00",
          endDateTime: "2037-12-30 00:00:00",
        },
        campaignBudget: { amountMicros: "20000000" },
        metrics: { costMicros: "5000000", impressions: "100", clicks: "10", conversions: "2", conversionsValue: "30" },
      },
    ]);
    const out = (await listCampaignsTool.execute(ctx, { date_range: "LAST_30_DAYS", status: "ALL" })) as {
      campaigns: Array<Record<string, unknown>>;
    };
    expect(out.campaigns[0]).toMatchObject({
      campaign_id: "9",
      channel_type: "SEARCH",
      start_time: "2026-09-10 00:00:00",
      end_time: null,
      daily_budget_usd: 20,
      spend_usd: 5,
      roas: 6,
      cpa_usd: 2.5,
    });
  });

  it("surfaces channel_type as null rather than dropping the key when the API omits it", async () => {
    gadsSearch.mockResolvedValue([
      { campaign: { id: "1", name: "No type", status: "ENABLED" }, metrics: {} },
    ]);
    const out = (await listCampaignsTool.execute(ctx, { date_range: "LAST_7_DAYS", status: "ALL" })) as {
      campaigns: Array<Record<string, unknown>>;
    };
    expect("channel_type" in out.campaigns[0]).toBe(true);
    expect(out.campaigns[0].channel_type).toBeNull();
  });

  it("keeps a campaign with all_conversions only on the waste list, flagged", async () => {
    gadsSearch.mockResolvedValue([
      { campaign: { id: "1", name: "Signups only", status: "ENABLED" }, metrics: { costMicros: "50000000", conversions: "0", allConversions: "3" } },
      { campaign: { id: "2", name: "No results", status: "ENABLED" }, metrics: { costMicros: "20000000", conversions: "0", allConversions: "0" } },
    ]);
    const out = (await listCampaignsTool.execute(ctx, { date_range: "LAST_30_DAYS", status: "ALL" })) as {
      campaigns: Array<Record<string, unknown>>;
      waste?: { lines: Array<{ label: string }>; spend_total: number; secondary_total?: number };
      conversion_columns: string;
    };
    expect(out.campaigns[0]).toMatchObject({ conversions: 0, all_conversions: 3 });
    expect(out.waste?.lines.map((l) => l.label)).toEqual(["Signups only", "No results"]);
    expect(out.waste?.spend_total).toBe(70);
    expect(out.waste?.secondary_total).toBe(1);
    expect(out.conversion_columns).toContain("never clears a row");
  });
});
