
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import { __resetCaptureLedgerForTest } from "../capture-ledger";
import type { EngineEvent, EngineToolCall } from "../types";
import type { McpCallResult } from "@/services/mcp/types";

const RUN = "run-probe-1";
const TENANT_ORIGIN = "https://tenant.example";

function probeEmptyShell(finalUrl = `${TENANT_ORIGIN}/`): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "product_probe_empty_shell",
      message: `${finalUrl} returned a client-rendered SPA shell.`,
      meta: { status: 200, final_url: finalUrl },
      final_url: finalUrl,
      status: 200,
      content_type: "text/html",
      target: "marketing",
      body_text: "<untrusted_web_content>[empty_shell]</untrusted_web_content>",
      capture: "empty_shell",
    }),
    ms: 12,
  };
}

function probeSsrfBlocked(): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "web_fetch_network",
      message: "redirect off registered product origin refused",
      target: "marketing",
    }),
    ms: 8,
  };
}

function renderedResult(url: string): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      url,
      title: "Tenant Home",
      http_status: 200,
      content:
        "The real, fully-rendered tenant marketing page with substantial visible copy: " +
        "pricing tiers, feature lists, and long-form product description. ".repeat(6),
      truncated: false,
      original_bytes: 900,
    }),
    ms: 3000,
  };
}

function makeDeps(
  callImpl: (server: string, bare: string, args: unknown) => McpCallResult,
) {
  const events: EngineEvent[] = [];
  const callSpy = vi.fn(
    async (_ctx: unknown, server: string, bare: string, args: unknown) =>
      callImpl(server, bare, args),
  );
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "operator",
    baseCallCtx: { tenant_id: "t1", run_id: RUN },
    onEvent: (e) => events.push(e),
    iter: { value: 0 },
    resolved_tool_names: ["product__probe", "apify__rag_web_browser"],
  };
  return { deps, events, callSpy };
}

describe("dispatch seam: product__probe → render escalation trust boundary", () => {
  beforeEach(() => __resetCaptureLedgerForTest());

  it("IGNORES an injected `url` arg — renders ONLY the server-derived final_url, origin-pinned", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "product" && bare === "probe") return probeEmptyShell();
      if (server === "apify" && bare === "rag_web_browser")
        return renderedResult(`${TENANT_ORIGIN}/`);
      throw new Error(`unexpected call ${server}__${bare}`);
    });

    const attackCall: EngineToolCall = {
      tool_name: "product__probe",
      input: { path: "/", target: "marketing", url: "https://evil.example/steal" },
      tool_use_id: "tu-attack",
    };
    await makeDispatchTool(deps)(attackCall);

    expect(callSpy).toHaveBeenCalledTimes(2);
    const renderArgs = callSpy.mock.calls[1][3] as {
      url: string;
      allowed_origin?: string;
    };
    expect(renderArgs.url).toBe(`${TENANT_ORIGIN}/`);
    expect(renderArgs.url).not.toContain("evil.example");
    expect(renderArgs.allowed_origin).toBe(TENANT_ORIGIN);
  });

  it("does NOT escalate when the probe result carries no capture (off-origin redirect / apex→www)", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "product" && bare === "probe") return probeSsrfBlocked();
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const call: EngineToolCall = {
      tool_name: "product__probe",
      input: { path: "/", target: "marketing" },
      tool_use_id: "tu-ssrf",
    };
    await makeDispatchTool(deps)(call);
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT browser-render an api-target probe", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "product" && bare === "probe") {
        return {
          ...probeEmptyShell(`${TENANT_ORIGIN}/health`),
          content: JSON.stringify({
            error: "product_probe_blocked",
            meta: { status: 403, final_url: `${TENANT_ORIGIN}/health` },
            final_url: `${TENANT_ORIGIN}/health`,
            status: 403,
            target: "api",
            capture: "blocked",
          }),
        };
      }
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const call: EngineToolCall = {
      tool_name: "product__probe",
      input: { path: "/health", target: "api" },
      tool_use_id: "tu-api",
    };
    await makeDispatchTool(deps)(call);
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it("escalates a marketing empty_shell and upgrades the result to rendered", async () => {
    const { deps, callSpy } = makeDeps((server, bare) => {
      if (server === "product" && bare === "probe") return probeEmptyShell();
      if (server === "apify" && bare === "rag_web_browser")
        return renderedResult(`${TENANT_ORIGIN}/`);
      throw new Error(`unexpected call ${server}__${bare}`);
    });
    const call: EngineToolCall = {
      tool_name: "product__probe",
      input: { path: "/", target: "marketing" },
      tool_use_id: "tu-ok",
    };
    const res = await makeDispatchTool(deps)(call);
    expect(callSpy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(res.content) as { capture?: string; body_text?: string };
    expect(parsed.capture).toBe("rendered");
    expect(parsed.body_text).toContain("untrusted_web_content");
  });
});
