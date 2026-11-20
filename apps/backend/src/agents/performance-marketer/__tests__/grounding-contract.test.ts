
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));
vi.mock("@/services/tools/meta-ads/write/_user-initiated-flag-check", () => ({
  isUserInitiatedSpendApplyEnabled: vi.fn(async () => false),
}));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({
  readTenantCapAndToday: vi.fn(async () => ({
    cap: { enabled: true, max_daily_change_usd: 100000, max_pct_change: 10, max_aggregate_daily_usd: 100000 },
    today_total_change_usd: 0,
    currency: "USD",
    units_per_usd: 1,
  })),
}));
vi.mock("@/services/tools/meta-ads/write/_cut-guard", async () => ({
  ...(await vi.importActual<typeof import("@/services/tools/meta-ads/write/_cut-guard")>(
    "@/services/tools/meta-ads/write/_cut-guard",
  )),
  isCgoOriginatedRun: vi.fn(async () => false),
}));
vi.mock("@/services/tools/meta-ads/write/_grounding-guard", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/tools/meta-ads/write/_grounding-guard")
  >("@/services/tools/meta-ads/write/_grounding-guard");
  return {
    ...actual,
    readRunToolNamesFromEvents: vi.fn(),
  };
});

import {
  hasGroundingTools,
  evaluateGroundingContract,
  readRunToolNamesFromEvents,
} from "@/services/tools/meta-ads/write/_grounding-guard";
import { metaProposeBudgetChangeTool } from "@/services/tools/meta-ads/write/propose_budget_change";

const readNames = readRunToolNamesFromEvents as unknown as ReturnType<typeof vi.fn>;

describe("grounding-guard pure detector", () => {
  it("grounded = pixel_health AND one secondary read", () => {
    expect(
      hasGroundingTools(["meta_ads__pixel_health", "growth__diagnose_funnel"]),
    ).toBe(true);
    expect(
      hasGroundingTools(["meta_ads__pixel_health", "growth__read_cohort"]),
    ).toBe(true);
    expect(
      hasGroundingTools([
        "meta_ads__pixel_health",
        "growth__read_verified_bookings_by_campaign",
      ]),
    ).toBe(true);
  });

  it("NOT grounded with pixel_health alone (no secondary)", () => {
    expect(hasGroundingTools(["meta_ads__pixel_health"])).toBe(false);
  });

  it("NOT grounded with a secondary but no pixel_health", () => {
    expect(hasGroundingTools(["growth__diagnose_funnel"])).toBe(false);
  });

  it("tolerant to separator/prefix variants", () => {
    expect(hasGroundingTools(["meta_ads_pixel_health", "diagnose_funnel"])).toBe(
      true,
    );
  });

  it("a scale rec WITHOUT grounding fails the contract → route to approval", () => {
    const r = evaluateGroundingContract({
      recommendedAction: true,
      groundingToolsCalled: false,
    });
    expect(r.grounding_contract_failed).toBe(true);
    expect(r.route_to_approval).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it("a grounded scale rec passes the contract", () => {
    const r = evaluateGroundingContract({
      recommendedAction: true,
      groundingToolsCalled: true,
    });
    expect(r.grounding_contract_failed).toBe(false);
    expect(r.route_to_approval).toBe(false);
  });

  it("no recommended action ⇒ contract not engaged", () => {
    const r = evaluateGroundingContract({
      recommendedAction: false,
      groundingToolsCalled: false,
    });
    expect(r.grounding_contract_failed).toBe(false);
  });
});

describe("propose_budget_change grounding enforcement (routing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCtx(emitted: { cls: string; body: unknown }[]) {
    return {
      tenant_id: "tenant-A",
      run_id: "run-1",
      run_trigger: "cron",
      log: () => {},
      emit_decision: vi.fn(async (cls: string, body: unknown) => {
        emitted.push({ cls, body });
        return "decision-1";
      }),
    };
  }

  const raiseInput = {
    ad_set_id: "123",
    current_daily_budget_usd: 50,
    proposed_daily_budget_usd: 60,
    name: "Gig Rentals Purchase",
    about: "Purchase-objective line.",
    rationale: "ROAS 3.1 over 30d on n=14 purchases; small graduated raise.",
    currently_delivering: true,
  };

  it("ungrounded within-cap RAISE is FORCE-ROUTED to approval (review class)", async () => {
    readNames.mockResolvedValueOnce([
      "meta_ads__list_campaigns",
      "meta_ads__list_ad_sets",
    ]);
    const emitted: { cls: string; body: unknown }[] = [];
    const ctx = makeCtx(emitted);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raiseInput)) as {
      decision_class: string;
      forced_to_approval_by_grounding: boolean;
    };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.forced_to_approval_by_grounding).toBe(true);
    expect(emitted[0].cls).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("GROUNDED within-cap RAISE auto-applies (routing UNCHANGED)", async () => {
    readNames.mockResolvedValueOnce([
      "meta_ads__pixel_health",
      "growth__diagnose_funnel",
      "meta_ads__list_ad_sets",
    ]);
    const emitted: { cls: string; body: unknown }[] = [];
    const ctx = makeCtx(emitted);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raiseInput)) as {
      decision_class: string;
      forced_to_approval_by_grounding: boolean;
    };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.forced_to_approval_by_grounding).toBe(false);
  });

  it("FAIL-CLOSED: an errored/empty trace (null) routes to approval", async () => {
    readNames.mockResolvedValueOnce(null);
    const emitted: { cls: string; body: unknown }[] = [];
    const ctx = makeCtx(emitted);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raiseInput)) as {
      decision_class: string;
      forced_to_approval_by_grounding: boolean;
    };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.forced_to_approval_by_grounding).toBe(true);
  });

  it("a DECREASE is never grounding-gated (guard silent)", async () => {
    const emitted: { cls: string; body: unknown }[] = [];
    const ctx = makeCtx(emitted);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ...raiseInput,
      proposed_daily_budget_usd: 30,
    })) as { decision_class: string; forced_to_approval_by_grounding: boolean };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.forced_to_approval_by_grounding).toBe(false);
    expect(readNames).not.toHaveBeenCalled();
  });
});
