
import { describe, it, expect, vi } from "vitest";
import type { Model } from "@openai/agents";

vi.mock("@/services/openai", () => ({ getOpenAi: () => null }));
vi.mock("@/services/memory/embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/embed")>()),
  embedTexts: async () => {
    throw new Error("VOYAGE_API_KEY not set");
  },
}));

import {
  makeOperatorTierPreCheck,
  newToolCounters,
  settleOperatorToolResult,
  type ClassifyT,
  type OperatorTierPreCheckState,
} from "../operator-policy";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../engine/dispatch-tool";
import { makeOperatorTurnLatch, wireAltFunnelOperatorGate } from "../generic-dispatcher-operator-latch";
import { TurnHookModel } from "../engine/turn-hook-model";
import { buildOpenAiAgent, _streamOpenAICompatRunForTests } from "../engine/openai-engine";
import type { AgentEngineRunSpec, EngineEvent, EngineToolCall } from "../engine/types";
import type { McpCallResult } from "@/services/mcp/types";

function mkState(over: Partial<OperatorTierPreCheckState> = {}): OperatorTierPreCheckState {
  return {
    counters: over.counters ?? newToolCounters(),
    currentClassify: "currentClassify" in over ? (over.currentClassify ?? null) : ({ tier: "tier2", confidence: 0.9, evidence_needed: [] } as ClassifyT),
    iter: over.iter ?? 0,
    latestUserText: over.latestUserText ?? "",
  };
}

const RUN_ID = "run-alt-funnel-uuid";

function call(tool_name: string, input: unknown = {}): EngineToolCall {
  return { tool_name, input, tool_use_id: "tu-1" };
}

function funnelDeps(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const events: EngineEvent[] = [];
  const okResult: McpCallResult = { ok: true, content: JSON.stringify({ result: "real-output" }), is_error: false, ms: 7 };
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

const PLAN_TIER1 = '<plan>\n{ "classify": { "tier": "tier1", "confidence": 0.9 } }\n</plan>\nJust a lookup.';
const PLAN_TIER3_NO_GITHUB =
  '<plan>\n{ "classify": { "tier": "tier3", "confidence": 0.9, "evidence_needed": ["memory"] } }\n</plan>\nChecking memory.';
const PLAN_TIER2_HIGH_CONF = '<plan>\n{ "classify": { "tier": "tier2", "confidence": 0.9 } }\n</plan>\nOn it.';

describe("operator gate on alt funnel (latch → precheck → funnel)", () => {
  it("tier3 plan latched via turn hook → out-of-evidence read DENIED", async () => {
    const st = mkState({ currentClassify: null, iter: -1 });
    await makeOperatorTurnLatch(st)({ text: PLAN_TIER3_NO_GITHUB });
    const pre = makeOperatorTierPreCheck({ state: st, run_id: RUN_ID, untrusted_inbound: false });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    const r = await makeDispatchTool(deps)(call("github__search_code"));
    expect(r.code).toBe("tier3_read_not_in_evidence");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("tier1 plan latched → handoff DENIED", async () => {
    const st = mkState({ currentClassify: null, iter: -1 });
    await makeOperatorTurnLatch(st)({ text: PLAN_TIER1 });
    const pre = makeOperatorTierPreCheck({ state: st, run_id: RUN_ID, untrusted_inbound: false });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    expect((await makeDispatchTool(deps)(call("praxis__handoff"))).code).toBe("tier1_lookup_handoff_denied");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("'draft a ticket' → praxis__action held, not filed", async () => {
    const st = mkState({ currentClassify: null, iter: -1, latestUserText: "draft up a Jira ticket to investigate slow payouts" });
    await makeOperatorTurnLatch(st)({ text: PLAN_TIER2_HIGH_CONF });
    const pre = makeOperatorTierPreCheck({ state: st, run_id: RUN_ID, untrusted_inbound: false });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: pre });
    expect((await makeDispatchTool(deps)(call("praxis__action"))).code).toBe("external_write_needs_commit_intent");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("a later turn without a <plan> keeps the earlier classify (parity with the inline Claude path)", async () => {
    const st = mkState({ currentClassify: null, iter: -1 });
    const latch = makeOperatorTurnLatch(st);
    await latch({ text: PLAN_TIER3_NO_GITHUB });
    await latch({ text: "looking into it" });
    expect(st.currentClassify?.tier).toBe("tier3");
    expect(st.iter).toBe(1);
  });

  it("empty turn text does not advance iter (keeps the iter-0 write gate armed)", async () => {
    const st = mkState({ currentClassify: null, iter: -1 });
    await makeOperatorTurnLatch(st)({ text: "" });
    expect(st.iter).toBe(-1);
  });
});

describe("wireAltFunnelOperatorGate (fail closed)", () => {
  const pre = () => ({ allow: true as const });
  const settle = () => {};
  it("not required → wires nothing", () => {
    expect(wireAltFunnelOperatorGate({ gateRequired: false, engineHonorsTurnHook: false, state: null, operatorPreCheck: undefined, operatorSettle: undefined })).toEqual({});
  });
  it("required + all pieces → precheck, settle and the turn latch", () => {
    const w = wireAltFunnelOperatorGate({ gateRequired: true, engineHonorsTurnHook: true, state: mkState(), operatorPreCheck: pre, operatorSettle: settle });
    expect(w.operatorPreCheck).toBe(pre);
    expect(w.operatorSettle).toBe(settle);
    expect(typeof w.onAssistantTurn).toBe("function");
  });
  it.each([
    ["no state", { engineHonorsTurnHook: true, state: null, operatorPreCheck: pre, operatorSettle: settle }],
    ["no precheck", { engineHonorsTurnHook: true, state: mkState(), operatorPreCheck: undefined, operatorSettle: settle }],
    ["no settle", { engineHonorsTurnHook: true, state: mkState(), operatorPreCheck: pre, operatorSettle: undefined }],
    ["an engine that ignores the turn hook", { engineHonorsTurnHook: false, state: mkState(), operatorPreCheck: pre, operatorSettle: settle }],
  ])("required + %s → refuses the run", (_label, parts) => {
    expect(() => wireAltFunnelOperatorGate({ gateRequired: true, ...parts })).toThrow(/operator gate could not be wired/);
  });
});

describe("engine order: operator gate through the real Runner", () => {
  function scripted(turns: Array<{ text: string; tool?: string }>): Model {
    let i = 0;
    return {
      async getResponse() {
        throw new Error("not used");
      },
      async *getStreamedResponse() {
        const t = turns[Math.min(i, turns.length - 1)];
        i += 1;
        yield {
          type: "response_done",
          response: {
            id: `r${i}`,
            usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            output: [
              { type: "message", id: `m${i}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: t.text }] },
              ...(t.tool ? [{ type: "function_call", id: `fc${i}`, callId: `c${i}`, name: t.tool, arguments: "{}", status: "completed" }] : []),
            ],
          },
        } as never;
      },
    } as Model;
  }

  async function runOperatorTurn(withHook: boolean) {
    const st = mkState({ currentClassify: null, iter: -1 });
    const pre = makeOperatorTierPreCheck({ state: st, run_id: RUN_ID, untrusted_inbound: false });
    const settle = (a: { tool_name: string; is_error: boolean; code?: string }) =>
      settleOperatorToolResult({ tool_name: a.tool_name, is_error: a.is_error, code: a.code, counters: st.counters });
    const wired = wireAltFunnelOperatorGate({ gateRequired: true, engineHonorsTurnHook: true, state: st, operatorPreCheck: pre, operatorSettle: settle });
    const { deps, callSpy } = funnelDeps({ operatorPreCheck: wired.operatorPreCheck, operatorSettle: wired.operatorSettle });
    const dispatchTool = makeDispatchTool(deps);
    const spec: AgentEngineRunSpec = {
      systemPrompt: "S",
      userPrompt: "where is the payouts code?",
      model: "qwen/qwen3.8-27b",
      maxTurns: 4,
      tools: [{ name: "praxis__handoff", description: "hand off", jsonSchema: { type: "object", properties: {} } }],
      resume: null,
      abort: new AbortController(),
      dispatchTool,
      onEvent: () => {},
    };
    const base = scripted([{ text: PLAN_TIER1, tool: "praxis__handoff" }, { text: "done" }]);
    const model = withHook ? new TurnHookModel(base, wired.onAssistantTurn!) : base;
    const agent = buildOpenAiAgent(spec, model);
    for await (const _ of _streamOpenAICompatRunForTests(spec, agent, "stateless")) void _;
    return { callSpy, st };
  }

  it("hook wired: same-turn tier1 handoff is DENIED (callMcpTool never runs)", async () => {
    const { callSpy, st } = await runOperatorTurn(true);
    expect(st.currentClassify?.tier).toBe("tier1");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("FALSIFIER: no hook → classify never latched → the same handoff is ALLOWED", async () => {
    const { callSpy, st } = await runOperatorTurn(false);
    expect(st.currentClassify).toBeNull();
    expect(callSpy).toHaveBeenCalledTimes(1);
  });
});
