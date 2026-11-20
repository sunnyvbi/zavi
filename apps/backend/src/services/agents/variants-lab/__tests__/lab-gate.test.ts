
import { describe, it, expect, vi } from "vitest";
import { internalToolEffects } from "@/services/mcp/tool-effects";
import { isLabDeniedTool, LAB_DENY_CODE, LAB_DENY_REASON } from "../lab-gate";
import { newLabReadCache, withLabReadCache } from "../lab-read-cache";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../../engine/dispatch-tool";
import { preToolUsePolicyHook } from "../../pre-tool-use-policy";
import type { McpCallResult } from "@/services/mcp/types";

const MUST_CATCH = [
  "praxis__handoff",
  "praxis__handoff_parallel",
  "praxis__ask_agent",
  "praxis__remind",
  "praxis__render_video",
  "praxis__enable_database",
  "report__generate_image",
  "operator_db__codeact",
  "slack__post_message",
  "meta_ads__propose_budget_change",
  "praxis__run_site_check",
  "praxis__action",
  "email__send",
  "email__propose_campaign",
  "praxis__cancel_reminder",
  "tiktok__cancel_scheduled_post",
  "praxis__render_launch_video",
  "praxis__propose_dispatch",
  "foo__bar",
];

const DENIED_READS = new Set(["operator_db__codeact"]);

const MUST_NOT_TOUCH = [
  "github__search_code",
  "github__read_file",
  "github__grep",
  "github__list_files",
  "operator_db__query",
  "operator_db__catalog",
  "memory__search",
  "web_search__search",
];

describe("isLabDeniedTool", () => {
  it("the must-not-touch names are real declared reads", () => {
    const effects = internalToolEffects();
    for (const n of MUST_NOT_TOUCH) expect(effects.get(n), n).toBe("read");
  });

  it("every real must-catch name is declared non-read (or on the fixed list)", () => {
    const effects = internalToolEffects();
    for (const n of MUST_CATCH) {
      if (n === "foo__bar") continue;
      const e = effects.get(n);
      expect(e, `${n} must be a real declared tool`).toBeDefined();
      if (!DENIED_READS.has(n)) expect(e, n).not.toBe("read");
    }
  });

  it("denies the in-process SDK key form too (mcp__praxis__handoff)", () => {
    expect(isLabDeniedTool("mcp__praxis__handoff")).toBe(true);
    expect(isLabDeniedTool("mcp__praxis__ask_agent")).toBe(true);
  });

  it.each(MUST_CATCH)("denies %s", (name) => {
    expect(isLabDeniedTool(name)).toBe(true);
  });

  it.each(MUST_CATCH)("denies %s in the SDK-wrapped form", (name) => {
    expect(isLabDeniedTool(`mcp__server__${name}`)).toBe(true);
  });

  it.each(MUST_NOT_TOUCH)("allows %s, bare and SDK-wrapped", (name) => {
    expect(isLabDeniedTool(name)).toBe(false);
    expect(isLabDeniedTool(`mcp__server__${name}`)).toBe(false);
  });

  it("allows ToolSearch, denies sandbox and SDK built-ins", () => {
    expect(isLabDeniedTool("ToolSearch")).toBe(false);
    expect(isLabDeniedTool("mcp__sandbox__run_bash")).toBe(true);
    expect(isLabDeniedTool("AskUserQuestion")).toBe(true);
    expect(isLabDeniedTool("Bash")).toBe(true);
  });

  it("fails closed when the classifier throws", () => {
    const boom = { get: () => { throw new Error("x"); } } as unknown as Map<string, never>;
    expect(isLabDeniedTool("github__read_file", boom)).toBe(true);
  });
});

function funnel(variants_lab: boolean | undefined) {
  const ok: McpCallResult = { ok: true, content: "{}", is_error: false, ms: 1 };
  const callSpy = vi.fn().mockResolvedValue(ok);
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "operator",
    baseCallCtx: { tenant_id: "t1", run_id: "r1" },
    onEvent: () => {},
    variants_lab,
  };
  return { dispatch: makeDispatchTool(deps), callSpy };
}

describe("makeDispatchTool funnel — variants_lab", () => {
  it.each(MUST_CATCH)("denies %s without calling the tool", async (name) => {
    const { dispatch, callSpy } = funnel(true);
    const res = await dispatch({ tool_name: name, input: {}, tool_use_id: "u" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ is_error: true, denied: true, code: LAB_DENY_CODE, content: LAB_DENY_REASON });
  });

  it.each(MUST_NOT_TOUCH)("runs %s", async (name) => {
    const { dispatch, callSpy } = funnel(true);
    const res = await dispatch({ tool_name: name, input: {}, tool_use_id: "u" });
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });

  it("a normal run (no flag) is unchanged: praxis__handoff runs", async () => {
    const { dispatch, callSpy } = funnel(undefined);
    await dispatch({ tool_name: "praxis__handoff", input: {}, tool_use_id: "u" });
    expect(callSpy).toHaveBeenCalledTimes(1);
  });
});

describe("preToolUsePolicyHook — variants_lab", () => {
  const hook = (tool_name: string, variants_lab?: boolean) =>
    preToolUsePolicyHook({
      isAgentKilled: async () => false,
      emitThreadEvent: vi.fn(async () => {}) as never,
      ctx: {
        tenant_id: "t1",
        agent: { slug: "operator" },
        runId: "r1",
        killed: { value: false },
        iter: { value: 1 },
        variants_lab,
      } as never,
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input: {},
        tool_use_id: "u",
        cwd: "/tmp",
        permission_mode: "default",
        session_id: "s",
        transcript_path: "/tmp/t",
      } as never,
    });

  it.each(MUST_CATCH)("denies mcp__server__%s", async (name) => {
    const res = await hook(`mcp__server__${name}`, true);
    expect(res).toMatchObject({
      reason: LAB_DENY_CODE,
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: LAB_DENY_REASON },
    });
  });

  it.each(MUST_NOT_TOUCH)("passes mcp__server__%s", async (name) => {
    const res = await hook(`mcp__server__${name}`, true);
    expect(res).toEqual({ continue: true });
  });

  it("no flag: a write is not touched by this gate", async () => {
    const res = await hook("mcp__server__praxis__handoff", undefined);
    expect((res as { reason?: string }).reason).not.toBe(LAB_DENY_CODE);
  });
});

describe("browser tools are blocked in the lab (draft runs would silently disable them)", () => {
  it.each(["mcp__server__browser__task", "browser__task", "mcp__server__extension__browser_task"])("%s is denied", (n) => {
    expect(isLabDeniedTool(n)).toBe(true);
  });
});

const READS_WITH_A_WRITE_VERB_IN_THE_NAME = [
  "growth__read_action_outcomes",
  "jira__get_transitions",
  "operator_db__query_recent_transactions",
  "praxis_corpus__get_channel_action",
  "slack__get_reactions",
  "stripe__list_charges",
];

describe("a lab run that is also a draft: the lab gate decides, not the name-fragment classifier", () => {
  const labDraft = () => {
    const ok: McpCallResult = { ok: true, content: "{}", is_error: false, ms: 1 };
    const callSpy = vi.fn().mockResolvedValue(ok);
    const deps: MakeDispatchToolDeps = {
      isToolAllowed: async () => ({ allowed: true }),
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: "t1",
      agent_slug: "meta_ads",
      baseCallCtx: { tenant_id: "t1", run_id: "r1" },
      onEvent: () => {},
      variants_lab: true,
      draft_mode: true,
    };
    return { dispatch: makeDispatchTool(deps), callSpy };
  };

  it("these names are declared reads", () => {
    const effects = internalToolEffects();
    for (const n of READS_WITH_A_WRITE_VERB_IN_THE_NAME) expect(isLabDeniedTool(n, effects), n).toBe(false);
  });

  it.each(READS_WITH_A_WRITE_VERB_IN_THE_NAME)("runs the declared read %s", async (name) => {
    const { dispatch, callSpy } = labDraft();
    const res = await dispatch({ tool_name: name, input: {}, tool_use_id: "u" });
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });

  it.each(MUST_CATCH)("still denies the write %s", async (name) => {
    const { dispatch, callSpy } = labDraft();
    const res = await dispatch({ tool_name: name, input: {}, tool_use_id: "u" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ denied: true, code: LAB_DENY_CODE });
  });

  it("a draft that is NOT a lab run keeps the name-fragment classifier (best-of-N unchanged)", async () => {
    const ok: McpCallResult = { ok: true, content: "{}", is_error: false, ms: 1 };
    const callSpy = vi.fn().mockResolvedValue(ok);
    const dispatch = makeDispatchTool({
      isToolAllowed: async () => ({ allowed: true }),
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: "t1",
      agent_slug: "meta_ads",
      baseCallCtx: { tenant_id: "t1", run_id: "r1" },
      onEvent: () => {},
      draft_mode: true,
    });
    const res = await dispatch({ tool_name: "growth__read_action_outcomes", input: {}, tool_use_id: "u" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ denied: true, code: "best_of_n_draft_readonly" });
  });

  it("the SDK hook passes the scoreboard read on a lab draft and still denies it on a plain draft", async () => {
    const run = (variants_lab: boolean | undefined) =>
      preToolUsePolicyHook({
        isAgentKilled: async () => false,
        emitThreadEvent: vi.fn(async () => {}) as never,
        ctx: {
          tenant_id: "t1",
          agent: { slug: "meta_ads" },
          runId: "r1",
          killed: { value: false },
          iter: { value: 1 },
          variants_lab,
          draft_mode: true,
        } as never,
        hookInput: {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__server__growth__read_action_outcomes",
          tool_input: {},
          tool_use_id: "u",
          cwd: "/tmp",
          permission_mode: "default",
          session_id: "s",
          transcript_path: "/tmp/t",
        } as never,
      });
    expect(await run(true)).toEqual({ continue: true });
    expect((await run(undefined) as { reason?: string }).reason).toBe("best_of_n_draft_readonly");
  });
});

describe("lab stand-ins and the gate (lab-simulate.ts)", () => {
  const STAND_INS = ["report__render_social_image", "growth__propose_creative_brief"];

  it("outside a lab case the two stand-in tools are denied like any other write", () => {
    for (const n of STAND_INS) expect(isLabDeniedTool(n), n).toBe(true);
  });

  it("inside a lab case they pass the gate, and every other must-catch write is still denied", async () => {
    await withLabReadCache(newLabReadCache(), async () => {
      for (const n of STAND_INS) {
        expect(isLabDeniedTool(n), n).toBe(false);
        expect(isLabDeniedTool(`mcp__server__${n}`), n).toBe(false);
      }
      for (const n of MUST_CATCH) expect(isLabDeniedTool(n), n).toBe(true);
    });
  });
});
