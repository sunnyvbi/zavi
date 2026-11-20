
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
import { readTenantCapAndToday } from "../cap-reader";
import { metaProposeStatusChangeTool } from "../propose_status_change";
import type { ToolContext } from "@/services/tools/types";

type EmittedBody = { origin?: string; authorized_effective_cap?: unknown };

const STEERED = { budget: true, status: true };
const ASKED = { budget: false, status: false };

function makeCtx(rules_steered?: { budget: boolean; status: boolean }) {
  const emit = vi.fn<[string, unknown], Promise<string>>(async () => "decision-id-123");
  const ctx: ToolContext = {
    tenant_id: "tenant-1",
    log: () => {},
    emit_decision: emit,
    run_trigger: "chat",
    rules_steered,
  };
  return { ctx, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  userInitiatedEnabled.mockResolvedValue(true);
  cutGuardSpy.mockReturnValue(PASS);
});

const cut = {
  ad_set_id: "as1",
  current_daily_budget_usd: 40,
  proposed_daily_budget_usd: 30,
  rationale: "CTR under 1%",
  match_confidence: "exact" as const,
};

describe("propose_budget_change: a rule-steered chat run never applies on its own", () => {
  it("STEERED ('how are my ads doing?' + a cut rule): origin agent, review class, no user stamp", async () => {
    const { ctx, emit } = makeCtx(STEERED);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, cut)) as {
      origin: string;
      decision_class: string;
    };
    expect(out.origin).toBe("agent");
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.update_ad_set_budget_review");
    const body = emit.mock.calls[0]![1] as EmittedBody;
    expect(body.origin).toBeUndefined();
    expect(body.authorized_effective_cap).toBeUndefined();
  });

  it("NOT steered ('cut the weak ones now'): the founder's own command applies as today", async () => {
    const { ctx, emit } = makeCtx(ASKED);
    const out = (await metaProposeBudgetChangeTool.execute(ctx, cut)) as { origin: string };
    expect(out.origin).toBe("user_chat");
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.update_ad_set_budget");
    expect((emit.mock.calls[0]![1] as EmittedBody).origin).toBe("user_initiated_chat");
  });

  it("absent flag (no rules) is identical to not steered", async () => {
    const { ctx, emit } = makeCtx(undefined);
    await metaProposeBudgetChangeTool.execute(ctx, cut);
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.update_ad_set_budget");
  });

  it("STEERED under a configured cap: the within-cap agent auto-apply is forced to review", async () => {
    vi.mocked(readTenantCapAndToday).mockResolvedValueOnce({ cap: { enabled: true, max_daily_budget_usd: 1000, max_pct_change_per_run: null, max_daily_total_change_usd: 1000 }, today_total_change_usd: 0, cap_row_absent: false, currency: "USD", units_per_usd: 1 } as never);
    const { ctx, emit } = makeCtx(STEERED);
    await metaProposeBudgetChangeTool.execute(ctx, cut);
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.update_ad_set_budget_review");
  });

  it("control: the same agent-origin change under the cap auto-applies without rules", async () => {
    vi.mocked(readTenantCapAndToday).mockResolvedValueOnce({ cap: { enabled: true, max_daily_budget_usd: 1000, max_pct_change_per_run: null, max_daily_total_change_usd: 1000 }, today_total_change_usd: 0, cap_row_absent: false, currency: "USD", units_per_usd: 1 } as never);
    const { ctx, emit } = makeCtx(undefined);
    await metaProposeBudgetChangeTool.execute({ ...ctx, run_trigger: "cron" }, cut);
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.update_ad_set_budget");
  });

  it("a budget request does not authorize a pause (per-op)", async () => {
    const { ctx, emit } = makeCtx({ budget: false, status: true });
    await metaProposeStatusChangeTool.execute(ctx, {
      object_id: "as1", level: "adset", status: "PAUSED", rationale: "rule",
    });
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.set_status_review");
  });

  it("a model-supplied field in the tool input cannot clear it", async () => {
    const { ctx, emit } = makeCtx(STEERED);
    await metaProposeBudgetChangeTool.execute(ctx, { ...cut, rules_steered: false, origin: "user_chat" } as never);
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.update_ad_set_budget_review");
  });
});

describe("propose_status_change: a rule-steered PAUSE is not operator-directed and needs review", () => {
  const pause = { object_id: "as1", level: "adset" as const, status: "PAUSED" as const, rationale: "rule says so" };

  it("STEERED: cut guard consulted as agent-initiated, review class", async () => {
    const { ctx, emit } = makeCtx(STEERED);
    await metaProposeStatusChangeTool.execute(ctx, pause);
    expect(cutGuardSpy.mock.calls[0]![1]).toMatchObject({ operatorDirected: false });
    expect(emit.mock.calls[0]![0]).toBe("meta_ads.set_status_review");
  });

  it("NOT steered: unchanged (operatorDirected=true)", async () => {
    const { ctx } = makeCtx(ASKED);
    await metaProposeStatusChangeTool.execute(ctx, pause);
    expect(cutGuardSpy.mock.calls[0]![1]).toMatchObject({ operatorDirected: true });
  });
});
