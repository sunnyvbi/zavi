
import { describe, it, expect, vi } from "vitest";
import { makeDispatchTool, type MakeDispatchToolDeps } from "../dispatch-tool";
import {
  isShadowReadAllowed,
  SHADOW_READ_SERVERS_FOR_TEST,
  SHADOW_DENY_TOOLS_FOR_TEST,
  SHADOW_DENY_CODE,
} from "../shadow-tool-policy";
import { internalToolEffects } from "@/services/mcp/tool-effects";
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
    tenant_id: "73db45ff",
    agent_slug: "support-lead",
    baseCallCtx: { tenant_id: "73db45ff", run_id: "shadow-r1" },
    onEvent: (e) => events.push(e),
    iter: { value: 1 },
    ...overrides,
  };
  return { deps, events, callSpy };
}

const mk = (tool_name: string): EngineToolCall => ({
  tool_name,
  input: { q: "x" },
  tool_use_id: "tu",
});

describe("shadow gate-0 — dispatch funnel", () => {
  it("DENY side-effect tool: synthetic deny + ZERO callMcpTool", async () => {
    const { deps, events, callSpy } = baseDeps({ shadow_mode: true });
    const res = await makeDispatchTool(deps)(mk("slack__post_message"));
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
    expect(res.is_error).toBe(true);
    expect(res.code).toBe(SHADOW_DENY_CODE);
    const tc = events.filter((e) => e.type === "tool_call");
    expect(tc).toHaveLength(1);
    expect(tc[0]).toMatchObject({ code: SHADOW_DENY_CODE });
  });

  it("ALLOW egress read (web_fetch / apify / web_search) after the P1 widen", async () => {
    for (const name of ["web_fetch__fetch", "apify__scrape_instagram", "web_search__search"]) {
      const { deps, callSpy } = baseDeps({ shadow_mode: true });
      const res = await makeDispatchTool(deps)(mk(name));
      expect(callSpy, name).toHaveBeenCalledTimes(1);
      expect(res.denied, name).toBeFalsy();
    }
  });

  it("ALLOW ads read (meta_ads report) but DENY a stripe read (money path stays out)", async () => {
    const ads = baseDeps({ shadow_mode: true });
    const adsRes = await makeDispatchTool(ads.deps)(mk("meta_ads__list_campaigns"));
    expect(ads.callSpy).toHaveBeenCalledTimes(1);
    expect(adsRes.denied).toBeFalsy();

    const stripe = baseDeps({ shadow_mode: true });
    const stripeRes = await makeDispatchTool(stripe.deps)(mk("stripe__list"));
    expect(stripe.callSpy, "stripe read must stay denied").not.toHaveBeenCalled();
    expect(stripeRes.denied).toBe(true);
  });

  it("DENY remote / unknown server (composio wildcard never enters shadow)", async () => {
    for (const name of ["gmail__send", "pipedream_slack__post", "mystery__do"]) {
      const { deps, callSpy } = baseDeps({ shadow_mode: true });
      const res = await makeDispatchTool(deps)(mk(name));
      expect(callSpy, name).not.toHaveBeenCalled();
      expect(res.denied, name).toBe(true);
    }
  });

  it("ALLOW an allowlisted read: callMcpTool runs once", async () => {
    const { deps, callSpy } = baseDeps({ shadow_mode: true });
    const res = await makeDispatchTool(deps)(mk("memory__search"));
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
    expect(res.content).toContain("real-output");
  });

  it("DENY a write tool on an ALLOWED server (operator_db update)", async () => {
    const { deps, callSpy } = baseDeps({ shadow_mode: true });
    const res = await makeDispatchTool(deps)(mk("operator_db__update_record"));
    expect(callSpy).not.toHaveBeenCalled();
    expect(res.denied).toBe(true);
  });

  it("live mode (no shadow_mode) is UNCHANGED — side-effect tool runs", async () => {
    const { deps, callSpy } = baseDeps();
    const res = await makeDispatchTool(deps)(mk("slack__post_message"));
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(res.denied).toBeFalsy();
  });
});

describe("isShadowReadAllowed — policy unit", () => {
  it("allows recognized reads on allowlisted servers", () => {
    expect(isShadowReadAllowed("memory", "search")).toBe(true);
    expect(isShadowReadAllowed("operator_db", "query")).toBe(true);
    expect(isShadowReadAllowed("operator_db", "catalog")).toBe(true);
    expect(isShadowReadAllowed("praxis_corpus", "read_run_output")).toBe(true);
  });
  it("allows egress + ads READS after the P1 widen", () => {
    expect(isShadowReadAllowed("web_fetch", "fetch")).toBe(true);
    expect(isShadowReadAllowed("apify", "scrape_instagram")).toBe(true);
    expect(isShadowReadAllowed("web_search", "search")).toBe(true);
    expect(isShadowReadAllowed("competitor_intel", "http_fetch")).toBe(true);
    expect(isShadowReadAllowed("product", "probe")).toBe(true);
    expect(isShadowReadAllowed("meta_ads", "analyst_brief")).toBe(true);
    expect(isShadowReadAllowed("google_ads", "list_campaigns")).toBe(true);
    expect(isShadowReadAllowed("growth", "diagnose_funnel")).toBe(true);
  });
  it("denies writes, money-path stripe, remotes, and bad shapes", () => {
    expect(isShadowReadAllowed("operator_db", "update_record")).toBe(false);
    expect(isShadowReadAllowed("slack", "post_message")).toBe(false);
    expect(isShadowReadAllowed("stripe", "list")).toBe(false);
    expect(isShadowReadAllowed("stripe", "get")).toBe(false);
    expect(isShadowReadAllowed("meta_ads", "create_campaign")).toBe(false);
    expect(isShadowReadAllowed("meta_ads", "propose_budget_change")).toBe(false);
    expect(isShadowReadAllowed("growth", "propose_creative_brief")).toBe(false);
    expect(isShadowReadAllowed("memory", "get_anything")).toBe(false);
    expect(isShadowReadAllowed("gmail", "send")).toBe(false);
    expect(isShadowReadAllowed("composio", "anything")).toBe(false);
    expect(isShadowReadAllowed(undefined, "x")).toBe(false);
    expect(isShadowReadAllowed("memory", undefined)).toBe(false);
  });
  it("denies growth__read_cohort (classified a read but hits Stripe) while other growth reads pass", () => {
    expect(isShadowReadAllowed("growth", "read_cohort")).toBe(false);
    expect(SHADOW_DENY_TOOLS_FOR_TEST.has("growth__read_cohort")).toBe(true);
    expect(isShadowReadAllowed("growth", "constraint_diagnosis")).toBe(true);
    expect(isShadowReadAllowed("growth", "diagnose_funnel")).toBe(true);
  });
});

describe("keep-in-sync invariants", () => {
  it("money-path stripe + remote/composio stay OFF the allowlist", () => {
    for (const denied of ["stripe", "composio", "higgsfield", "pipedream", "gmail", "buffer", "email"]) {
      expect(SHADOW_READ_SERVERS_FOR_TEST.has(denied), denied).toBe(false);
    }
  });
  it("the P1 egress + ads read servers ARE on the allowlist (Ravi-approved widen)", () => {
    for (const allowed of [
      "web_fetch", "web_search", "apify", "competitor_intel", "product",
      "google_ads", "meta_ads", "paid_acquisition", "growth",
    ]) {
      expect(SHADOW_READ_SERVERS_FOR_TEST.has(allowed), allowed).toBe(true);
    }
  });
  it("every allowlisted server has at least one DECLARED read tool (not a write-only server)", () => {
    const readServers = new Set(
      [...internalToolEffects()].filter(([, e]) => e === "read").map(([k]) => k.slice(0, k.indexOf("__"))),
    );
    for (const server of SHADOW_READ_SERVERS_FOR_TEST) {
      expect(readServers.has(server), server).toBe(true);
    }
  });
});

describe("shadow runs never send tenant data out through a declared read", () => {
  it("operator_db codeact is denied; a plain operator_db read is not", async () => {
    const { isShadowReadAllowed } = await import("../shadow-tool-policy");
    expect(isShadowReadAllowed("operator_db", "codeact")).toBe(false);
    expect(isShadowReadAllowed("operator_db", "catalog")).toBe(true);
  });
});
