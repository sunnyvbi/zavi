
import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import {
  shadowSig,
  buildShadowToolResults,
  type ShadowToolResult,
} from "../shadow-tool-policy";
import type { EngineEvent, EngineToolCall } from "../types";
import type { McpCallResult } from "@/services/mcp/types";
import type { ToolCallTrace } from "@/services/tools/types";

function baseDeps(overrides: Partial<MakeDispatchToolDeps> = {}) {
  const events: EngineEvent[] = [];
  const callSpy = vi.fn().mockResolvedValue({
    ok: true,
    content: JSON.stringify({ result: "real-output" }),
    is_error: false,
    ms: 7,
  } as McpCallResult);
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "73db45ff",
    agent_slug: "support-lead",
    baseCallCtx: { tenant_id: "73db45ff", run_id: "shadow-r1" },
    onEvent: (e) => events.push(e),
    iter: { value: 1 },
    ...overrides,
  };
  return { deps, events, callSpy };
}

const mk = (tool_name: string): EngineToolCall => ({ tool_name, input: { q: "x" }, tool_use_id: "tu" });

const trace = (over: Partial<ToolCallTrace>): ToolCallTrace => ({
  name: "memory__search",
  input_preview: JSON.stringify({ q: "x" }),
  output_preview: "cached-output",
  ms: 5,
  status: "ok",
  ...over,
});

describe("P2b dispatch — same-evidence replay", () => {
  it("HIT: serves the captured result, ZERO callMcpTool, code=replayed", async () => {
    const map = new Map<string, ShadowToolResult[]>([
      [shadowSig("memory__search", { q: "x" }), [{ content: "CACHED", is_error: false }]],
    ]);
    const { deps, events, callSpy } = baseDeps({ shadow_mode: true, shadow_tool_results: map });
    const res = await makeDispatchTool(deps)(mk("memory__search"));
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.content).toBe("CACHED");
    expect(res.is_error).toBe(false);
    expect(res.code).toBe("replayed");
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ code: "replayed" });
  });

  it("MISS: deny (shadow_no_captured_evidence), ZERO callMcpTool — fully offline", async () => {
    const map = new Map<string, ShadowToolResult[]>();
    const { deps, callSpy } = baseDeps({ shadow_mode: true, shadow_tool_results: map });
    const res = await makeDispatchTool(deps)(mk("apify__scrape"));
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.code).toBe("shadow_no_captured_evidence");
  });

  it("FIFO: two same-sig results served in order; the 3rd call → deny", async () => {
    const sig = shadowSig("memory__search", { q: "x" });
    const map = new Map<string, ShadowToolResult[]>([
      [sig, [{ content: "first", is_error: false }, { content: "second", is_error: false }]],
    ]);
    const { deps } = baseDeps({ shadow_mode: true, shadow_tool_results: map });
    const d = makeDispatchTool(deps);
    expect((await d(mk("memory__search"))).content).toBe("first");
    expect((await d(mk("memory__search"))).content).toBe("second");
    expect((await d(mk("memory__search"))).code).toBe("shadow_no_captured_evidence");
  });

  it("NO map (shadow_mode only): existing gate-0 — allowlisted read still calls callMcpTool", async () => {
    const { deps, callSpy } = baseDeps({ shadow_mode: true });
    const res = await makeDispatchTool(deps)(mk("memory__search"));
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });

  it("live (no shadow_mode): map ignored, normal execution", async () => {
    const map = new Map<string, ShadowToolResult[]>();
    const { deps, callSpy } = baseDeps({ shadow_tool_results: map });
    const res = await makeDispatchTool(deps)(mk("slack__post_message"));
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });
});

describe("buildShadowToolResults — keystone allowlist filter + skips", () => {
  it("KEYSTONE: stripe / composio / growth__read_cohort results are EXCLUDED from the map", () => {
    const map = buildShadowToolResults([
      trace({ name: "stripe__list", input_preview: JSON.stringify({ a: 1 }), output_preview: "$$$" }),
      trace({ name: "composio__anything", input_preview: JSON.stringify({ a: 1 }) }),
      trace({ name: "growth__read_cohort", input_preview: JSON.stringify({ a: 1 }) }),
    ]);
    expect(map.size).toBe(0);
  });

  it("includes an allowlisted read; key matches the dispatch shadowSig", () => {
    const map = buildShadowToolResults([
      trace({ name: "memory__search", input_preview: JSON.stringify({ q: "x" }), output_preview: "OUT" }),
    ]);
    const hit = map.get(shadowSig("memory__search", { q: "x" }));
    expect(hit).toEqual([{ content: "OUT", is_error: false }]);
  });

  it("skips a TRUNCATED input_preview (can't match faithfully → deny-on-miss)", () => {
    const map = buildShadowToolResults([
      trace({ name: "memory__search", input_preview: '{"q":"xxxx…[truncated 9000 bytes]' }),
    ]);
    expect(map.size).toBe(0);
  });

  it("skips an unparseable input_preview", () => {
    const map = buildShadowToolResults([
      trace({ name: "memory__search", input_preview: "not json {{{" }),
    ]);
    expect(map.size).toBe(0);
  });

  it("defensively unwraps a {\"input\":{...}} wrapper so the sig matches the engine's call.input", () => {
    const map = buildShadowToolResults([
      trace({ name: "memory__search", input_preview: JSON.stringify({ input: { q: "x" } }), output_preview: "U" }),
    ]);
    expect(map.get(shadowSig("memory__search", { q: "x" }))).toEqual([{ content: "U", is_error: false }]);
  });

  it("SDK-wrapped source name (mcp__server__meta_ads__list_campaigns) maps to the BARE dispatch key (codex bug)", () => {
    const map = buildShadowToolResults([
      trace({ name: "mcp__server__meta_ads__list_campaigns", input_preview: JSON.stringify({ acct: "1" }), output_preview: "CAMPAIGNS" }),
    ]);
    expect(map.get(shadowSig("meta_ads__list_campaigns", { acct: "1" }))).toEqual([
      { content: "CAMPAIGNS", is_error: false },
    ]);
  });

  it("status!=ok → is_error true on the replayed result", () => {
    const map = buildShadowToolResults([
      trace({ name: "memory__search", input_preview: JSON.stringify({ q: "x" }), output_preview: "E", status: "tool_error" }),
    ]);
    expect(map.get(shadowSig("memory__search", { q: "x" }))![0].is_error).toBe(true);
  });
});
