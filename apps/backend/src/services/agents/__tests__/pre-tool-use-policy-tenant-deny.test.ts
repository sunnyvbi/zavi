
import { describe, it, expect, vi, type Mock } from "vitest";
import { preToolUsePolicyHook } from "../pre-tool-use-policy";
import type { PreToolUsePolicyCtx, PreToolUsePolicyDeps } from "../pre-tool-use-policy";

type EmitArgs = Parameters<PreToolUsePolicyDeps["emitThreadEvent"]>;
type EmitRet = ReturnType<PreToolUsePolicyDeps["emitThreadEvent"]>;
type MockEmit = Mock<EmitArgs, EmitRet> & PreToolUsePolicyDeps["emitThreadEvent"];
const makeMockEmit = (
  impl: (...args: EmitArgs) => EmitRet = async () => {},
): MockEmit => vi.fn(impl) as MockEmit;

function makeCtx(overrides?: Partial<PreToolUsePolicyCtx>): PreToolUsePolicyCtx {
  return {
    tenant_id: "tenant-abc",
    agent: { slug: "chief-of-staff" },
    runId: "run-123",
    thread_id: "thread-456",
    killed: { value: false },
    iter: { value: 1 },
    ...overrides,
  };
}

const hookInput = {
  hook_event_name: "PreToolUse" as const,
  tool_name: "web_search__search",
  tool_input: { query: "x" },
  tool_use_id: "tool-use-id-789",
  cwd: "/tmp",
  permission_mode: "default" as const,
  session_id: "session-id",
  transcript_path: "/tmp/transcript",
};

describe("preToolUsePolicyHook — tenant_tool_deny gate (P1)", () => {
  it("denies with permissionDecisionReason from registry when isToolAllowed returns allowed:false", async () => {
    const result = await preToolUsePolicyHook({
      isAgentKilled: async () => false,
      isToolAllowed: async () => ({
        allowed: false,
        reason: "tool denied by tenant policy (scope: agent chief-of-staff)",
      }),
      emitThreadEvent: makeMockEmit(),
      ctx: makeCtx(),
      hookInput,
    });
    expect(result).toMatchObject({
      reason: "tenant_tool_deny",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "tool denied by tenant policy (scope: agent chief-of-staff)",
      },
    });
  });

  it("falls through to next gate when isToolAllowed returns allowed:true", async () => {
    const isAgentKilled = vi.fn(async () => false);
    const result = await preToolUsePolicyHook({
      isAgentKilled,
      isToolAllowed: async () => ({ allowed: true }),
      emitThreadEvent: makeMockEmit(),
      ctx: makeCtx(),
      hookInput,
    });
    expect(result).toEqual({ continue: true });
    expect(isAgentKilled).toHaveBeenCalledOnce();
  });

  it("skips the gate (preserves pre-P1 behavior) when isToolAllowed is not supplied", async () => {
    const result = await preToolUsePolicyHook({
      isAgentKilled: async () => false,
      emitThreadEvent: makeMockEmit(),
      ctx: makeCtx(),
      hookInput,
    });
    expect(result).toEqual({ continue: true });
  });

  it("kill check runs BEFORE tenant deny (a killed run stops even on a tenant-denied call)", async () => {
    const isAgentKilled = vi.fn(async () => true);
    const killed = await preToolUsePolicyHook({
      isAgentKilled,
      isToolAllowed: async () => ({ allowed: false, reason: "compliance hold (scope: tenant-wide)" }),
      emitThreadEvent: makeMockEmit(),
      ctx: makeCtx(),
      hookInput,
    });
    expect(killed).toMatchObject({ continue: false, reason: "kill_switch" });
  });

  it("tenant deny without a kill: denies the one tool, the run goes on", async () => {
    const isAgentKilled = vi.fn(async () => false);
    const result = await preToolUsePolicyHook({
      isAgentKilled,
      isToolAllowed: async () => ({
        allowed: false,
        reason: "compliance hold (scope: tenant-wide)",
      }),
      emitThreadEvent: makeMockEmit(),
      ctx: makeCtx(),
      hookInput,
    });
    expect(result).toMatchObject({
      reason: "tenant_tool_deny",
    });
    expect(result.continue).toBeUndefined();
    expect(isAgentKilled).toHaveBeenCalled();
  });
});
