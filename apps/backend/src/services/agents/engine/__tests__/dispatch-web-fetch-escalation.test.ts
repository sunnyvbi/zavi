
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import {
  getCaptureLedger,
  recordWebFetchCapture,
  __resetCaptureLedgerForTest,
} from "../capture-ledger";
import type { EngineEvent, EngineToolCall } from "../types";
import type { McpCallResult } from "@/services/mcp/types";

function blockedFetchResult(): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "web_fetch_http_error",
      message: "HTTP 403 from https://blocked.example/page — origin refused.",
      meta: { status: 403, final_url: "https://blocked.example/page" },
      final_url: "https://blocked.example/page",
      status: 403,
      content_type: "text/html",
      body_text: "<untrusted_web_content>[blocked]</untrusted_web_content>",
      capture: "blocked",
    }),
    ms: 10,
  };
}

function renderedResult(): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      url: "https://blocked.example/page",
      title: "Real Page",
      http_status: 200,
      content:
        "Pricing is $99/mo. " +
        "This is the real, fully-rendered competitor page with substantial visible content: " +
        "feature lists, pricing tiers, testimonials, and a long-form product description that a " +
        "real browser render returns once the SPA has hydrated. ".repeat(4),
      truncated: false,
      original_bytes: 600,
    }),
    ms: 4000,
  };
}

function domTextResult(): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      final_url: "https://ok.example/page",
      status: 200,
      content_type: "text/html",
      body_text: "<untrusted_web_content>hello</untrusted_web_content>",
      capture: "dom_text",
    }),
    ms: 8,
  };
}

function apifyError(): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: "rag_web_browser_empty", message: "no items" }),
    ms: 100,
  };
}

function emptyShellResult(): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "web_fetch_empty_shell",
      message:
        "https://spa.example/ returned a client-rendered SPA shell with no readable content.",
      meta: { status: 200, final_url: "https://spa.example/" },
      final_url: "https://spa.example/",
      status: 200,
      content_type: "text/html",
      body_text: "<untrusted_web_content>[empty_shell]</untrusted_web_content>",
      capture: "empty_shell",
    }),
    ms: 12,
  };
}

const RUN = "run-1";

function makeDeps(
  callImpl: (server: string, bare: string, args: unknown) => McpCallResult,
  overrides: Partial<MakeDispatchToolDeps> = {},
) {
  const events: EngineEvent[] = [];
  const callSpy = vi.fn(
    async (_ctx: unknown, server: string, bare: string, args: unknown) => {
      const r = callImpl(server, bare, args);
      if (server === "web_fetch") recordWebFetchCapture(RUN, args, r.content);
      return r;
    },
  );
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "research",
    baseCallCtx: { tenant_id: "t1", run_id: RUN },
    onEvent: (e) => events.push(e),
    iter: { value: 0 },
    resolved_tool_names: ["web_fetch__fetch", "apify__rag_web_browser"],
    ...overrides,
  };
  return { deps, events, callSpy };
}

const fetchCall: EngineToolCall = {
  tool_name: "web_fetch__fetch",
  input: { url: "https://blocked.example/page" },
  tool_use_id: "tu-1",
};

describe("dispatch seam: web-fetch blocked→render escalation", () => {
  beforeEach(() => __resetCaptureLedgerForTest());

  it("blocked fetch auto-escalates ONCE through the funnel and replaces result with a web_fetch envelope", async () => {
    const { deps, events, callSpy } = makeDeps((server, bare) => {
      if (server === "web_fetch" && bare === "fetch") return blockedFetchResult();
      if (server === "apify" && bare === "rag_web_browser") return renderedResult();
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const res = await makeDispatchTool(deps)(fetchCall);

    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(callSpy.mock.calls[1][1]).toBe("apify");
    expect(callSpy.mock.calls[1][2]).toBe("rag_web_browser");
    expect(res.is_error).toBe(false);
    const parsed = JSON.parse(res.content);
    expect(parsed.capture).toBe("rendered");
    expect(parsed.body_text).toMatch(/^<untrusted_web_content>/);
    expect(parsed.body_text).toMatch(/\$99\/mo/);
    expect(parsed.final_url).toBe("https://blocked.example/page");
    expect(parsed.status).toBe(200);
    expect(parsed.content_type).toBe("text/markdown");
    expect(parsed).not.toHaveProperty("http_status");
    expect(parsed).not.toHaveProperty("content");
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(2);
    const ledger = getCaptureLedger(RUN);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].capture).toBe("rendered");
    expect(ledger[0].requested_url).toBe("https://blocked.example/page");
  });

  it("successful dom_text fetch records ledger (via chokepoint) and does NOT escalate", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "web_fetch" && bare === "fetch") return domTextResult();
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const okCall: EngineToolCall = {
      tool_name: "web_fetch__fetch",
      input: { url: "https://ok.example/page" },
      tool_use_id: "tu-ok",
    };
    const res = await makeDispatchTool(deps)(okCall);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.content).capture).toBe("dom_text");
    const ledger = getCaptureLedger(RUN);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].capture).toBe("dom_text");
  });

  it("blocked fetch whose render ALSO fails keeps the blocked (is_error) result + blocked ledger", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "web_fetch" && bare === "fetch") return blockedFetchResult();
      if (server === "apify" && bare === "rag_web_browser") return apifyError();
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const res = await makeDispatchTool(deps)(fetchCall);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("blocked");
    const ledger = getCaptureLedger(RUN);
    expect(ledger[0].capture).toBe("blocked");
  });

  it("escalate-once: a second blocked fetch for the same url fires no second render", async () => {
    let renders = 0;
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "web_fetch" && bare === "fetch") return blockedFetchResult();
      if (server === "apify" && bare === "rag_web_browser") {
        renders += 1;
        return apifyError();
      }
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const dispatch = makeDispatchTool(deps);
    await dispatch(fetchCall);
    await dispatch(fetchCall);
    expect(callSpy).toHaveBeenCalledTimes(3);
    expect(renders).toBe(1);
  });

  it("untrusted_inbound (email) turn does NOT auto-escalate a blocked fetch", async () => {
    const { deps, callSpy } = makeDeps(
      (server, bare) => {
        if (server === "web_fetch" && bare === "fetch") return blockedFetchResult();
        throw new Error(`unexpected call ${server}__${bare}`);
      },
      { untrusted_inbound: true },
    );
    const res = await makeDispatchTool(deps)(fetchCall);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("blocked");
    const ledger = getCaptureLedger(RUN);
    expect(ledger[0].capture).toBe("blocked");
  });

  it("empty_shell fetch auto-escalates to a render and upgrades the ledger to rendered (FIX 2026-06-04)", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "web_fetch" && bare === "fetch") return emptyShellResult();
      if (server === "apify" && bare === "rag_web_browser") return renderedResult();
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const shellCall: EngineToolCall = {
      tool_name: "web_fetch__fetch",
      input: { url: "https://spa.example/" },
      tool_use_id: "tu-shell",
    };
    const res = await makeDispatchTool(deps)(shellCall);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(callSpy.mock.calls[1][1]).toBe("apify");
    const parsed = JSON.parse(res.content);
    expect(res.is_error).toBe(false);
    expect(parsed.capture).toBe("rendered");
    const ledger = getCaptureLedger(RUN);
    expect(ledger[0].capture).toBe("rendered");
  });

  it("competitor_intel__http_fetch blocked result escalates through the SAME funnel path (FIX 2026-06-04)", async () => {
    const events: EngineEvent[] = [];
    const callSpy = vi.fn(
      async (_ctx: unknown, server: string, bare: string, args: unknown) => {
        let r: McpCallResult;
        if (server === "competitor_intel" && bare === "http_fetch") {
          r = {
            ...blockedFetchResult(),
          };
          recordWebFetchCapture(RUN, args, r.content);
          return r;
        }
        if (server === "apify" && bare === "rag_web_browser") return renderedResult();
        throw new Error(`unexpected call ${server}__${bare}`);
      },
    );
    const deps: MakeDispatchToolDeps = {
      isToolAllowed: async () => ({ allowed: true }),
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: "t1",
      agent_slug: "research",
      baseCallCtx: { tenant_id: "t1", run_id: RUN },
      onEvent: (e) => events.push(e),
      iter: { value: 0 },
      resolved_tool_names: ["competitor_intel__http_fetch", "apify__rag_web_browser"],
    };
    const ciCall: EngineToolCall = {
      tool_name: "competitor_intel__http_fetch",
      input: { url: "https://blocked.example/page" },
      tool_use_id: "tu-ci",
    };
    const res = await makeDispatchTool(deps)(ciCall);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(callSpy.mock.calls[1][1]).toBe("apify");
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).capture).toBe("rendered");
  });

  it("render that STILL returns a short shell stays empty_shell — not falsely upgraded to rendered (FIX 2026-06-04, upcar.ai live case)", async () => {
    const shortShellRender = (): McpCallResult => ({
      ok: true,
      is_error: false,
      content: JSON.stringify({
        url: "https://spa.example/",
        http_status: 200,
        content: "Warming up the engine... Get the app",
        truncated: false,
      }),
      ms: 3000,
    });
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "web_fetch" && bare === "fetch") return emptyShellResult();
      if (server === "apify" && bare === "rag_web_browser") return shortShellRender();
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const shellCall: EngineToolCall = {
      tool_name: "web_fetch__fetch",
      input: { url: "https://spa.example/" },
      tool_use_id: "tu-shell2",
    };
    const res = await makeDispatchTool(deps)(shellCall);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("empty_shell");
    const ledger = getCaptureLedger(RUN);
    expect(ledger[0].capture).toBe("empty_shell");
  });

  it("per-run render cap: stops escalating after PER_RUN_RENDER_CAP distinct urls (FIX 2026-06-04)", async () => {
    let renders = 0;
    const callSpy = vi.fn(
      async (_ctx: unknown, server: string, bare: string, args: unknown) => {
        if (server === "web_fetch" && bare === "fetch") {
          const url = (args as { url: string }).url;
          const r: McpCallResult = {
            ok: false,
            is_error: true,
            content: JSON.stringify({
              error: "web_fetch_http_error",
              meta: { status: 403, final_url: url },
              final_url: url,
              status: 403,
              content_type: "text/html",
              body_text: "<untrusted_web_content>[blocked]</untrusted_web_content>",
              capture: "blocked",
            }),
            ms: 5,
          };
          recordWebFetchCapture(RUN, args, r.content);
          return r;
        }
        if (server === "apify" && bare === "rag_web_browser") {
          renders += 1;
          return apifyError();
        }
        throw new Error(`unexpected call ${server}__${bare}`);
      },
    );
    const deps: MakeDispatchToolDeps = {
      isToolAllowed: async () => ({ allowed: true }),
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: "t1",
      agent_slug: "research",
      baseCallCtx: { tenant_id: "t1", run_id: RUN },
      onEvent: () => {},
      iter: { value: 0 },
      resolved_tool_names: ["web_fetch__fetch", "apify__rag_web_browser"],
    };
    const dispatch = makeDispatchTool(deps);
    for (let i = 0; i < 12; i++) {
      await dispatch({
        tool_name: "web_fetch__fetch",
        input: { url: `https://blocked-${i}.example/` },
        tool_use_id: `tu-${i}`,
      });
    }
    expect(renders).toBe(8);
  });

  it("escalation is GATED: an egress deny on the render is not bypassed", async () => {
    const { deps, callSpy } = makeDeps(
      (server, bare) => {
        if (server === "web_fetch" && bare === "fetch") return blockedFetchResult();
        if (server === "apify" && bare === "rag_web_browser") return renderedResult();
        throw new Error(`unexpected call ${server}__${bare}`);
      },
      {
        evaluateToolCallPolicy: ({ tool_name }) =>
          tool_name === "apify__rag_web_browser"
            ? { allow: false, reason: "egress_denied", synthetic_tool_result: "denied" }
            : { allow: true, reason: "ok" },
      },
    );
    const res = await makeDispatchTool(deps)(fetchCall);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("blocked");
    expect(getCaptureLedger(RUN)[0].capture).toBe("blocked");
  });
});
