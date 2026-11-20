import { describe, it, expect, vi } from "vitest";
import {
  planBestOfN,
  selectBest,
  isDraftDeniedTool,
  runBestOfN,
  estimateCandidateCostUsd,
  type RunBestOfNDeps,
} from "../best-of-n";
import {
  BEST_OF_N_OFF,
  type BestOfNPolicy,
} from "../_best-of-n-flag-check";
import type {
  AgentContext,
  DispatcherResult,
} from "../types";

const consumeBudgetOrReject = vi.fn(
  async (_input: { tenant_id: string; estimate: number; dailyCap: number; day?: string }) => true,
);
const resolveDailyCapUsd = vi.fn(async (_tenantId?: string) => 100);
vi.mock("../budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../budget")>();
  return {
    ...actual,
    consumeBudgetOrReject: (input: Parameters<typeof consumeBudgetOrReject>[0]) =>
      consumeBudgetOrReject(input),
    resolveDailyCapUsd: (tenantId?: string) => resolveDailyCapUsd(tenantId),
  };
});

function result(overrides: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "",
    parsed: null,
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    tool_calls: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: "t-1",
    runId: "r-1",
    agent: {
      slug: "performance-marketer",
      metadata_praxis: { cost_class: "standard" },
    },
    emitDecision: vi.fn(async () => "real-decision-id"),
    emitProgress: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AgentContext;
}

const ON_N3: BestOfNPolicy = {
  enabled: true,
  n: 3,
  nightlyMaxCandidates: 0,
  concurrency: 0,
  kill: false,
};

function makeDeps(over: Partial<RunBestOfNDeps> = {}): RunBestOfNDeps {
  return {
    runOnce: vi.fn(async (_c: AgentContext, _p?: unknown) => result()),
    makeDraftCtx: (c) =>
      ({ ...c, draft_mode: true, emitDecision: vi.fn(async () => "noop"), emitProgress: vi.fn(async () => {}) }) as AgentContext,
    readNightlyConsumed: vi.fn(async () => 0),
    ...over,
  };
}

describe("isDraftDeniedTool — draft write-deny classifier (contract 2b)", () => {
  it("DENIES every side-effecting connector/write tool", () => {
    for (const t of [
      "praxis__action",
      "memory__write",
      "meta_ads_propose_budget_change",
      "meta_ads_set_status",
      "update_ad_set_budget",
      "create_ad_set",
      "github__create_pr",
      "github__update_file",
      "slack__post_message",
      "slack__send_message",
      "stripe__create_refund",
      "stripe__submit_dispute_evidence",
      "jira__transition",
      "jira__add_comment",
      "mcp__server__memory__write",
      "mcp__server__meta_ads_propose_budget_change",
    ]) {
      expect(isDraftDeniedTool(t), `${t} should be denied`).toBe(true);
    }
  });

  it("ALLOWS read tools (a draft still gathers evidence)", () => {
    for (const t of [
      "memory__search",
      "meta_ads__list_campaigns",
      "operator_db__query",
      "web_fetch__fetch",
      "github__search_code",
      "mcp__sandbox__read_file",
      "mcp__sandbox__git_status",
    ]) {
      expect(isDraftDeniedTool(t), `${t} should be allowed`).toBe(false);
    }
  });
});

describe("planBestOfN — N-aware budget plan (contract 2c)", () => {
  it("flag OFF / kill / N<=1 → N=1, zero reservation, 'disabled'", () => {
    expect(planBestOfN({ policy: BEST_OF_N_OFF, candidateCostUsd: 0.1, nightlyConsumed: 0 }))
      .toEqual({ n: 1, extraReservationUsd: 0, outcome: "disabled" });
    expect(
      planBestOfN({ policy: { ...ON_N3, kill: true }, candidateCostUsd: 0.1, nightlyConsumed: 0 }),
    ).toEqual({ n: 1, extraReservationUsd: 0, outcome: "disabled" });
    expect(
      planBestOfN({ policy: { ...ON_N3, n: 1 }, candidateCostUsd: 0.1, nightlyConsumed: 0 }),
    ).toEqual({ n: 1, extraReservationUsd: 0, outcome: "disabled" });
  });

  it("SAFETY: reserves (N-1) × per-candidate cost for the extra drafts", () => {
    const plan = planBestOfN({ policy: ON_N3, candidateCostUsd: 0.1, nightlyConsumed: 0 });
    expect(plan.n).toBe(3);
    expect(plan.extraReservationUsd).toBeCloseTo(0.2, 10);
    expect(plan.outcome).toBe("ran");
  });

  it("nightly cap exhausted → falls back to N=1", () => {
    const plan = planBestOfN({
      policy: { ...ON_N3, nightlyMaxCandidates: 5 },
      candidateCostUsd: 0.1,
      nightlyConsumed: 5,
    });
    expect(plan.n).toBe(1);
    expect(plan.outcome).toBe("disabled");
  });

  it("nightly cap PARTIALLY exhausted → clamps N down to remaining headroom", () => {
    const plan = planBestOfN({
      policy: { ...ON_N3, nightlyMaxCandidates: 5, n: 4 },
      candidateCostUsd: 0.1,
      nightlyConsumed: 4,
    });
    expect(plan.n).toBe(2);
    expect(plan.extraReservationUsd).toBeCloseTo(0.1, 10);
    expect(plan.outcome).toBe("ran");
  });
});

describe("selectBest — winner = highest ①C atom-score (contract 2 receipt)", () => {
  it("picks the candidate whose money claim is grounded in its own tool output", () => {
    const a = result({
      output_text: "We should set the cap at $50.",
      tool_calls: [],
    });
    const b = result({
      output_text: "We should set the cap at $50.",
      tool_calls: [
        { name: "meta_ads__list", input_preview: "", output_preview: '{"daily_budget_usd":50}', ms: 1, status: "ok" },
      ] as DispatcherResult["tool_calls"],
    });
    const { winnerIndex } = selectBest([a, b]);
    expect(winnerIndex).toBe(1);
  });

  it("ties resolve to the FIRST (base) candidate — deterministic, never picks worse", () => {
    const a = result({ output_text: "Same prose with no numbers here please." });
    const b = result({ output_text: "Same prose with no numbers here please." });
    expect(selectBest([a, b]).winnerIndex).toBe(0);
  });

  it("all-empty field → index 0", () => {
    expect(selectBest([result(), result(), result()]).winnerIndex).toBe(0);
  });
});

describe("runBestOfN — orchestrator safety properties (contract 2)", () => {
  it("SAFETY (a): flag OFF = ONE runOnce call with the REAL ctx, byte-identical result", async () => {
    consumeBudgetOrReject.mockClear();
    const fixed = result({ output_text: "FIXED", parsed: { decision: "x" }, parse_ok: true });
    const runOnce = vi.fn(async (_c: AgentContext, _p?: unknown) => fixed);
    const deps = makeDeps({ runOnce });
    const out = await runBestOfN(ctx(), { ask: "hi" }, deps, BEST_OF_N_OFF);

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect((runOnce.mock.calls[0][0] as AgentContext).draft_mode).toBeUndefined();
    expect(out).toBe(fixed);
    expect(consumeBudgetOrReject).not.toHaveBeenCalled();
  });

  it("SAFETY (b): losing candidates run with a DRAFT ctx; ONLY the base/winner uses the real ctx", async () => {
    consumeBudgetOrReject.mockResolvedValue(true);
    const realCtxSeen: boolean[] = [];
    const runOnce = vi.fn(async (c: AgentContext) => {
      const isDraft = c.draft_mode === true;
      realCtxSeen.push(!isDraft);
      return result({
        output_text: "cap $50",
        tool_calls: isDraft
          ? []
          : ([{ name: "t", input_preview: "", output_preview: '{"daily_budget_usd":50}', ms: 1, status: "ok" }] as DispatcherResult["tool_calls"]),
      });
    });
    const deps = makeDeps({ runOnce });
    await runBestOfN(ctx(), {}, deps, ON_N3);

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(realCtxSeen.filter(Boolean).length).toBe(1);
    expect(realCtxSeen.filter((x) => !x).length).toBe(2);
  });

  it("SAFETY (b'): a winning DRAFT candidate is RE-RUN on the real ctx — losers never reach emit", async () => {
    consumeBudgetOrReject.mockResolvedValue(true);
    let call = 0;
    const runOnce = vi.fn(async (c: AgentContext) => {
      const isDraft = c.draft_mode === true;
      const idx = call++;
      const grounded = isDraft && idx === 1;
      return result({
        output_text: "cap $50",
        tool_calls: grounded
          ? ([{ name: "t", input_preview: "", output_preview: '{"daily_budget_usd":50}', ms: 1, status: "ok" }] as DispatcherResult["tool_calls"])
          : [],
      });
    });
    const deps = makeDeps({ runOnce });
    await runBestOfN(ctx(), {}, deps, ON_N3);

    expect(runOnce).toHaveBeenCalledTimes(4);
    const lastCtx = runOnce.mock.calls[runOnce.mock.calls.length - 1][0] as AgentContext;
    expect(lastCtx.draft_mode).toBeUndefined();
  });

  it("SAFETY (c): reserves N× (the extra drafts) via the atomic budget RPC", async () => {
    consumeBudgetOrReject.mockClear();
    consumeBudgetOrReject.mockResolvedValue(true);
    const deps = makeDeps();
    await runBestOfN(ctx(), {}, deps, ON_N3);

    expect(consumeBudgetOrReject).toHaveBeenCalledTimes(1);
    const arg = consumeBudgetOrReject.mock.calls[0][0] as { estimate: number; tenant_id: string };
    expect(arg.estimate).toBeCloseTo(2 * estimateCandidateCostUsd("standard"), 10);
    expect(arg.tenant_id).toBe("t-1");
  });

  it("SAFETY (c'): budget DENIED → best_of_n_skipped_budget, single real run, NO fan-out", async () => {
    consumeBudgetOrReject.mockClear();
    consumeBudgetOrReject.mockResolvedValue(false);
    const telemetry = vi.fn();
    const runOnce = vi.fn(async (_c: AgentContext, _p?: unknown) => result());
    const deps = makeDeps({ runOnce, emitTelemetry: telemetry });
    await runBestOfN(ctx(), {}, deps, ON_N3);

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect((runOnce.mock.calls[0][0] as AgentContext).draft_mode).toBeUndefined();
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "best_of_n_skipped_budget", n: 1 }),
    );
  });

  it("kill switch forces N=1 even when enabled (budget-pressure brake)", async () => {
    consumeBudgetOrReject.mockClear();
    const runOnce = vi.fn(async (_c: AgentContext, _p?: unknown) => result());
    const deps = makeDeps({ runOnce });
    await runBestOfN(ctx(), {}, deps, { ...ON_N3, kill: true });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(consumeBudgetOrReject).not.toHaveBeenCalled();
  });
});
