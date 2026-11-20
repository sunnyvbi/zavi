import { describe, it, expect } from "vitest";
import { fillTraceFromToolResult, type ToolCallTrace } from "../types";
import { isGuardRefusal, recordGuardDeny } from "../guard-refusal";
import { detectRunEndSignals } from "@/services/team-notes/signals";

const errorBlock = (error: string) => ({ is_error: true, content: [{ type: "text", text: JSON.stringify({ error, message: "m" }) }] });

describe("guard refusals on the SDK trace seam", () => {
  it("keeps a guard refusal's code on the trace, not an ordinary error's", () => {
    const refused: Partial<ToolCallTrace> = {};
    fillTraceFromToolResult(refused, errorBlock("data_access_refused"));
    expect(refused).toMatchObject({ status: "tool_error", code: "data_access_refused" });
    const broken: Partial<ToolCallTrace> = {};
    fillTraceFromToolResult(broken, errorBlock("http_500"));
    expect(broken.code).toBeUndefined();
  });

  it("records a PreToolUse guard deny by tool_use_id, ignores allows and non-guard denies", () => {
    const codes = new Map<string, string>();
    const deny = (reason: string) => ({ reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    const r = deny("memory_grounding_policy");
    expect(recordGuardDeny(codes, { tool_use_id: "a" }, r)).toBe(r);
    recordGuardDeny(codes, { tool_use_id: "b" }, deny("egress_fail_closed"));
    recordGuardDeny(codes, { tool_use_id: "c" }, { reason: "ok", hookSpecificOutput: { permissionDecision: "allow" } });
    expect([...codes]).toEqual([["a", "memory_grounding_policy"]]);
  });

  it("two SDK-seam guard refusals with different inputs in a finished run: no signal", () => {
    const calls = ["q1", "q2"].map((input) => {
      const t: Partial<ToolCallTrace> = { name: "operator_db__query", input_preview: input };
      fillTraceFromToolResult(t, errorBlock("operator_db_read_rejected"));
      return t;
    });
    const r = detectRunEndSignals({ status: "success", error: null, toolCalls: calls, groundingFlags: [], operatorShapes: [], willRetry: false });
    expect(r.signals).toEqual([]);
    expect(isGuardRefusal("egress_denied_untrusted_inbound")).toBe(true);
  });
});
