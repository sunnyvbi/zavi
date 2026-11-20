import { describe, it, expect } from "vitest";
import { biddingSchema, createCampaignBodySchema } from "../_decision-bodies";
import { shapeBidding } from "../_request-shapers";
import { gadsChangeRows, biddingLabel } from "../_change-rows";
import { cpcCeilingReadBack, withClickBiddingWhenBlind } from "../_launch-defaults";

const create = (bidding: unknown, extra: Record<string, unknown> = {}) => ({
  name: "Spring search",
  channel_type: "SEARCH",
  daily_budget_usd: 20,
  bidding,
  location_ids: [2840],
  ...extra,
});

describe("Google Maximize clicks max cost per click (bug 5)", () => {
  it("example 4: cpc_bid_ceiling_usd 2.5 is sent as cpcBidCeilingMicros 2500000 and shown on the card", () => {
    const body = createCampaignBodySchema.parse(create({ strategy: "TARGET_SPEND", cpc_bid_ceiling_usd: 2.5 }));
    expect(shapeBidding(body.bidding)).toEqual({ targetSpend: { cpcBidCeilingMicros: "2500000" } });
    const rows = gadsChangeRows("google_ads.create_campaign", body)!.rows;
    expect(rows).toContainEqual({ item: "Bidding", before: "None", after: "Maximize clicks, max cost per click $2.50" });
  });

  it("no cap asked for: none sent, and the card says so", () => {
    const body = createCampaignBodySchema.parse(create({ strategy: "TARGET_SPEND" }));
    expect(shapeBidding(body.bidding)).toEqual({ targetSpend: {} });
    expect(biddingLabel(body.bidding)).toBe("Maximize clicks, no max cost per click");
  });

  it("example 4: an unknown bidding key is refused with a clear error, never dropped", () => {
    const r = createCampaignBodySchema.safeParse(create({ strategy: "TARGET_SPEND", cpc_bid_usd: 2 }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toMatch(/cpc_bid_usd/);
    expect(biddingSchema.safeParse({ strategy: "MAXIMIZE_CONVERSIONS", cpc_bid_ceiling_usd: 2 }).success).toBe(false);
    expect(biddingSchema.safeParse({ strategy: "TARGET_SPEND", cpc_bid_ceiling_usd: 0 }).success).toBe(false);
  });

  it("Autopilot's no-conversions switch keeps what it replaced, and the card shows it", () => {
    const asked = createCampaignBodySchema.parse(create({ strategy: "MAXIMIZE_CONVERSIONS", target_cpa_usd: 40 }));
    const body = withClickBiddingWhenBlind(asked, 0);
    expect(body.bidding).toEqual({ strategy: "TARGET_SPEND" });
    expect(body.bidding_replaced).toEqual({ strategy: "MAXIMIZE_CONVERSIONS", target_cpa_usd: 40 });
    const reparsed = createCampaignBodySchema.parse(JSON.parse(JSON.stringify(body)));
    const rows = gadsChangeRows("google_ads.create_campaign", reparsed)!.rows;
    expect(rows).toContainEqual({
      item: "Bidding asked for",
      before: "Maximize conversions, target cost per conversion $40",
      after: "Replaced: no conversions in the last 30 days",
    });
  });

  it("click bidding the run chose keeps its cap", () => {
    const asked = createCampaignBodySchema.parse(create({ strategy: "TARGET_SPEND", cpc_bid_ceiling_usd: 1.75 }));
    expect(withClickBiddingWhenBlind(asked, 0)).toBe(asked);
  });
});

describe("max CPC read-back after the create", () => {
  const capped = { strategy: "TARGET_SPEND" as const, cpc_bid_ceiling_usd: 2.5 };

  it("the cap Google shows matches: nothing to say", () => {
    expect(cpcCeilingReadBack(capped, 2_500_000)).toBe("");
  });

  it("missing or different on Google: says so (the campaign is switched on anyway by the caller)", () => {
    expect(cpcCeilingReadBack(capped, null)).toBe("The max cost per click did not save on Google (asked $2.50, Google shows none).");
    expect(cpcCeilingReadBack(capped, 3_000_000)).toBe("The max cost per click did not save on Google (asked $2.50, Google shows $3.00).");
  });

  it("an unreadable read-back is said, never assumed saved", () => {
    expect(cpcCeilingReadBack(capped, undefined)).toMatch(/could not read back the max cost per click/);
  });

  it("no cap asked for: nothing to say", () => {
    expect(cpcCeilingReadBack({ strategy: "TARGET_SPEND" }, null)).toBe("");
  });
});

describe("Performance Max bidding is strict too", () => {
  it("a misspelled target is refused, not dropped into uncapped bidding", async () => {
    const { googleProposePmaxCampaignTool } = await import("../propose_pmax_campaign");
    const shape = (googleProposePmaxCampaignTool.input_schema as unknown as { shape: { bidding: { safeParse: (v: unknown) => { success: boolean } } } }).shape.bidding;
    expect(shape.safeParse({ strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 30 }).success).toBe(false);
    expect(shape.safeParse({ strategy: "MAXIMIZE_CONVERSIONS", target_cpa_usd: 30 }).success).toBe(true);
  });
});
