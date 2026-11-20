
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/mcp/internal/operator-db", () => ({
  callOperatorDbTool: vi.fn(),
}));

import { readVerifiedBookingsByCampaignTool } from "../read_verified_bookings_by_campaign";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";

const callOpDb = callOperatorDbTool as unknown as ReturnType<typeof vi.fn>;
const ctx = { tenant_id: "tenant-A", log: () => {} };

function okDelegate(data: unknown) {
  return { ok: true, is_error: false, content: JSON.stringify(data) };
}

describe("readVerifiedBookingsByCampaignTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes per-campaign + overall coverage and the join row shape", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({
        available: true,
        window_days: 30,
        total_verified: 100,
        matched_verified: 9,
        rows: [
          {
            utm_campaign: "spring_ugc",
            utm_source: "fb",
            verified_bookings: 6,
            net_gmv: 1200,
            cancellations: 1,
          },
          {
            utm_campaign: "gig_rentals",
            utm_source: "ig",
            verified_bookings: 3,
            net_gmv: 600,
            cancellations: 0,
          },
        ],
      }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {
      window_days: 30,
    })) as {
      connected: boolean;
      window: string;
      matched_basis: string;
      coverage: { overall_pct: number; per_campaign: Record<string, number> };
      low_coverage: boolean;
      rows: Array<{ utm_campaign: string; verified_bookings: number; net_gmv: number }>;
    };

    expect(out.connected).toBe(true);
    expect(out.window).toBe("30d");
    expect(out.matched_basis).toMatch(/UTM campaign tag/i);
    expect(out.matched_basis).toMatch(/not a confirmed attribution mapping/i);
    expect(out.matched_basis).toMatch(/not a guaranteed ad-platform campaign name/i);
    expect(out.coverage.overall_pct).toBe(9);
    expect(out.coverage.per_campaign.spring_ugc).toBe(6);
    expect(out.coverage.per_campaign.gig_rentals).toBe(3);
    expect(out.low_coverage).toBe(true);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].net_gmv).toBe(1200);
  });

  it("clears low_coverage when overall coverage is usable (>=25%)", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({
        available: true,
        window_days: 30,
        total_verified: 40,
        matched_verified: 20,
        rows: [
          { utm_campaign: "x", utm_source: null, verified_bookings: 20, net_gmv: 5000, cancellations: 2 },
        ],
      }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      coverage: { overall_pct: number };
      low_coverage: boolean;
    };
    expect(out.coverage.overall_pct).toBe(50);
    expect(out.low_coverage).toBe(false);
  });

  it("low_coverage boundary: 24% low, 25% not low", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({ available: true, total_verified: 100, matched_verified: 24, rows: [] }),
    );
    const a = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      low_coverage: boolean;
    };
    expect(a.low_coverage).toBe(true);

    callOpDb.mockResolvedValueOnce(
      okDelegate({ available: true, total_verified: 100, matched_verified: 25, rows: [] }),
    );
    const b = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      low_coverage: boolean;
    };
    expect(b.low_coverage).toBe(false);
  });

  it("global total_verified=0 from a connected delegate ⇒ not_available (a trustworthy zero is indistinguishable from a broken join — never assert a bogus 0)", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({ available: true, total_verified: 0, matched_verified: 0, rows: [] }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      connected: boolean;
      reason: string;
    };
    expect(out.connected).toBe(false);
    expect(out.reason).toBe("not_available");
  });

  it("a SPECIFIC campaign at 0 verified is the legit RCA signal: total_verified>0, campaign simply absent from rows", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({
        available: true,
        total_verified: 80,
        matched_verified: 8,
        rows: [
          { utm_campaign: "spring_ugc", utm_source: "fb", verified_bookings: 8, net_gmv: 1600, cancellations: 0 },
        ],
      }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      connected: boolean;
      coverage: { per_campaign: Record<string, number> };
    };
    expect(out.connected).toBe(true);
    expect(out.coverage.per_campaign.spring_ugc).toBe(10);
    expect(out.coverage.per_campaign.gig_rentals_purchase).toBeUndefined();
  });

  it("non-finite numeric from a connected delegate never surfaces as NaN", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({ available: true, total_verified: "oops", matched_verified: null, rows: [] }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      connected: boolean;
      reason: string;
    };
    expect(out.connected).toBe(false);
    expect(out.reason).toBe("not_available");
  });

  it("not_available when operator_db returns an error (never fabricates)", async () => {
    callOpDb.mockResolvedValueOnce({
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "operator_db_aggregate_not_yet_implemented" }),
    });
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      connected: boolean;
      reason: string;
    };
    expect(out.connected).toBe(false);
    expect(out.reason).toBe("not_available");
  });

  it("not_available when the join reports available:false (missing attribution shape)", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({ available: false, reason: "not_available", window_days: 30, total_verified: 0, matched_verified: 0, rows: [] }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      connected: boolean;
      reason: string;
    };
    expect(out.connected).toBe(false);
    expect(out.reason).toBe("not_available");
  });

  it.each([
    ["delegate error", () => callOpDb.mockResolvedValueOnce({ ok: false, is_error: true, content: "{}" })],
    ["delegate throw", () => callOpDb.mockRejectedValueOnce(new Error("boom"))],
    ["available:false", () => callOpDb.mockResolvedValueOnce(okDelegate({ available: false }))],
  ])("not_available (%s) tells the agent to lead with the gap and label increases as dated tests", async (_label, arrange) => {
    arrange();
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      reason: string;
      limitation: string;
    };
    expect(out.reason).toBe("not_available");
    expect(out.limitation).toMatch(/completed-outcome CAC is unavailable/i);
    expect(out.limitation).toMatch(/say that first/i);
    expect(out.limitation).toMatch(/increase a test with a readout date/i);
    expect(out.limitation).not.toMatch(/pixel data only/i);
  });

  it("two sources sharing one campaign tag are added per campaign, never overwritten; each row keeps its own share", async () => {
    callOpDb.mockResolvedValueOnce(
      okDelegate({
        available: true,
        total_verified: 50,
        matched_verified: 10,
        rows: [
          { utm_campaign: "launch", utm_source: "fb", verified_bookings: 6, net_gmv: 600 },
          { utm_campaign: "launch", utm_source: "ig", verified_bookings: 4, net_gmv: 400 },
        ],
        utm_fields: { campaign: "acq.utmCampaign", source: "acq.utmSource" },
        truncated: true,
        unreadable_revenue_orders: 2,
      }),
    );
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as {
      coverage: { per_campaign: Record<string, number>; meaning: string };
      rows: Array<{ utm_source: string; share_pct: number }>;
      matched_basis: string;
      truncated?: boolean;
      unreadable_revenue_orders?: number;
    };
    expect(out.coverage.per_campaign.launch).toBe(20);
    expect(out.rows.map((r) => [r.utm_source, r.share_pct])).toEqual([
      ["fb", 12],
      ["ig", 8],
    ]);
    expect(out.coverage.meaning).toMatch(/not attribution accuracy/i);
    expect(out.matched_basis).toContain("acq.utmCampaign");
    expect(out.truncated).toBe(true);
    expect(out.unreadable_revenue_orders).toBe(2);
  });

  it("a typed not_available reason reaches the agent as a plain why", async () => {
    callOpDb.mockResolvedValueOnce(okDelegate({ available: false, reason: "order_map_unconfirmed", rows: [] }));
    const out = (await readVerifiedBookingsByCampaignTool.execute(ctx, {})) as { reason: string; why: string };
    expect(out.reason).toBe("not_available");
    expect(out.why).toMatch(/read_outcome_fields/);
  });
});
