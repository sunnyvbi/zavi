
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../_ad-set-bid", () => ({ resolveCreateAdSetBid: async (_t: string, d: unknown) => d }));
vi.mock("../_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));

vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({
    cap: {
      enabled: true,
      max_daily_budget_usd: 100,
      max_pct_change_per_run: 0.5,
      max_daily_total_change_usd: 50,
    },
    today_total_change_usd: 0,
    currency: "USD",
    units_per_usd: 1,
  })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

import { metaProposeNewAdSetTool } from "../propose_new_ad_set";
import type { ToolContext } from "@/services/tools/types";

function makeCtx() {
  const emit = vi.fn(async () => "decision-id-123");
  const ctx: ToolContext = { tenant_id: "tenant-1", log: () => {}, emit_decision: emit };
  return { ctx, emit };
}

const VALID_PO = { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" };

const REAL_FAILED_ARGS = {
  campaign_id: "120252797821770059",
  name: "Turo Host Conquest — Fee Comparison",
  daily_budget_usd: 20,
  optimization_goal: "OFFSITE_CONVERSIONS",
  billing_event: "IMPRESSIONS",
  rationale: "Turo host conquest using verified fee-comparison",
  targeting: {
    age_min: 25,
    age_max: 55,
    flexible_spec: [{ interests: [{ name: "Turo" }, { name: "Car sharing" }] }],
    geo_locations: { regions: [{ key: "3847", name: "California" }] },
  },
};

describe("metaProposeNewAdSetTool — refuses at the PROPOSE boundary (zero emit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits ZERO decisions for the real prod body (no promoted_object + name-only interests)", async () => {
    const { ctx, emit } = makeCtx();
    await expect(metaProposeNewAdSetTool.execute(ctx, REAL_FAILED_ARGS)).rejects.toThrow(
      /cannot be created as specified/,
    );
    expect(emit).toHaveBeenCalledTimes(0);
  });

  it("names BOTH defects in one error, so the agent fixes them in one pass", async () => {
    const { ctx } = makeCtx();
    const err = await metaProposeNewAdSetTool
      .execute(ctx, REAL_FAILED_ARGS)
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/promoted_object/);
    expect(err?.message).toMatch(/interest id/);
    expect(err?.message).toMatch(/meta_ads_pixel_health|meta_ads_search_interests/);
  });

  it("emits ZERO for a conversion goal missing ONLY promoted_object", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      metaProposeNewAdSetTool.execute(ctx, {
        ...REAL_FAILED_ARGS,
        targeting: { geo_locations: { countries: ["US"] } },
      }),
    ).rejects.toThrow(/promoted_object/);
    expect(emit).toHaveBeenCalledTimes(0);
  });

  it("emits ZERO for name-only interests even on a NON-conversion goal", async () => {
    const { ctx, emit } = makeCtx();
    await expect(
      metaProposeNewAdSetTool.execute(ctx, {
        ...REAL_FAILED_ARGS,
        optimization_goal: "LINK_CLICKS",
      }),
    ).rejects.toThrow(/interest id/);
    expect(emit).toHaveBeenCalledTimes(0);
  });

  it("EMITS exactly once for a fully-grounded body — proves the guard is what refuses, not a broken tool", async () => {
    const { ctx, emit } = makeCtx();
    await metaProposeNewAdSetTool.execute(ctx, {
      ...REAL_FAILED_ARGS,
      promoted_object: VALID_PO,
      targeting: {
        geo_locations: { regions: [{ key: "3847", name: "California" }] },
        flexible_spec: [{ interests: [{ id: "6003107902433", name: "Turo" }] }],
      },
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("EMITS a non-conversion goal with no promoted_object (the guard is not over-broad)", async () => {
    const { ctx, emit } = makeCtx();
    await metaProposeNewAdSetTool.execute(ctx, {
      ...REAL_FAILED_ARGS,
      optimization_goal: "LINK_CLICKS",
      targeting: { geo_locations: { countries: ["US"] } },
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("carries promoted_object onto the EMITTED body (it must survive to the wire)", async () => {
    const { ctx, emit } = makeCtx();
    await metaProposeNewAdSetTool.execute(ctx, {
      ...REAL_FAILED_ARGS,
      promoted_object: VALID_PO,
      targeting: { geo_locations: { countries: ["US"] } },
    });
    const [, body] = emit.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const create = (body.create_ad_set ?? body) as Record<string, unknown>;
    expect(create.promoted_object).toEqual(VALID_PO);
  });
});
