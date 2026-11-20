
import { describe, it, expect, vi, beforeEach } from "vitest";

type CutVerdict = { block: boolean; reason: string; guidance: string };
const PASS: CutVerdict = { block: false, reason: "", guidance: "" };

const userInitiatedEnabled = vi.hoisted(() => vi.fn(async () => true));
const cutGuardSpy = vi.hoisted(() =>
  vi.fn<[unknown, { operatorDirected: boolean }], { block: boolean; reason: string; guidance: string }>(
    () => ({ block: false, reason: "", guidance: "" }),
  ),
);

vi.mock("../_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));
vi.mock("../_user-initiated-flag-check", () => ({
  isUserInitiatedSpendApplyEnabled: () => userInitiatedEnabled(),
}));
vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });
vi.mock("../_cut-guard", () => ({
  isCgoOriginatedRun: vi.fn(async () => false),
  evaluateCutGuard: (brief: unknown, opts: { operatorDirected: boolean }) =>
    cutGuardSpy(brief, opts),
  briefForAdSet: vi.fn(async () => ({
    funnel_label: "working",
    posture: "hold",
    settled_cutoff: "2026-09-01",
    maturing_days: 3,
    settled: true,
  })),
  briefForCampaign: vi.fn(async () => null),
}));

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import { metaProposeStatusChangeTool } from "../propose_status_change";
import type { ToolContext } from "@/services/tools/types";

type EmittedBody = { origin?: string; authorized_effective_cap?: unknown };

function makeCtx(untrusted_context?: boolean) {
  const emit = vi.fn<[string, unknown], Promise<string>>(async () => "decision-id-123");
  const ctx: ToolContext = {
    tenant_id: "tenant-1",
    log: () => {},
    emit_decision: emit,
    run_trigger: "chat",
    untrusted_context,
  };
  return { ctx, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  userInitiatedEnabled.mockResolvedValue(true);
  cutGuardSpy.mockReturnValue(PASS);
});

describe("propose_budget_change — a tainted chat run is NOT user_chat", () => {
  const raise = {
    ad_set_id: "as1",
    current_daily_budget_usd: 40,
    proposed_daily_budget_usd: 80,
    rationale: "double it",
    match_confidence: "exact" as const,
  };

  it("TAINTED chat run: origin is 'agent', no spend auto-apply, no authorized cap stamped", async () => {
    const { ctx, emit } = makeCtx(true);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raise)) as {
      origin: string;
      decision_class: string;
    };

    expect(out.origin).toBe("agent");
    const body = emit.mock.calls[0]![1] as EmittedBody;
    expect(body.origin).toBeUndefined();
    expect(body.authorized_effective_cap).toBeUndefined();
  });

  it("UNTAINTED chat run still gets user_chat + the authorized cap (narrowed, not broken)", async () => {
    const { ctx, emit } = makeCtx(undefined);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raise)) as { origin: string };

    expect(out.origin).toBe("user_chat");
    const body = emit.mock.calls[0]![1] as EmittedBody;
    expect(body.origin).toBe("user_initiated_chat");
    expect(body.authorized_effective_cap).toBeDefined();
  });

  it("explicit untrusted_context:false is identical to absent", async () => {
    const { ctx } = makeCtx(false);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, raise)) as { origin: string };
    expect(out.origin).toBe("user_chat");
  });

  it("the taint is SERVER-side only — a model-supplied field in the tool input cannot clear it", async () => {
    const { ctx } = makeCtx(true);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ...raise,
      untrusted_context: false,
      run_trigger: "chat",
      origin: "user_chat",
    } as never)) as { origin: string };
    expect(out.origin).toBe("agent");
  });
});

describe("propose_status_change — a tainted PAUSE is NOT operator-directed", () => {
  const pause = {
    object_id: "as1",
    level: "adset" as const,
    status: "PAUSED" as const,
    rationale: "pause it",
  };

  it("TAINTED chat run: the cut guard is consulted with operatorDirected=false", async () => {
    const { ctx } = makeCtx(true);
    await metaProposeStatusChangeTool.execute(ctx, pause);

    expect(cutGuardSpy).toHaveBeenCalledTimes(1);
    expect(cutGuardSpy.mock.calls[0]![1]).toMatchObject({ operatorDirected: false });
  });

  it("UNTAINTED chat run still relaxes the guard (operatorDirected=true)", async () => {
    const { ctx } = makeCtx(undefined);
    await metaProposeStatusChangeTool.execute(ctx, pause);

    expect(cutGuardSpy).toHaveBeenCalledTimes(1);
    expect(cutGuardSpy.mock.calls[0]![1]).toMatchObject({ operatorDirected: true });
  });

  it("a tainted PAUSE the guard blocks is refused, exactly like an agent-initiated one", async () => {
    cutGuardSpy.mockReturnValue({
      block: true,
      reason: "ad_is_working",
      guidance: "investigate the funnel instead",
    });
    const { ctx, emit } = makeCtx(true);
    const out = (await metaProposeStatusChangeTool.execute(ctx, pause)) as {
      blocked?: boolean;
      code?: string;
    };

    expect(out.blocked).toBe(true);
    expect(out.code).toBe("ad_is_working");
    expect(emit).not.toHaveBeenCalled();
  });
});
