import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "@/services/agents/engine/dispatch-tool";
import type { EngineToolCall } from "@/services/agents/engine/types";
import type { McpCallResult } from "@/services/mcp/types";
import { HarnessFailure } from "@/services/eval/shadow-harness";
import {
  assertBenchRunReady,
  runBenchTrial,
  wrapBenchDispatch,
  type BenchRunCtx,
} from "../modes";
import { fixtureToShadowMap, type TaskFixture } from "../fixtures";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function deps(over: Partial<MakeDispatchToolDeps> = {}) {
  const callSpy = vi.fn().mockResolvedValue({
    ok: true,
    content: "LIVE",
    is_error: false,
    ms: 1,
  } as McpCallResult);
  const d: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: TENANT,
    agent_slug: "pm",
    baseCallCtx: { tenant_id: TENANT, run_id: "bench-r1" },
    onEvent: () => {},
    iter: { value: 0 },
    ...over,
  };
  return { d, callSpy };
}

const call = (tool_name: string, input: unknown = { q: "x" }): EngineToolCall => ({
  tool_name,
  input,
  tool_use_id: "tu",
});

function fixture(over: Partial<TaskFixture> = {}): TaskFixture {
  return {
    fixture_version: 1,
    task_id: "t1",
    tenant_id: TENANT,
    company: "upcar-ai",
    agent_slug: "pm",
    unit: "pm",
    cohort: "role",
    source_run_id: "src-1",
    input: { trigger: "chat", payload: null, prompt: { system: "S", initial_user: "U" } },
    evidence: [
      { tenant_id: TENANT, tool_name: "memory__search", input: { q: "x" }, content: "FROZEN", is_error: false },
    ],
    filled_by: ["claude-shared"],
    ...over,
  };
}

describe("test 2 — scored mode makes zero live reads", () => {
  it("hit serves the frozen fixture; a miss returns the deny body; the tool fn is never called", async () => {
    const map = fixtureToShadowMap(fixture(), TENANT);
    const { d, callSpy } = deps({ shadow_mode: true, shadow_tool_results: map });
    const dispatch = makeDispatchTool(d);
    const hit = await dispatch(call("memory__search"));
    expect(hit.content).toBe("FROZEN");
    const miss = await dispatch(call("web_search__search", { q: "anything" }));
    expect(miss.denied).toBe(true);
    expect(miss.code).toBe("shadow_no_captured_evidence");
    const miss2 = await dispatch(call("memory__search", { q: "different" }));
    expect(miss2.denied).toBe(true);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("each run gets its own queues: consuming one run's map never drains another's", async () => {
    const f = fixture();
    const a = fixtureToShadowMap(f, TENANT);
    const b = fixtureToShadowMap(f, TENANT);
    const { d } = deps({ shadow_mode: true, shadow_tool_results: a });
    await makeDispatchTool(d)(call("memory__search"));
    expect([...b.values()][0]).toHaveLength(1);
    expect(f.evidence).toHaveLength(1);
  });
});

describe("test 10 — score mode requires a fixture map before runGeneric", () => {
  const baseCtx = (over: Partial<BenchRunCtx> = {}): BenchRunCtx => ({
    tenant_id: TENANT,
    shadow_mode: true,
    bench_mode: "score",
    bench_engine: "shared_loop",
    ...over,
  });

  it("score mode without a map throws HarnessFailure", () => {
    expect(() => assertBenchRunReady(baseCtx())).toThrow(HarnessFailure);
  });

  it("runBenchTrial never calls runGeneric when the map is missing", async () => {
    const runGeneric = vi.fn();
    await expect(runBenchTrial(baseCtx(), runGeneric)).rejects.toBeInstanceOf(HarnessFailure);
    expect(runGeneric).not.toHaveBeenCalled();
  });

  it("score mode with a map runs", async () => {
    const runGeneric = vi.fn().mockResolvedValue("ok");
    const ctx = baseCtx({ shadow_tool_results: fixtureToShadowMap(fixture(), TENANT) });
    await expect(runBenchTrial(ctx, runGeneric)).resolves.toBe("ok");
    expect(runGeneric).toHaveBeenCalledOnce();
  });

  it("bench mode is refused unless shadow_mode is on (no write-blocking, no bench)", () => {
    expect(() => assertBenchRunReady(baseCtx({ shadow_mode: false }))).toThrow(HarnessFailure);
  });

  it("build mode refuses a replay map (build must read live, allowlisted)", () => {
    expect(() =>
      assertBenchRunReady(
        baseCtx({ bench_mode: "build", shadow_tool_results: new Map() }),
      ),
    ).toThrow(HarnessFailure);
  });
});

describe("wrapBenchDispatch", () => {
  it("captures the FULL result the model received in build mode, tagged with the run tenant", async () => {
    const recs: unknown[] = [];
    const inner = vi.fn(async () => ({ is_error: false, content: "X".repeat(20_000), ms: 1, code: "ok", denied: false }));
    const w = wrapBenchDispatch(inner, { runTenant: TENANT, expectedTenant: TENANT, capture: (r) => recs.push(r) });
    await w(call("memory__search"));
    expect(recs).toHaveLength(1);
    expect((recs[0] as { content: string }).content).toHaveLength(20_000);
    expect((recs[0] as { tenant_id: string }).tenant_id).toBe(TENANT);
  });

  it("denied calls are not captured as evidence", async () => {
    const recs: unknown[] = [];
    const inner = vi.fn(async () => ({ is_error: true, content: "no", ms: 0, code: "shadow_no_side_effect", denied: true }));
    const w = wrapBenchDispatch(inner, { runTenant: TENANT, expectedTenant: TENANT, capture: (r) => recs.push(r) });
    await w(call("stripe__refund"));
    expect(recs).toHaveLength(0);
  });

  it("a fixture tenant that differs from the run tenant is refused at dispatch", () => {
    const inner = vi.fn();
    expect(() =>
      wrapBenchDispatch(inner, { runTenant: TENANT, expectedTenant: "other-tenant" }),
    ).toThrow(HarnessFailure);
  });
});
