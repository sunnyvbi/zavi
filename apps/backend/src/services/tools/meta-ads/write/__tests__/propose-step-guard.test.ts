
import { describe, it, expect, vi, beforeEach } from "vitest";

const userInitiatedEnabled = vi.fn(async () => false);
const cgoBudget = vi.fn(async (): Promise<unknown> => null);
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: () => cgoBudget() }));

vi.mock("../_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));
vi.mock("../_user-initiated-flag-check", () => ({
  isUserInitiatedSpendApplyEnabled: () => userInitiatedEnabled(),
}));
vi.mock("../_grounding-guard", async () => {
  const actual = await vi.importActual<typeof import("../_grounding-guard")>(
    "../_grounding-guard",
  );
  return {
    ...actual,
    readRunToolNamesFromEvents: vi.fn(async () => [
      "meta_ads__pixel_health",
      "growth__diagnose_funnel",
    ]),
  };
});
vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({
    cap: {
      enabled: true,
      max_daily_budget_usd: 100_000,
      max_pct_change_per_run: null,
      max_daily_total_change_usd: null,
    },
    today_total_change_usd: 0,
    currency: "USD",
    units_per_usd: 1,
  })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import type { ToolContext } from "@/services/tools/types";

type EmittedBody = {
  origin?: string;
  authorized_effective_cap?: unknown;
  over_cap: boolean;
};

function makeCtx(run_trigger?: string) {
  const emit = vi.fn(async () => "decision-id-1");
  const ctx: ToolContext = {
    tenant_id: "tenant-1",
    log: () => {},
    emit_decision: emit,
    run_trigger,
  };
  return { ctx, emit };
}
function emittedBody(emit: { mock: { calls: unknown[][] } }): EmittedBody {
  return emit.mock.calls[0][1] as EmittedBody;
}

describe("propose_budget_change — learning-phase step guard (agent-initiated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInitiatedEnabled.mockResolvedValue(false);
  });

  it("delivering + >30% raise UNDER the dollar cap → FORCED to review (the core guarantee)", async () => {
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      rationale: "top ROAS line, scale hard",
      currently_delivering: true,
    })) as {
      decision_class: string;
      within_cap: boolean;
      forced_to_approval_by_step_guard: boolean;
      step_guard_reason: string | null;
    };

    expect(out.within_cap).toBe(true);
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.forced_to_approval_by_step_guard).toBe(true);
    expect(out.step_guard_reason).toBe("oversized_learning_phase_step");
  });

  it("delivering + within-step raise (+30%) under cap → stays AUTO (guard silent)", async () => {
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 130,
      rationale: "graduated scale step",
      currently_delivering: true,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.forced_to_approval_by_step_guard).toBe(false);
  });

  it("NON-delivering ad set + 2x raise → unaffected (stays auto under cap)", async () => {
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      rationale: "paused line, ramping back up",
      currently_delivering: false,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.forced_to_approval_by_step_guard).toBe(false);
  });

  it("delivering DECREASE → unaffected (cuts don't reset learning)", async () => {
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 30,
      rationale: "trim underperformer",
      currently_delivering: true,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.forced_to_approval_by_step_guard).toBe(false);
  });

  it("delivering oversized raise but JUSTIFIED → guard does not force (defers to normal routing; under cap → auto)", async () => {
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      rationale: "operator explicitly directed aggressive scale on this exited-learning winner",
      currently_delivering: true,
      oversized_step_justified: true,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };

    expect(out.forced_to_approval_by_step_guard).toBe(false);
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
  });
});

describe("propose_budget_change — step guard beats the user-chat fast-path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInitiatedEnabled.mockResolvedValue(true);
  });

  it("user typed a 2x on a DELIVERING ad set → guard forces review + does NOT stamp auto-apply authorization", async () => {
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      rationale: "double the gig rentals budget",
      match_confidence: "exact",
      currently_delivering: true,
    })) as {
      decision_class: string;
      origin: string;
      forced_to_approval_by_step_guard: boolean;
    };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.forced_to_approval_by_step_guard).toBe(true);

    const body = emittedBody(emit);
    expect(body.origin).toBeUndefined();
    expect(body.authorized_effective_cap).toBeUndefined();
  });

  it("user typed a within-step raise on a delivering ad set → fast-path still auto-applies (guard silent)", async () => {
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 120,
      rationale: "nudge the SF line up 20%",
      match_confidence: "exact",
      currently_delivering: true,
    })) as { decision_class: string; forced_to_approval_by_step_guard: boolean };

    expect(out.forced_to_approval_by_step_guard).toBe(false);
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(emittedBody(emit).origin).toBe("user_initiated_chat");
  });
});

describe("propose_budget_change: Autopilot with an ad budget (the CGO decides the raise)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInitiatedEnabled.mockResolvedValue(false);
    cgoBudget.mockResolvedValue(null);
  });

  const raise80 = {
    ad_set_id: "as1",
    current_daily_budget_usd: 100,
    proposed_daily_budget_usd: 180,
    rationale: "delivery is behind pace",
    currently_delivering: true,
  };

  it("raise +80% on Autopilot + budget -> normal class, so the CGO gate can approve it", async () => {
    cgoBudget.mockResolvedValue({ id: "b1" });
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raise80)) as { decision_class: string; forced_to_approval_by_step_guard: boolean };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.forced_to_approval_by_step_guard).toBe(false);
  });

  it("the same raise without an ad budget -> review class (unchanged)", async () => {
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raise80)) as { decision_class: string };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("the founder's own chat command keeps the guard even on Autopilot + budget", async () => {
    cgoBudget.mockResolvedValue({ id: "b1" });
    userInitiatedEnabled.mockResolvedValue(true);
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raise80)) as { decision_class: string };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(emittedBody(emit).origin).toBeUndefined();
  });

  it("a run that read a captured page still goes to review on Autopilot + budget", async () => {
    cgoBudget.mockResolvedValue({ id: "b1" });
    const { ctx } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute({ ...ctx, untrusted_context: true }, raise80)) as { decision_class: string };
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
  });
});
