
import { describe, it, expect, vi, beforeEach } from "vitest";

const g = vi.hoisted(() => ({ fbGet: vi.fn(), fbPost: vi.fn(), currency: vi.fn(), creds: vi.fn(), copyOneAd: vi.fn() }));
vi.mock("../../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  fbPost: (...a: unknown[]) => g.fbPost(...a),
  getAdAccountCurrency: (...a: unknown[]) => g.currency(...a),
  metaAdsCreds: (...a: unknown[]) => g.creds(...a),
}));
vi.mock("../launch", () => ({ copyOneAd: (...a: unknown[]) => g.copyOneAd(...a) }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));

import {
  applyTargetingPatch,
  metaDuplicateAd,
  metaUpdateAd,
  metaUpdateAdSet,
  targetingFingerprint,
} from "../adset_ad_writes";
import { updateAdBodySchema, updateAdSetBodySchema } from "../_decision-bodies";
import { metaProposeAdSetUpdateTool, metaProposeAdUpdateTool } from "../propose_edit";
import { metaChangeRows } from "../_change-rows";
import type { ToolContext } from "@/services/tools/types";

const SET = "238000000001";
const AD = "238000000777";
const TARGETING = { geo_locations: { countries: ["US"] }, age_min: 25, age_max: 54, targeting_automation: { advantage_audience: 0 } };

function liveSet(extra: Record<string, unknown> = {}) {
  return {
    id: SET,
    account_id: "555",
    name: "Prospecting",
    end_time: null,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    bid_amount: null,
    targeting: TARGETING,
    campaign: { daily_budget: null, lifetime_budget: null },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  g.creds.mockResolvedValue({ ad_account_id: "act_555", access_token: "t" });
  g.currency.mockResolvedValue("USD");
  g.fbPost.mockResolvedValue({ success: true });
});

describe("targeting", () => {
  it("a patch replaces only its own keys; places and automation are sent back unchanged", () => {
    expect(applyTargetingPatch(TARGETING, { age_min: 30 })).toEqual({ ...TARGETING, age_min: 30 });
  });

  it("the fingerprint ignores key order and changes with any value", () => {
    const reordered = { age_max: 54, targeting_automation: { advantage_audience: 0 }, age_min: 25, geo_locations: { countries: ["US"] } };
    expect(targetingFingerprint(reordered)).toBe(targetingFingerprint(TARGETING));
    expect(targetingFingerprint({ ...TARGETING, age_min: 26 })).not.toBe(targetingFingerprint(TARGETING));
  });
});

describe("metaUpdateAdSet", () => {
  it("sends the merged targeting when the live targeting still matches", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet());
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, targeting_patch: { age_min: 30 }, expected_targeting_fingerprint: targetingFingerprint(TARGETING) });
    await metaUpdateAdSet("t1", body);
    const params = g.fbPost.mock.calls[0][2] as Record<string, string>;
    expect(JSON.parse(params.targeting)).toEqual({ ...TARGETING, age_min: 30 });
  });

  it("refuses when the targeting changed since the proposal", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet({ targeting: { ...TARGETING, age_max: 40 } }));
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, targeting_patch: { age_min: 30 }, expected_targeting_fingerprint: targetingFingerprint(TARGETING) });
    await expect(metaUpdateAdSet("t1", body)).rejects.toMatchObject({ code: "meta_ads_targeting_stale" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("sets a future end date against the end date it was proposed from", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet());
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, end_time: end, expected_current_end_time: null });
    await expect(metaUpdateAdSet("t1", body)).resolves.toEqual({ updated_fields: ["end_time"] });
    g.fbGet.mockResolvedValueOnce(liveSet({ end_time: "2026-12-01T00:00:00+0000" }));
    await expect(metaUpdateAdSet("t1", body)).rejects.toMatchObject({ code: "meta_ads_end_time_drift" });
    const was = updateAdSetBodySchema.parse({ ad_set_id: SET, end_time: end, expected_current_end_time: "2026-12-01T00:00:00+0000" });
    g.fbGet.mockResolvedValueOnce(liveSet({ end_time: "2026-12-01T00:00:00+0000" }));
    await expect(metaUpdateAdSet("t1", was)).resolves.toEqual({ updated_fields: ["end_time"] });
  });

  it("refuses a past end date", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet());
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, end_time: "2020-01-01T00:00:00Z", expected_current_end_time: null });
    await expect(metaUpdateAdSet("t1", body)).rejects.toMatchObject({ code: "meta_ads_invalid_end_time" });
  });

  it("refuses a bid strategy under a campaign that holds the budget", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet({ campaign: { daily_budget: "5000" } }));
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, bid_strategy: "COST_CAP", expected_current_bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    await expect(metaUpdateAdSet("t1", body)).rejects.toMatchObject({ code: "meta_ads_bid_strategy_on_campaign" });
  });

  it("sends a bid in minor units and refuses one that moved", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet({ bid_amount: 250 }));
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, bid_amount_usd: 3, expected_current_bid_amount_usd: 2.5, currency: "USD" });
    await metaUpdateAdSet("t1", body);
    expect(g.fbPost.mock.calls[0][2]).toEqual({ bid_amount: "300" });
    g.fbGet.mockResolvedValueOnce(liveSet({ bid_amount: 400 }));
    await expect(metaUpdateAdSet("t1", body)).rejects.toMatchObject({ code: "meta_ads_bid_amount_drift" });
  });

  it("refuses an ad set from another ad account", async () => {
    g.fbGet.mockResolvedValueOnce(liveSet({ account_id: "999" }));
    const body = updateAdSetBodySchema.parse({ ad_set_id: SET, new_name: "X" });
    await expect(metaUpdateAdSet("t1", body)).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
  });
});

describe("metaUpdateAd", () => {
  it("swaps the creative only from the creative it was proposed against, and only to one of this account's", async () => {
    g.fbGet
      .mockResolvedValueOnce({ id: AD, account_id: "555", name: "A", status: "ACTIVE", creative: { id: "111111" } })
      .mockResolvedValueOnce({ id: "222222", account_id: "555" });
    const body = updateAdBodySchema.parse({ ad_id: AD, creative_id: "222222", expected_current_creative_id: "111111" });
    await metaUpdateAd("t1", body);
    expect(g.fbPost.mock.calls[0][2]).toEqual({ creative: JSON.stringify({ creative_id: "222222" }) });

    g.fbGet
      .mockResolvedValueOnce({ id: AD, account_id: "555", creative: { id: "111111" } })
      .mockResolvedValueOnce({ id: "222222", account_id: "999" });
    await expect(metaUpdateAd("t1", body)).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
  });
});

describe("metaDuplicateAd", () => {
  it("copies into the ad set with the tag, then switches the copy on", async () => {
    g.fbGet
      .mockResolvedValueOnce({ id: AD, account_id: "555", name: "Hero" })
      .mockResolvedValueOnce(liveSet())
      .mockResolvedValueOnce({ data: [] });
    g.copyOneAd.mockResolvedValueOnce("238000000999");
    const r = await metaDuplicateAd("t1", { source_ad_id: AD, ad_set_id: SET, rationale: "", tag: "zvabc1234567" });
    expect(r).toEqual({ id: "238000000999", name: "Hero · zvabc1234567", reused: false });
    expect(g.fbPost).toHaveBeenCalledWith("t1", "238000000999", { name: "Hero · zvabc1234567", status: "ACTIVE" });
  });

  it("a retry finds its copy by the tag and copies nothing", async () => {
    g.fbGet
      .mockResolvedValueOnce({ id: AD, account_id: "555", name: "Hero" })
      .mockResolvedValueOnce(liveSet())
      .mockResolvedValueOnce({ data: [{ id: "238000000999", name: "Hero · zvabc1234567" }] });
    const r = await metaDuplicateAd("t1", { source_ad_id: AD, ad_set_id: SET, rationale: "", tag: "zvabc1234567" });
    expect(r.reused).toBe(true);
    expect(g.copyOneAd).not.toHaveBeenCalled();
  });
});

describe("propose tools stamp the live baseline", () => {
  function ctx() {
    const emit = vi.fn(async () => "d-1");
    const c: ToolContext = { tenant_id: "t1", log: () => {}, emit_decision: emit, run_trigger: "scheduled" };
    return { c, emit };
  }

  it("an ad set change carries the live end date, bid and targeting fingerprint", async () => {
    const { c, emit } = ctx();
    g.fbGet.mockResolvedValueOnce(liveSet({ bid_amount: 250, end_time: "2026-11-01T00:00:00+0000" }));
    await metaProposeAdSetUpdateTool.execute(c, {
      ad_set_id: SET,
      end_time: "2026-12-01T00:00:00+00:00",
      bid_amount_usd: 3,
      targeting: { age_min: 30 },
      rationale: "extend the winner",
    });
    expect(emit).toHaveBeenCalledWith(
      "meta_ads.update_ad_set",
      expect.objectContaining({
        expected_current_end_time: "2026-11-01T00:00:00+00:00",
        expected_current_bid_amount_usd: 2.5,
        expected_targeting_fingerprint: targetingFingerprint(TARGETING),
        targeting_patch: { age_min: 30 },
        name: "Prospecting",
      }),
    );
  });

  it("an ad creative swap carries the live creative", async () => {
    const { c, emit } = ctx();
    g.fbGet.mockResolvedValueOnce({ name: "Hero", creative: { id: "111111" } });
    await metaProposeAdUpdateTool.execute(c, { ad_id: AD, creative_id: "222222", rationale: "fresh creative" });
    expect(emit).toHaveBeenCalledWith("meta_ads.update_ad", expect.objectContaining({ expected_current_creative_id: "111111", name: "Hero" }));
  });
});

describe("cards", () => {
  it("an ad set change lists each changed thing and says the rest stays", () => {
    const c = metaChangeRows("meta_ads.update_ad_set", {
      ad_set_id: SET,
      name: "Prospecting",
      targeting_patch: { genders: [2] },
      expected_targeting_fingerprint: "a".repeat(64),
    });
    expect(c?.rows).toEqual([{ item: "Gender", before: "Current setting", after: "Women" }]);
    expect(c?.change_sentence).toBe("Zavi changes gender on “Prospecting”. Everything else on it stays as it is.");
  });
});
