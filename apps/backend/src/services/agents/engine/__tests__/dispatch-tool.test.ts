
import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import { evaluateToolCallPolicy } from "../../tool-call-policy";
import type { EngineEvent, EngineToolCall } from "../types";
import type { McpCallResult } from "@/services/mcp/types";

function baseDeps(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const events: EngineEvent[] = [];
  const okResult: McpCallResult = {
    ok: true,
    content: JSON.stringify({ result: "real-output" }),
    is_error: false,
    ms: 12,
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
    baseCallCtx: { tenant_id: "t1", run_id: "r1" },
    onEvent: (e) => events.push(e),
    iter: { value: 3 },
    ...overrides,
  };
  return { deps, events, callSpy };
}

const call: EngineToolCall = {
  tool_name: "slack__post_message",
  input: { channel: "C1", text: "hi" },
  tool_use_id: "tu-1",
};

describe("makeDispatchTool — P1-A funnel", () => {
  it("ALLOW: exactly one callMcpTool + real result + one tool_call event", async () => {
    const { deps, events, callSpy } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool_use_id: "tu-1", run_id: "r1" }),
      "slack",
      "post_message",
      call.input,
    );
    expect(res.is_error).toBe(false);
    expect(res.denied).toBeFalsy();
    expect(res.content).toContain("real-output");
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "slack__post_message", code: "ok", iter: 3 });
  });

  it("KILL: synthetic kill_switch + ZERO callMcpTool + killed flag set", async () => {
    const killed = { value: false };
    const { deps, events, callSpy } = baseDeps({
      isAgentKilled: async () => true,
      killed,
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.is_error).toBe(true);
    expect(res.denied).toBe(true);
    expect(res.content).toBe("kill_switch");
    expect(res.code).toBe("kill_switch");
    expect(killed.value).toBe(true);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ code: "kill_switch" });
  });

  it("STOP: synthetic run_cancelled + ZERO callMcpTool + killed flag set", async () => {
    const killed = { value: false };
    const { deps, events, callSpy } = baseDeps({
      isRunStopRequested: async () => true,
      killed,
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.is_error).toBe(true);
    expect(res.denied).toBe(true);
    expect(res.content).toBe("run_cancelled");
    expect(res.code).toBe("run_cancelled");
    expect(killed.value).toBe(true);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ code: "run_cancelled" });
  });

  it("STOP: a NON-stopped run is unaffected (allow proceeds)", async () => {
    const { deps, callSpy } = baseDeps({ isRunStopRequested: async () => false });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });

  it("STOP: absent isRunStopRequested dep → no stop check (legacy/back-compat)", async () => {
    const { deps, callSpy } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });

  it("TENANT-DENY: synthetic deny + ZERO callMcpTool", async () => {
    const { deps, events, callSpy } = baseDeps({
      isToolAllowed: async () => ({ allowed: false, reason: "blocked by tenant policy" }),
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("tenant_tool_deny");
    expect(res.content).toBe("blocked by tenant policy");
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1);
  });

  it("EGRESS-DENY: synthetic deny + ZERO callMcpTool", async () => {
    const { deps, events, callSpy } = baseDeps({
      resolved_tool_names: ["web_fetch__fetch", "operator_db__query"],
      evaluateToolCallPolicy: () => ({
        allow: false,
        reason: "egress_denied_coresident",
        synthetic_tool_result: "EGRESS DENIED: open-web read blocked (co-resident private tool).",
      }),
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({ ...call, tool_name: "web_fetch__fetch" });

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("egress_denied_coresident");
    expect(res.content).toContain("EGRESS DENIED");
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "web_fetch__fetch", code: "egress_denied_coresident" });
  });

  it("PM-OPERATOR-DB-DENY: synthetic deny + ZERO callMcpTool", async () => {
    const { deps, callSpy } = baseDeps({
      agent_slug: "pm",
      shouldDenyPmOperatorDb: () => true,
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({ ...call, tool_name: "operator_db__query" });

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("pm_operator_db_policy");
    expect(res.content).toContain("operator_db denied");
  });

  it("OPERATOR-TIER PRE-CHECK deny wins first + ZERO callMcpTool", async () => {
    const { deps, callSpy } = baseDeps({
      operatorPreCheck: () => ({
        allow: false,
        reason: "operator_tier_classify_required",
        synthetic_tool_result: "Emit <plan>.classify before any write.",
      }),
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);

    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("operator_tier_classify_required");
  });

  it("NAME-FORM: isToolAllowed is queried with the BARE `<server>__<tool>` form the funnel receives", async () => {
    const seen: Array<{ tenant: string; agent: string; tool: string }> = [];
    const { deps } = baseDeps({
      isToolAllowed: async (tenant_id, agent_slug, tool_name) => {
        seen.push({ tenant: tenant_id, agent: agent_slug, tool: tool_name });
        return { allowed: true };
      },
    });
    const dispatchTool = makeDispatchTool(deps);
    await dispatchTool({ ...call, tool_name: "web_fetch__fetch" });
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe("web_fetch__fetch");
    expect(seen[0].tenant).toBe("t1");
    expect(seen[0].agent).toBe("operator");
  });

  it("NAME-FORM: pm web_search cap fires through the funnel on the bare `web_search__search` name", async () => {
    const { deps, callSpy } = baseDeps({
      agent_slug: "pm",
      run_mode: "delivery",
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({ ...call, tool_name: "web_search__search" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("web_search_policy");
    expect(res.content).toContain("strategy-only tool");
  });

  it("NAME-FORM: pm operator_db deny fires through the funnel on the bare `operator_db__query` name", async () => {
    const { deps, callSpy } = baseDeps({
      agent_slug: "pm",
      shouldDenyPmOperatorDb: (a) => {
        expect(a.toolName).toBe("operator_db__query");
        return true;
      },
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({ ...call, tool_name: "operator_db__query" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("pm_operator_db_policy");
  });

  it("DENY-BODY: memory_grounding / web_search / pm_operator_db / cto_info_readonly bodies are byte-identical to pre-tool-use-policy.ts", async () => {
    const MEMORY_BODY =
      "memory__search denied: the user is asking about CURRENT state. Memory may be stale — use a live tool (e.g. *__list_* / *__get_*) to fetch the present value. See _core/live-state-grounding.md.";
    const PM_OPERATOR_DB_BODY =
      "operator_db denied: pm's access to the customer business DB is not enabled for this workspace. Proceed using the internal corpus (recent runs, decisions, memory).";
    const CTO_READONLY_BODY =
      "read-only mode: this is an informational question, so I can't edit files or run mutating commands. Ask me to make a specific change if you want a PR.";

    {
      const { deps } = baseDeps({
        agent_slug: "operator",
        recall_policy: "live_state_aware",
        is_live_state_question: true,
      });
      const res = await makeDispatchTool(deps)({ ...call, tool_name: "memory__search" });
      expect(res.content).toBe(MEMORY_BODY);
    }
    {
      const { deps } = baseDeps({ agent_slug: "pm", run_mode: "delivery" });
      const res = await makeDispatchTool(deps)({ ...call, tool_name: "web_search__search" });
      expect(res.content).toBe("web_search denied: pm is in 'delivery' mode (strategy-only tool).");
    }
    {
      const { deps } = baseDeps({ agent_slug: "pm", shouldDenyPmOperatorDb: () => true });
      const res = await makeDispatchTool(deps)({ ...call, tool_name: "operator_db__query" });
      expect(res.content).toBe(PM_OPERATOR_DB_BODY);
    }
    {
      const { deps } = baseDeps({ agent_slug: "engineer", cto_chat_intent: "info" });
      const res = await makeDispatchTool(deps)({ ...call, tool_name: "mcp__sandbox__write_file" });
      expect(res.content).toBe(CTO_READONLY_BODY);
    }
  });

  it("COUNTER: an injected webSearchCounter is NOT mutated for a non-pm tool", async () => {
    const counter = { n: 0 };
    const { deps } = baseDeps({ webSearchCounter: counter });
    await makeDispatchTool(deps)(call);
    expect(counter.n).toBe(0);
  });

  const ADVISOR_RESOLVED = [
    "web_search__search",
    "web_fetch__fetch",
    "apify__rag_web_browser",
    "slack__get_channel_history",
    "memory__write",
    "praxis_corpus__query_recent_runs",
  ];

  it("web egress ALLOWED before AND after private data (co-residency block removed 2026-06-03)", async () => {
    const privateDataTouched = { value: false };
    const { deps, callSpy } = baseDeps({
      agent_slug: "advisor",
      resolved_tool_names: ADVISOR_RESOLVED,
      research_scoped: false,
      evaluateToolCallPolicy,
      privateDataTouched,
    });
    const dispatchTool = makeDispatchTool(deps);

    const r1 = await dispatchTool({
      tool_name: "web_search__search",
      input: { query: "p2p car rental take rate benchmarks" },
      tool_use_id: "tu-web-1",
    });
    expect(r1.denied).toBeFalsy();
    expect(privateDataTouched.value).toBe(false);

    const r2 = await dispatchTool({
      tool_name: "slack__get_channel_history",
      input: { channel: "C1" },
      tool_use_id: "tu-slack",
    });
    expect(r2.denied).toBeFalsy();
    expect(privateDataTouched.value).toBe(true);

    const callsBefore = callSpy.mock.calls.length;
    const r3 = await dispatchTool({
      tool_name: "web_search__search",
      input: { query: "anything" },
      tool_use_id: "tu-web-2",
    });
    expect(r3.denied).toBeFalsy();
    expect(callSpy.mock.calls.length).toBe(callsBefore + 1);
  });

  it("a NON-exempt agent (operator) co-resident web call is now ALLOWED (block removed 2026-06-03)", async () => {
    const privateDataTouched = { value: false };
    const { deps, callSpy } = baseDeps({
      agent_slug: "operator",
      resolved_tool_names: ["web_search__search", "slack__get_channel_history"],
      research_scoped: false,
      evaluateToolCallPolicy,
      privateDataTouched,
    });
    const res = await makeDispatchTool(deps)({
      tool_name: "web_search__search",
      input: { query: "x" },
      tool_use_id: "tu-op",
    });
    expect(res.denied).toBeFalsy();
    expect(callSpy).toHaveBeenCalled();
  });

  it("real tool ERROR: callMcpTool ran once, error surfaced, event code carries parsed error", async () => {
    const errResult: McpCallResult = {
      ok: false,
      content: JSON.stringify({ error: "rate_limited", message: "slow down" }),
      is_error: true,
      ms: 5,
    };
    const callSpy = vi.fn().mockResolvedValue(errResult);
    const { deps, events } = baseDeps({
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    });
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool(call);

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.is_error).toBe(true);
    expect(res.denied).toBe(false);
    expect(res.code).toBe("rate_limited");
    expect(events.filter((e) => e.type === "tool_call")[0]).toMatchObject({ code: "rate_limited" });
  });

  it("forwards slack_routing + email_routing from baseCallCtx to callMcpTool (handoff routing)", async () => {
    const slack_routing = {
      channel_id: "C1",
      thread_ts: "1700.1",
      original_ts: "1700.1",
      event_id: "Ev123",
      team_id: "T1",
    };
    const { deps, callSpy } = baseDeps({
      baseCallCtx: {
        tenant_id: "t1",
        run_id: "r1",
        agent_slug: "operator",
        trigger: "slack",
        slack_routing,
        slack_target_team_id: "T1",
        slack_post_blocked: false,
      },
    });
    const handoffCall: EngineToolCall = {
      tool_name: "praxis__handoff",
      input: { target_agent_slug: "engineer", intent: "fix the deposit bug" },
      tool_use_id: "tu-h1",
    };
    const dispatchTool = makeDispatchTool(deps);
    await dispatchTool(handoffCall);

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "slack",
        slack_routing: expect.objectContaining({ event_id: "Ev123", channel_id: "C1" }),
        slack_target_team_id: "T1",
      }),
      "praxis",
      "handoff",
      handoffCall.input,
    );
  });
});

describe("makeDispatchTool — E8 github external-content wrap (SDK path)", () => {
  it("github__get_pr_diff output is wrapped in <untrusted_tool_github>", async () => {
    const { deps } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({
      tool_name: "github__get_pr_diff",
      input: { owner: "o", repo: "r", number: 1 },
      tool_use_id: "tu-gh",
    });
    expect(res.is_error).toBe(false);
    expect(res.content).toContain("<untrusted_tool_github>");
    expect(res.content).toContain("</untrusted_tool_github>");
    expect(res.content).toContain("real-output");
  });

  it("github__read_file (own-repo read) is NOT wrapped", async () => {
    const { deps } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({
      tool_name: "github__read_file",
      input: { owner: "o", repo: "r", path: "src/a.ts" },
      tool_use_id: "tu-gh2",
    });
    expect(res.content).not.toContain("<untrusted_tool_github>");
    expect(res.content).toContain("real-output");
  });

  it("non-github tool output is unchanged (no new SDK-path wrap)", async () => {
    const { deps } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);
    const res = await dispatchTool({
      tool_name: "stripe__list_charges",
      input: {},
      tool_use_id: "tu-st",
    });
    expect(res.content).not.toContain("untrusted_tool");
    expect(res.content).toContain("real-output");
  });
});
