
import { describe, it, expect, vi, beforeEach } from "vitest";

const userInitiatedEnabled = vi.fn(async () => true);

vi.mock("../_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));
vi.mock("../_user-initiated-flag-check", () => ({
  isUserInitiatedSpendApplyEnabled: () => userInitiatedEnabled(),
}));
vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

import { metaProposeBudgetChangeTool } from "../propose_budget_change";
import { readTenantCapAndToday } from "../cap-reader";
import type { ToolContext } from "@/services/tools/types";

type EmittedBody = {
  ad_set_id: string;
  daily_budget_usd: number;
  over_cap: boolean;
  origin?: string;
  authorized_effective_cap?: unknown;
};

function makeCtx(run_trigger?: string) {
  const emit = vi.fn(async () => "decision-id-123");
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

describe("propose_budget_change — user-chat fast-path (flag ON)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInitiatedEnabled.mockResolvedValue(true);
  });

  it("user_chat + exact + normal double → auto class, stamps origin + authorized cap on a NO-CAP tenant", async () => {
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 80,
      rationale: "operator typed: double it",
      match_confidence: "exact",
    })) as { decision_class: string; origin: string; agent_unsure: boolean };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    expect(out.origin).toBe("user_chat");
    expect(out.agent_unsure).toBe(false);

    const body = emittedBody(emit);
    expect(body.origin).toBe("user_initiated_chat");
    expect(body.authorized_effective_cap).toEqual({
      enabled: true,
      max_daily_budget_usd: 10_000,
      max_pct_change_per_run: 50,
    });
  });

  it("AMBIGUOUS match (match_confidence absent) → review, NO origin/cap stamped (gate, don't move money)", async () => {
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 80,
      rationale: "double the gig rentals budget",
    })) as { decision_class: string; agent_unsure: boolean; agent_unsure_reason: string };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.agent_unsure).toBe(true);
    expect(out.agent_unsure_reason).toBe("ambiguous_match");

    const body = emittedBody(emit);
    expect(body.origin).toBeUndefined();
    expect(body.authorized_effective_cap).toBeUndefined();
    expect((body as Record<string, unknown>).match_unsure).toBeUndefined();
  });

  it("an EXPLICIT ambiguous match in chat stamps match_unsure, so only that card asks which campaign (bug #13)", async () => {
    const { ctx, emit } = makeCtx("chat");
    await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 80,
      rationale: "two ad sets share that name",
      match_confidence: "ambiguous",
    });
    expect((emittedBody(emit) as Record<string, unknown>).match_unsure).toBe("ambiguous_match");
  });

  it("must not touch: a scheduled run's ambiguous proposal never stamps match_unsure", async () => {
    const { ctx, emit } = makeCtx("cron");
    await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 44,
      rationale: "agent's own move",
      match_confidence: "ambiguous",
    });
    expect((emittedBody(emit) as Record<string, unknown>).match_unsure).toBeUndefined();
  });

  it("FAT-FINGER ratio (11x) with exact match → review, NO cap stamped", async () => {
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 10,
      proposed_daily_budget_usd: 110,
      rationale: "set to 110",
      match_confidence: "exact",
    })) as { decision_class: string; agent_unsure_reason: string };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.agent_unsure_reason).toBe("misparse_ratio");
    expect(emittedBody(emit).authorized_effective_cap).toBeUndefined();
  });

  it("C8 — a model-supplied origin / authorized_effective_cap / trigger in tool INPUT is IGNORED", async () => {
    const { ctx, emit } = makeCtx("chat");
    await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 80,
      rationale: "double it",
      match_confidence: "exact",
      origin: "agent",
      trigger: "cron",
      authorized_effective_cap: { enabled: true, max_daily_budget_usd: 999999, max_pct_change_per_run: 999 },
    } as never);

    const body = emittedBody(emit);
    expect(body.origin).toBe("user_initiated_chat");
    expect(body.authorized_effective_cap).toEqual({
      enabled: true,
      max_daily_budget_usd: 10_000,
      max_pct_change_per_run: 50,
    });
  });

  it("non-chat origin (trigger='cron') NEVER gets origin/authorized cap even with the flag on + exact match", async () => {
    const { ctx, emit } = makeCtx("cron");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 80,
      rationale: "scheduled rebalance",
      match_confidence: "exact",
    })) as { origin: string };

    expect(out.origin).toBe("agent");
    const body = emittedBody(emit);
    expect(body.origin).toBeUndefined();
    expect(body.authorized_effective_cap).toBeUndefined();
  });
});

describe("propose_budget_change — flag OFF is byte-identical to pre-feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInitiatedEnabled.mockResolvedValue(false);
  });

  it("user_chat + exact, flag OFF → routes by within-cap (no cap ⇒ review), NO origin/cap stamped", async () => {
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 80,
      rationale: "double it",
      match_confidence: "exact",
    })) as { decision_class: string; origin: string };

    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(out.origin).toBe("agent");

    const body = emittedBody(emit);
    expect(body.origin).toBeUndefined();
    expect(body.authorized_effective_cap).toBeUndefined();
    expect(body.over_cap).toBe(true);
  });
});

describe("propose_budget_change — an INR ad account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userInitiatedEnabled.mockResolvedValue(true);
  });
  const inrAccount = () =>
    vi.mocked(readTenantCapAndToday).mockResolvedValueOnce({
      cap: null,
      today_total_change_usd: 0,
      cap_row_absent: true,
      currency: "INR",
      units_per_usd: 80,
    });

  it("stamps INR on the body, and ₹24,000/day ($300) is not a fat-finger", async () => {
    inrAccount();
    const { ctx, emit } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 16_000,
      proposed_daily_budget_usd: 24_000,
      rationale: "operator typed: raise it to 24000",
      match_confidence: "exact",
    })) as { decision_class: string; agent_unsure: boolean };

    expect(out.agent_unsure).toBe(false);
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget");
    const body = emittedBody(emit) as EmittedBody & { currency?: string };
    expect(body.currency).toBe("INR");
    expect(body.daily_budget_usd).toBe(24_000);
  });

  it("still catches a fat-finger: ₹9,00,000/day is over the $10,000 bound", async () => {
    inrAccount();
    const { ctx } = makeCtx("chat");
    const out = (await metaProposeBudgetChangeTool.execute(ctx, {
      ad_set_id: "as1",
      current_daily_budget_usd: 160_000,
      proposed_daily_budget_usd: 900_000,
      rationale: "set to 900000",
      match_confidence: "exact",
    })) as { decision_class: string; agent_unsure_reason: string };

    expect(out.agent_unsure_reason).toBe("misparse_absolute");
    expect(out.decision_class).toBe("meta_ads.update_ad_set_budget_review");
  });
});
