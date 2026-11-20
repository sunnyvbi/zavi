
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

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import { metaProposeStatusChangeTool } from "../propose_status_change";
import { metaProposeNewAdSetTool } from "../propose_new_ad_set";
import type { ToolContext } from "@/services/tools/types";

function makeCtx() {
  const emit = vi.fn(async () => "decision-id-123");
  const ctx: ToolContext = {
    tenant_id: "tenant-1",
    log: () => {},
    emit_decision: emit,
  };
  return { ctx, emit };
}

describe("propose_budget_change — dry_run is a true no-op (zero emit)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("emits ZERO decisions and returns a simulation when dry_run=true", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 55,
      rationale: "scale the winner",
      dry_run: true,
    })) as { dry_run: boolean; simulation: { kind: string; within: boolean } };

    expect(emit).toHaveBeenCalledTimes(0);
    expect(out.dry_run).toBe(true);
    expect(out.simulation.kind).toBe("budget");
    expect(out.simulation.within).toBe(true);
  });

  it("DOES emit exactly once on the real (non-dry_run) path — proves the branch matters", async () => {
    const { ctx, emit } = makeCtx();
    await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 55,
      rationale: "scale the winner",
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("propose_status_change — dry_run is a true no-op (zero emit)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("emits ZERO decisions and flags reopens_spend on an ACTIVE dry_run", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await metaProposeStatusChangeTool.execute(ctx, {
      object_id: "obj1",
      level: "adset",
      status: "ACTIVE",
      rationale: "resume the paused winner",
      current_status: "PAUSED",
      dry_run: true,
    })) as { dry_run: boolean; simulation: { reopens_spend: boolean } };

    expect(emit).toHaveBeenCalledTimes(0);
    expect(out.dry_run).toBe(true);
    expect(out.simulation.reopens_spend).toBe(true);
  });

  it("DOES emit exactly once on the real path", async () => {
    const { ctx, emit } = makeCtx();
    await metaProposeStatusChangeTool.execute(ctx, {
      object_id: "obj1",
      level: "adset",
      status: "PAUSED",
      rationale: "pause overspender",
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("propose_new_ad_set — dry_run is a true no-op (zero emit)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("emits ZERO decisions and returns a create simulation", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await metaProposeNewAdSetTool.execute(ctx, {
      campaign_id: "c1",
      name: "new set",
      daily_budget_usd: 30,
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: { geo_locations: { countries: ["US"] } },
      rationale: "expand to a new audience",
      dry_run: true,
    })) as { dry_run: boolean; simulation: { kind: string; created_status: string } };

    expect(emit).toHaveBeenCalledTimes(0);
    expect(out.dry_run).toBe(true);
    expect(out.simulation.kind).toBe("create");
    expect(out.simulation.created_status).toBe("PAUSED");
  });

  it("does NOT throw on an over-cap dry_run — surfaces within=false instead", async () => {
    const { ctx, emit } = makeCtx();
    const out = (await metaProposeNewAdSetTool.execute(ctx, {
      campaign_id: "c1",
      name: "too big",
      daily_budget_usd: 200,
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: {},
      rationale: "big bet",
      dry_run: true,
    })) as { simulation: { within: boolean; reason: string } };

    expect(emit).toHaveBeenCalledTimes(0);
    expect(out.simulation.within).toBe(false);
    expect(out.simulation.reason).toBe("over_absolute_ceiling");
  });

  it("DOES emit exactly once on a within-cap real path", async () => {
    const { ctx, emit } = makeCtx();
    await metaProposeNewAdSetTool.execute(ctx, {
      campaign_id: "c1",
      name: "new set",
      daily_budget_usd: 30,
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: {},
      rationale: "expand",
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
