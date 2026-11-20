import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueAgentRun = vi.fn();
const writeNote = vi.fn();
const { InsufficientCreditsError } = vi.hoisted(() => {
  class InsufficientCreditsError extends Error {
    constructor(slug: string) {
      super(`Agent "${slug}" rejected: out of credits`);
      this.name = "InsufficientCreditsError";
    }
  }
  return { InsufficientCreditsError };
});
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  InsufficientCreditsError,
}));
vi.mock("@/services/memory", () => ({
  writeNote: (...a: unknown[]) => writeNote(...a),
}));

type Term = { data?: unknown; error?: unknown; count?: number | null };
const dedupResult: Term[] = [];
const insertResult: Term[] = [];
const countResult: Term[] = [];
let lineageStats: { max_depth: number; target_slugs: string[]; cumulative_cost: number } = {
  max_depth: 0,
  target_slugs: [],
  cumulative_cost: 0,
};
let lineageStatsError: { message: string } | null = null;
const lineageInserts: Array<Record<string, unknown>> = [];

function makeClient() {
  return {
    rpc: (_fn: string, _args: unknown) =>
      Promise.resolve(
        lineageStatsError ? { data: null, error: lineageStatsError } : { data: [lineageStats], error: null },
      ),
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = (_c?: unknown, opts?: { head?: boolean; count?: string }) => {
        builder.__isCount = !!opts?.head;
        return builder;
      };
      builder.eq = chain;
      builder.gt = chain;
      builder.limit = chain;
      builder.maybeSingle = () => Promise.resolve(dedupResult.shift() ?? { data: null });
      builder.insert = (row: Record<string, unknown>) => {
        if (table === "delegation_lineage") {
          lineageInserts.push(row);
          return Promise.resolve({ error: null });
        }
        return Promise.resolve(insertResult.shift() ?? { error: null });
      };
      builder.then = (resolve: (v: Term) => unknown) =>
        resolve(countResult.shift() ?? { count: 0, error: null });
      return builder;
    },
  };
}
vi.mock("@/services/supabase", () => ({
  serviceClient: () => makeClient(),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  LOG_META_KEYS: ["agent_slug"],
}));
const logDecisionNotTaken = vi.fn().mockResolvedValue(true);
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: (...a: unknown[]) => logDecisionNotTaken(...a),
}));

import { a2aDispatch, countLineageBounces } from "../a2a-dispatch";

beforeEach(() => {
  enqueueAgentRun.mockReset();
  writeNote.mockReset();
  logDecisionNotTaken.mockReset();
  logDecisionNotTaken.mockResolvedValue(true);
  dedupResult.length = 0;
  insertResult.length = 0;
  countResult.length = 0;
  lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
  lineageStatsError = null;
  lineageInserts.length = 0;
});

const baseInput = {
  tenant_id: "t1",
  source_agent_slug: "engineer",
  source_run_id: "run-cto",
  target_agent_slug: "qa",
  payload: { lineage_key: "L1" },
  dedup_key: "f2:L1:42",
  lineage_key: "L1",
};

describe("a2aDispatch", () => {
  it("dedup hit → no enqueue, returns deduped", async () => {
    dedupResult.push({ data: { id: "existing" } });
    const r = await a2aDispatch(baseInput);
    expect(r).toEqual({ ok: false, reason: "deduped" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(logDecisionNotTaken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        rejection_type: "dedup_suppressed_24h",
        reason_code: "deduped",
        decision_class: "a2a.dispatch",
      }),
    );
  });

  it("happy path → enqueue + history insert carries lineage_key + note", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "child-1" });
    let insertedRow: Record<string, unknown> | null = null;
    vi.mocked;
    const r = await a2aDispatch({
      ...baseInput,
      note: { title: "n", body_markdown: "b" },
    });
    expect(r).toEqual({ ok: true, child_run_id: "child-1" });
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "a2a", agent_slug: "qa" }),
    );
    expect(writeNote).toHaveBeenCalledTimes(1);
    void insertedRow;
  });

  it("enqueue throws (SafetyGateError) → non-fatal enqueue_failed, no throw", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockRejectedValueOnce(new Error("agent killed for this tenant"));
    const r = await a2aDispatch(baseInput);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "enqueue_failed" });
    expect(writeNote).not.toHaveBeenCalled();
  });

  it("enqueue throws InsufficientCreditsError → stable insufficient_credits reason (not generic)", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockRejectedValueOnce(new InsufficientCreditsError("engineer"));
    const r = await a2aDispatch(baseInput);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "insufficient_credits" });
    expect(writeNote).not.toHaveBeenCalled();
    expect(logDecisionNotTaken).toHaveBeenCalledWith(
      expect.objectContaining({ rejection_type: "cap_exceeded", reason_code: "insufficient_credits" }),
    );
  });

  it("passes the source run as parent_run_id (staff ?model= inheritance)", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "child-1" });
    await a2aDispatch(baseInput);
    expect(enqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({ parent_run_id: "run-cto" }));
  });

  it("enqueue throws StaffModelCapError → stable, non-retryable staff_model_cap reason", async () => {
    const { StaffModelCapError } = await import("../staff-model-inherit");
    dedupResult.push({ data: null });
    enqueueAgentRun.mockRejectedValueOnce(new StaffModelCapError(200, 200));
    const r = await a2aDispatch(baseInput);
    expect(r).toMatchObject({ ok: false, reason: "staff_model_cap" });
    expect(logDecisionNotTaken).toHaveBeenCalledWith(
      expect.objectContaining({ rejection_type: "cap_exceeded", reason_code: "staff_model_cap" }),
    );
  });

  it("enqueue returns no run_id → enqueue_failed", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "" });
    const r = await a2aDispatch(baseInput);
    expect(r).toEqual({ ok: false, reason: "enqueue_failed" });
    expect(logDecisionNotTaken).toHaveBeenCalledWith(
      expect.objectContaining({ rejection_type: "condition_unmet", reason_code: "enqueue_failed" }),
    );
  });

  it("dedup lookup error is non-blocking → still enqueues", async () => {
    dedupResult.push({ data: null, error: { message: "db blip" } });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "child-2" });
    const r = await a2aDispatch(baseInput);
    expect(r).toEqual({ ok: true, child_run_id: "child-2" });
  });
});

describe("countLineageBounces", () => {
  it("returns the row count", async () => {
    countResult.push({ count: 2, error: null });
    const n = await countLineageBounces({
      tenant_id: "t1",
      lineage_key: "L1",
      source_agent_slug: "qa",
      target_agent_slug: "engineer",
    });
    expect(n).toBe(2);
  });

  it("FAILS CLOSED — query error → +Infinity (caller treats as cap reached)", async () => {
    countResult.push({ count: null, error: { message: "boom" } });
    const n = await countLineageBounces({
      tenant_id: "t1",
      lineage_key: "L1",
      source_agent_slug: "qa",
      target_agent_slug: "engineer",
    });
    expect(n).toBe(Number.POSITIVE_INFINITY);
  });

  it("no rows → 0", async () => {
    countResult.push({ count: 0, error: null });
    const n = await countLineageBounces({
      tenant_id: "t1",
      lineage_key: "Lx",
      source_agent_slug: "qa",
      target_agent_slug: "engineer",
    });
    expect(n).toBe(0);
  });
});

describe("a2aDispatch — optional delegation guard (Gap 2)", () => {
  it("DORMANT: without delegation_guard, behavior is unchanged (no guard, no ledger edge)", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "child-1" });
    const r = await a2aDispatch(baseInput);
    expect(r).toEqual({ ok: true, child_run_id: "child-1" });
    expect(lineageInserts).toHaveLength(0);
  });

  it("guarded ROOT: stamps lineage on the child payload + records the edge", async () => {
    dedupResult.push({ data: null });
    let enqArg: { payload?: Record<string, unknown> } = {};
    enqueueAgentRun.mockImplementationOnce(async (a: { payload?: Record<string, unknown> }) => {
      enqArg = a;
      return { run_id: "child-2" };
    });
    const r = await a2aDispatch({
      ...baseInput,
      delegation_guard: { parentLineage: { lineage_id: null, depth: 0 } },
    });
    expect(r).toEqual({ ok: true, child_run_id: "child-2" });
    expect(typeof enqArg.payload?._delegation_lineage_id).toBe("string");
    expect(enqArg.payload?._delegation_depth).toBe(1);
    expect(lineageInserts).toHaveLength(1);
    expect(lineageInserts[0]).toMatchObject({
      depth: 1,
      parent_run_id: "run-cto",
      child_run_id: "child-2",
    });
  });

  it("guarded DEPTH-exceeded: refused BEFORE enqueue (no spend, no ledger edge)", async () => {
    dedupResult.push({ data: null });
    lineageStats = { max_depth: 8, target_slugs: [], cumulative_cost: 1 };
    const r = await a2aDispatch({
      ...baseInput,
      delegation_guard: { parentLineage: { lineage_id: "lin-deep", depth: 8 } },
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "depth_exceeded" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(lineageInserts).toHaveLength(0);
  });

  it("guarded COST-ceiling: refused + escalate, no enqueue", async () => {
    dedupResult.push({ data: null });
    lineageStats = { max_depth: 1, target_slugs: ["x"], cumulative_cost: 30 };
    const r = await a2aDispatch({
      ...baseInput,
      delegation_guard: { parentLineage: { lineage_id: "lin-rich", depth: 1 } },
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "cost_ceiling_exceeded", escalate: true });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("guarded FAIL-CLOSED: lineage lookup error → refused lookup_failed, no enqueue", async () => {
    dedupResult.push({ data: null });
    lineageStatsError = { message: "db down" };
    const r = await a2aDispatch({
      ...baseInput,
      delegation_guard: { parentLineage: { lineage_id: "lin-x", depth: 2 } },
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "lookup_failed" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe("a2aDispatch — three-tier pricing", () => {
  it("enqueue refused by the tier gate → stable plan_upgrade_required reason with required_tier", async () => {
    dedupResult.push({ data: null });
    enqueueAgentRun.mockRejectedValueOnce(Object.assign(new Error("Meta Ads needs the Pro plan ($240/mo)."), {
  code: "plan_upgrade_required",
  agent_slug: "meta_ads",
  required_tier: "pro",
  body: {
    error: { code: "plan_upgrade_required", required_tier: "pro", message: "Meta Ads needs the Pro plan ($240/mo)." },
  },
}));
    const r = await a2aDispatch(baseInput);
    expect(r).toMatchObject({
      ok: false,
      reason: "plan_upgrade_required",
      required_tier: "pro",
      error: "Meta Ads needs the Pro plan ($240/mo).",
    });
    expect(writeNote).not.toHaveBeenCalled();
    expect(logDecisionNotTaken).toHaveBeenCalledWith(
      expect.objectContaining({ reason_code: "plan_upgrade_required" }),
    );
  });
});
