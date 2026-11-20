
import { describe, it, expect, vi } from "vitest";
import {
  decideOperatorTool,
  makeOperatorTierPreCheck,
  newToolCounters,
  OPERATOR_BUDGET_CAPS,
  type ClassifyT,
  type OperatorTierPreCheckState,
} from "../operator-policy";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../engine/dispatch-tool";
import { extractPlanBlock } from "../plan-emit";
import type { EngineEvent, EngineToolCall } from "../engine/types";
import type { McpCallResult } from "@/services/mcp/types";

function mkClassify(over: Partial<ClassifyT> = {}): ClassifyT {
  return {
    tier: over.tier ?? "tier2",
    confidence: over.confidence ?? 0.9,
    evidence_needed: over.evidence_needed ?? [],
    target_specialist: over.target_specialist,
  };
}

function mkState(over: Partial<OperatorTierPreCheckState> = {}): OperatorTierPreCheckState {
  return {
    counters: over.counters ?? newToolCounters(),
    currentClassify: "currentClassify" in over ? (over.currentClassify ?? null) : mkClassify(),
    iter: over.iter ?? 0,
    latestUserText: over.latestUserText ?? "",
  };
}

const RUN_ID = "run-precheck-uuid";

function call(tool_name: string, input: unknown = {}): EngineToolCall {
  return { tool_name, input, tool_use_id: "tu-1" };
}

describe("makeOperatorTierPreCheck — parity with decideOperatorTool", () => {
  it("ALLOW: tier2 read passes through (matches legacy allow)", () => {
    const counters = newToolCounters();
    const pre = makeOperatorTierPreCheck({
      state: mkState({ counters, currentClassify: mkClassify({ tier: "tier2" }) }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    const got = pre(call("memory__search"));

    const legacy = decideOperatorTool({
      classify: mkClassify({ tier: "tier2" }),
      tool_name: "memory__search",
      run_id: RUN_ID,
      iter: 0,
      counters: newToolCounters(),
    });
    expect(got).toEqual({ allow: true });
    expect(legacy.allow).toBe(true);
  });

  it("BLOCK: missing classify + iter 0 + write → fail-closed (same reason as legacy)", () => {
    const pre = makeOperatorTierPreCheck({
      state: mkState({ currentClassify: null, iter: 0 }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    const got = pre(call("praxis__action"));

    const legacy = decideOperatorTool({
      classify: undefined,
      tool_name: "praxis__action",
      run_id: RUN_ID,
      iter: 0,
      counters: newToolCounters(),
    });
    expect(got.allow).toBe(false);
    if (got.allow) throw new Error("expected deny");
    expect(legacy.allow).toBe(false);
    if (legacy.allow) throw new Error("expected legacy deny");
    expect(got.reason).toBe("missing_classify_fail_closed");
    expect(got.reason).toBe(legacy.reason);
    expect(got.synthetic_tool_result).toBe(legacy.synthetic_tool_result);
  });

  it("BLOCK: external write with a DRAFT/hold ask → commit-intent gate (SCRUM-5192 class)", () => {
    const pre = makeOperatorTierPreCheck({
      state: mkState({
        currentClassify: mkClassify({ tier: "tier2" }),
        iter: 1,
        latestUserText: "draft up a Jira ticket to investigate slow payouts",
      }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    const got = pre(call("praxis__action"));
    expect(got.allow).toBe(false);
    if (got.allow) throw new Error("expected deny");
    expect(got.reason).toBe("external_write_needs_commit_intent");
  });

  it("BUDGET: github__search_code denied once the per-run cap is reached", () => {
    const cap = OPERATOR_BUDGET_CAPS.get("github__search_code");
    expect(cap).toBeGreaterThan(0);
    const counters = newToolCounters();
    counters.set("github__search_code", cap as number);
    const pre = makeOperatorTierPreCheck({
      state: mkState({ counters, currentClassify: mkClassify({ tier: "tier1" }) }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    const got = pre(call("github__search_code"));
    expect(got.allow).toBe(false);
    if (got.allow) throw new Error("expected deny");
    expect(got.reason).toBe("github_search_code_budget_exhausted");
  });

  it("EGRESS: untrusted_inbound denies web_fetch (email-trigger parity)", () => {
    const pre = makeOperatorTierPreCheck({
      state: mkState({ currentClassify: mkClassify({ tier: "tier1" }) }),
      run_id: RUN_ID,
      untrusted_inbound: true,
    });
    const got = pre(call("web_fetch__fetch"));
    expect(got.allow).toBe(false);
    if (got.allow) throw new Error("expected deny");
    expect(got.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("COUNTERS shared by reference: ALLOW bumps the same map the next call reads", () => {
    const cap = OPERATOR_BUDGET_CAPS.get("github__search_code") as number;
    const counters = newToolCounters();
    const pre = makeOperatorTierPreCheck({
      state: mkState({ counters, currentClassify: mkClassify({ tier: "tier1" }) }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    for (let i = 0; i < cap; i++) {
      expect(pre(call("github__search_code")).allow).toBe(true);
    }
    expect(counters.get("github__search_code")).toBe(cap);
    const overflow = pre(call("github__search_code"));
    expect(overflow.allow).toBe(false);
  });
});

function funnelDeps(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const events: EngineEvent[] = [];
  const okResult: McpCallResult = {
    ok: true,
    content: JSON.stringify({ result: "real-output" }),
    is_error: false,
    ms: 7,
  };
  const callSpy = vi.fn().mockResolvedValue(okResult);
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "operator",
    baseCallCtx: { tenant_id: "t1", run_id: RUN_ID },
    onEvent: (e) => events.push(e),
    iter: { value: 0 },
    ...overrides,
  };
  return { deps, events, callSpy };
}

describe("operator pre-check fires on the SDK dispatch funnel", () => {
  it("DENY short-circuits callMcpTool (missing-classify write) — the real bypass fix", async () => {
    const pre = makeOperatorTierPreCheck({
      state: mkState({ currentClassify: null, iter: 0 }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call("praxis__action"));

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("missing_classify_fail_closed");
  });

  it("ALLOW proceeds to callMcpTool exactly once (tier2 read)", async () => {
    const pre = makeOperatorTierPreCheck({
      state: mkState({ currentClassify: mkClassify({ tier: "tier2" }) }),
      run_id: RUN_ID,
      untrusted_inbound: false,
    });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call("memory__search"));

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });

  it("NON-OPERATOR: operatorPreCheck undefined → no operator gate, write proceeds", async () => {
    const { deps, callSpy } = funnelDeps({ agent_slug: "engineer" });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call("praxis__action"));

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });
});

describe("SDK stream-order: classify + iter visible to operatorPreCheck before callMcpTool", () => {
  const PLAN_TIER3 =
    '<plan>\n{ "classify": { "tier": "tier3", "confidence": 0.9 } }\n</plan>\nDelegating to a specialist.';
  const PLAN_TIER3_NO_EVIDENCE =
    '<plan>\n{ "classify": { "tier": "tier3", "confidence": 0.9, "evidence_needed": [] } }\n</plan>';
  const PLAN_TIER1 =
    '<plan>\n{ "classify": { "tier": "tier1", "confidence": 0.9 } }\n</plan>\nJust a lookup.';

  it("text processed BEFORE tool → pre-check sees iter=0 + tier3 classify (write denied, callMcpTool not run)", async () => {
    const state = mkState({ currentClassify: null, iter: -1 });
    state.iter += 1;
    expect(state.iter).toBe(0);
    const parsed = extractPlanBlock(PLAN_TIER3);
    if (parsed?.classify) state.currentClassify = parsed.classify;
    expect(state.currentClassify?.tier).toBe("tier3");
    const pre = makeOperatorTierPreCheck({ state, run_id: RUN_ID, untrusted_inbound: false });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    const res = await makeDispatchTool(deps)(call("praxis__action"));
    expect(res.denied).toBe(true);
    expect(res.code).toBe("tier3_write_denied");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("FALSIFIER: tool dispatched BEFORE text is processed → fail-closed (different code) → order is load-bearing", async () => {
    const state = mkState({ currentClassify: null, iter: -1 });
    state.iter += 1;
    const pre = makeOperatorTierPreCheck({ state, run_id: RUN_ID, untrusted_inbound: false });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    const res = await makeDispatchTool(deps)(call("praxis__action"));
    expect(res.denied).toBe(true);
    expect(res.code).toBe("missing_classify_fail_closed");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("iter IS read by the pre-check: no-classify write denied at turn 0, allowed at turn 1 (later-turn inherit)", async () => {
    const state = mkState({ currentClassify: null, iter: -1 });
    const pre = makeOperatorTierPreCheck({ state, run_id: RUN_ID, untrusted_inbound: false });
    state.iter += 1;
    const { deps: d0, callSpy: s0 } = funnelDeps({ operatorPreCheck: pre });
    const r0 = await makeDispatchTool(d0)(call("praxis__action"));
    expect(r0.code).toBe("missing_classify_fail_closed");
    expect(s0).not.toHaveBeenCalled();
    state.iter += 1;
    const { deps: d1, callSpy: s1 } = funnelDeps({ operatorPreCheck: pre });
    const r1 = await makeDispatchTool(d1)(call("praxis__action"));
    expect(r1.denied).toBeFalsy();
    expect(s1).toHaveBeenCalledTimes(1);
  });

  it("tier3 out-of-evidence READ: latched-first → DENIED; latch-skipped (stale) → would ALLOW (fail-open)", async () => {
    const ok = mkState({ currentClassify: null, iter: -1 });
    ok.iter += 1;
    const okParsed = extractPlanBlock(PLAN_TIER3_NO_EVIDENCE);
    if (okParsed?.classify) ok.currentClassify = okParsed.classify;
    expect(ok.currentClassify?.tier).toBe("tier3");
    const okPre = makeOperatorTierPreCheck({ state: ok, run_id: RUN_ID, untrusted_inbound: false });
    const { deps: okDeps, callSpy: okSpy } = funnelDeps({ operatorPreCheck: okPre });
    const okRes = await makeDispatchTool(okDeps)(call("github__search_code"));
    expect(okRes.denied).toBe(true);
    expect(okRes.code).toBe("tier3_read_not_in_evidence");
    expect(okSpy).not.toHaveBeenCalled();

    const stale = mkState({ currentClassify: null, iter: 1 });
    const stalePre = makeOperatorTierPreCheck({ state: stale, run_id: RUN_ID, untrusted_inbound: false });
    const { deps: staleDeps, callSpy: staleSpy } = funnelDeps({ operatorPreCheck: stalePre });
    const staleRes = await makeDispatchTool(staleDeps)(call("github__search_code"));
    expect(staleRes.denied).toBeFalsy();
    expect(staleSpy).toHaveBeenCalledTimes(1);
  });

  it("tier1 lookup-HANDOFF: latched-first → DENIED; latch-skipped (stale) → would ALLOW (fail-open)", async () => {
    const ok = mkState({ currentClassify: null, iter: -1 });
    ok.iter += 1;
    const okParsed = extractPlanBlock(PLAN_TIER1);
    if (okParsed?.classify) ok.currentClassify = okParsed.classify;
    expect(ok.currentClassify?.tier).toBe("tier1");
    const okPre = makeOperatorTierPreCheck({ state: ok, run_id: RUN_ID, untrusted_inbound: false });
    const { deps: okDeps, callSpy: okSpy } = funnelDeps({ operatorPreCheck: okPre });
    const okRes = await makeDispatchTool(okDeps)(call("praxis__handoff"));
    expect(okRes.denied).toBe(true);
    expect(okRes.code).toBe("tier1_lookup_handoff_denied");
    expect(okSpy).not.toHaveBeenCalled();

    const stale = mkState({ currentClassify: null, iter: 0 });
    const stalePre = makeOperatorTierPreCheck({ state: stale, run_id: RUN_ID, untrusted_inbound: false });
    const { deps: staleDeps, callSpy: staleSpy } = funnelDeps({ operatorPreCheck: stalePre });
    const staleRes = await makeDispatchTool(staleDeps)(call("praxis__handoff"));
    expect(staleRes.denied).toBeFalsy();
    expect(staleSpy).toHaveBeenCalledTimes(1);
  });
});
