import { beforeEach, describe, expect, it, vi } from "vitest";

const gadsSearch = vi.hoisted(() => vi.fn());
vi.mock("../_client", () => ({ gadsSearch }));

import { listVideoCampaignsTool } from "../list_video_campaigns";

const ctx = { tenant_id: "t1", log: () => {}, agent_slug: "youtube_ads" } as never;

describe("video campaign reads use the TrueView metric names", () => {
  beforeEach(() => gadsSearch.mockReset());

  it("asks for the v22+ names, never the ones v25 rejects", async () => {
    gadsSearch.mockResolvedValue([]);
    await listVideoCampaignsTool.execute(ctx, { date_range: "LAST_30_DAYS", status: "ALL" });
    const query = String(gadsSearch.mock.calls[0][1]);
    expect(query).toContain("metrics.video_trueview_views");
    expect(query).toContain("metrics.video_trueview_view_rate");
    expect(query).toContain("metrics.trueview_average_cpv");
    expect(query).not.toMatch(/metrics\.video_views\b|metrics\.video_view_rate\b|metrics\.average_cpv\b/);
  });

  it("maps the TrueView response back onto the same output fields", async () => {
    gadsSearch.mockResolvedValue([
      {
        campaign: { id: "1", name: "Shorts", status: "ENABLED", advertisingChannelType: "VIDEO" },
        metrics: {
          costMicros: "20000000",
          impressions: "1000",
          videoTrueviewViews: "250",
          videoTrueviewViewRate: "0.25",
          trueviewAverageCpv: "80000",
          conversions: "2",
          conversionsValue: "50",
        },
      },
    ]);
    const out = (await listVideoCampaignsTool.execute(ctx, { date_range: "LAST_30_DAYS", status: "ALL" })) as {
      campaigns: Record<string, unknown>[];
    };
    expect(out.campaigns[0]).toMatchObject({ video_views: 250, view_rate: 25, avg_cpv_usd: 0.08, spend_usd: 20, cpa_usd: 10 });
  });
});
