
import { describe, it, expect, vi } from "vitest";

vi.mock("../../tool-call-policy", () => ({
  evaluateToolCallPolicy: () => {
    throw new Error("boom: deterministic predicate errored");
  },
}));

import { failClosed, preToolUsePolicyHook } from "../../pre-tool-use-policy";
import type {
  PreToolUsePolicyCtx,
  PreToolUsePolicyDeps,
} from "../../pre-tool-use-policy";

describe("invariant: PreToolUse fails CLOSED on deterministic predicates", () => {
  describe("failClosed mechanism", () => {
    it("returns the predicate's value on success", () => {
      expect(failClosed("ok", () => true, false)).toBe(true);
      expect(failClosed("ok", () => ({ deny: false }), { deny: true })).toEqual({
        deny: false,
      });
    });

    it("returns the deny-forcing onThrow value when the predicate throws", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        failClosed(
          "throws",
          () => {
            throw new Error("db down");
          },
          true,
        ),
      ).toBe(true);
      expect(
        failClosed(
          "throws",
          (): { deny: boolean } => {
            throw new Error("parse error");
          },
          { deny: true },
        ),
      ).toEqual({ deny: true });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it("DENIES the tool when a deterministic predicate throws (not continue:true)", async () => {
    const emit = vi.fn(async () => {}) as unknown as PreToolUsePolicyDeps["emitThreadEvent"];
    const ctx: PreToolUsePolicyCtx = {
      tenant_id: "t-1",
      agent: { slug: "smoke-echo" },
      runId: "run-1",
      thread_id: "th-1",
      killed: { value: false },
      iter: { value: 1 },
      resolved_tool_names: ["mcp__sandbox__bash"],
    };
    const result = await preToolUsePolicyHook({
      isAgentKilled: async () => false,
      emitThreadEvent: emit,
      ctx,
      hookInput: {
        hook_event_name: "PreToolUse" as const,
        tool_name: "mcp__sandbox__bash",
        tool_input: { command: "ls" },
        tool_use_id: "tu-1",
        cwd: "/tmp",
        permission_mode: "default" as const,
        session_id: "s-1",
        transcript_path: "/tmp/t",
      },
    });
    expect(result.continue).toBeUndefined();
    const out = result.hookSpecificOutput as { permissionDecision?: string } | undefined;
    expect(out?.permissionDecision).toBe("deny");
  });
});
