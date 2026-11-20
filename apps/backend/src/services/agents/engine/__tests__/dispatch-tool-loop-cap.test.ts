
import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import type { EngineEvent, EngineToolCall } from "../types";
import type { McpCallResult } from "@/services/mcp/types";

function baseDeps(overrides: Partial<MakeDispatchToolDeps> = {}) {
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
    agent_slug: "qa",
    baseCallCtx: { tenant_id: "t1", run_id: "r1" },
    onEvent: (e) => events.push(e),
    iter: { value: 0 },
    ...overrides,
  };
  return { deps, events, callSpy };
}

function searchCall(query: string, i: number): EngineToolCall {
  return {
    tool_name: "github__search_code",
    input: { query },
    tool_use_id: `tu-${i}`,
  };
}

describe("makeDispatchTool — runaway repeated-tool-loop cap (fleet C)", () => {
  it("SAME (tool,input) past the cap → synthetic STOP/summarize result + ZERO further callMcpTool (qa runaway repro)", async () => {
    const { deps, callSpy } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);

    let firstCappedAt = -1;
    const totalCalls = 50;
    let cappedCount = 0;
    for (let i = 0; i < totalCalls; i++) {
      const res = await dispatchTool(searchCall("respondToCarReview", i));
      if (res.code === "repeat_tool_loop_capped") {
        if (firstCappedAt === -1) firstCappedAt = i;
        cappedCount += 1;
        expect(res.denied).toBe(true);
        expect(res.content).toContain("STOP");
        expect(res.content.toLowerCase()).toContain("summarize");
        expect(res.content).toContain("github__search_code");
      }
    }

    expect(firstCappedAt).toBeGreaterThan(0);
    expect(firstCappedAt).toBeLessThan(15);
    expect(cappedCount).toBeGreaterThan(0);
    expect(callSpy.mock.calls.length).toBe(firstCappedAt);
    expect(callSpy.mock.calls.length).toBeLessThan(totalCalls);
  });

  it("N DISTINCT searches are NOT capped early (legit different queries pass through)", async () => {
    const { deps, callSpy } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);

    for (let i = 0; i < 30; i++) {
      const res = await dispatchTool(searchCall(`distinct-query-${i}`, i));
      expect(res.code).not.toBe("repeat_tool_loop_capped");
      expect(res.is_error).toBe(false);
    }
    expect(callSpy).toHaveBeenCalledTimes(30);
  });

  it("input key ORDER does not matter — {a,b} and {b,a} count as the SAME call", async () => {
    const { deps, callSpy } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);

    let capped = false;
    for (let i = 0; i < 40; i++) {
      const input =
        i % 2 === 0
          ? { query: "x", path: "src" }
          : { path: "src", query: "x" };
      const res = await dispatchTool({
        tool_name: "github__search_code",
        input,
        tool_use_id: `tu-${i}`,
      });
      if (res.code === "repeat_tool_loop_capped") capped = true;
    }
    expect(capped).toBe(true);
    expect(callSpy.mock.calls.length).toBeLessThan(15);
  });

  it("repeated identical ERROR-CODE triggers the cap even when inputs DIFFER", async () => {
    const errResult: McpCallResult = {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "secondary_rate_limit_403" }),
      ms: 4,
    };
    const callSpy = vi.fn().mockResolvedValue(errResult);
    const { deps } = baseDeps({
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    });
    const dispatchTool = makeDispatchTool(deps);

    let capped = false;
    let firstCappedAt = -1;
    for (let i = 0; i < 40; i++) {
      const res = await dispatchTool(searchCall(`q-${i}`, i));
      if (res.code === "repeat_tool_loop_capped") {
        capped = true;
        if (firstCappedAt === -1) firstCappedAt = i;
      }
    }
    expect(capped).toBe(true);
    expect(firstCappedAt).toBeGreaterThan(0);
    expect(firstCappedAt).toBeLessThan(15);
    expect(callSpy.mock.calls.length).toBe(firstCappedAt);
  });

  it("one tool's repeated error does NOT deny a DIFFERENT tool (seo lost its deliverable this way)", async () => {
    const fetchErr: McpCallResult = {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "web_fetch_http_error" }),
      ms: 3,
    };
    const renderOk: McpCallResult = {
      ok: true,
      is_error: false,
      content: JSON.stringify({ artifact_id: "a1" }),
      ms: 5,
    };
    const callSpy = vi.fn(async (_ctx: unknown, server: string) =>
      server === "web_fetch" ? fetchErr : renderOk,
    );
    const { deps } = baseDeps({
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    });
    const dispatchTool = makeDispatchTool(deps);

    for (let i = 0; i < 8; i++) {
      await dispatchTool({
        tool_name: "web_fetch__fetch",
        input: { url: `https://blocked.example.com/p${i}` },
        tool_use_id: `f-${i}`,
      });
    }

    const render = await dispatchTool({
      tool_name: "report__render_blog",
      input: { title: "Page draft" },
      tool_use_id: "render-1",
    });
    expect(render.code).not.toBe("repeat_tool_loop_capped");
    expect(render.is_error).toBe(false);

    const fetchAgain = await dispatchTool({
      tool_name: "web_fetch__fetch",
      input: { url: "https://blocked.example.com/p9" },
      tool_use_id: "f-9",
    });
    expect(fetchAgain.code).toBe("repeat_tool_loop_capped");
    expect(fetchAgain.content).toContain("web_fetch__fetch");
    expect(fetchAgain.content).not.toContain("report__render_blog");
  });

  it("the loop-cap is PER-RUN — a fresh funnel (new run) starts with a clean count", async () => {
    const { deps: depsA, callSpy: spyA } = baseDeps();
    const dispatchA = makeDispatchTool(depsA);
    for (let i = 0; i < 20; i++) await dispatchA(searchCall("same", i));
    const cappedA = spyA.mock.calls.length;
    expect(cappedA).toBeLessThan(20);

    const { deps: depsB, callSpy: spyB } = baseDeps();
    const dispatchB = makeDispatchTool(depsB);
    const res = await dispatchB(searchCall("same", 0));
    expect(res.code).not.toBe("repeat_tool_loop_capped");
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("once capped, post-cap calls keep short-circuiting (no callMcpTool, cap code carried)", async () => {
    const { deps, callSpy } = baseDeps();
    const dispatchTool = makeDispatchTool(deps);
    const results = [];
    for (let i = 0; i < 25; i++) {
      results.push(await dispatchTool(searchCall("loop", i)));
    }
    const capped = results.filter((r) => r.code === "repeat_tool_loop_capped");
    expect(capped.length).toBeGreaterThan(0);
    expect(callSpy.mock.calls.length).toBe(results.length - capped.length);
    for (const r of capped) expect(r.denied).toBe(true);
  });
});
