
import { describe, it, expect } from "vitest";
import { evaluateToolCallPolicy } from "../tool-call-policy";

const BASELINE_ONLY = ["web_search__search", "web_fetch__fetch", "apify__rag_web_browser"];

describe("evaluateToolCallPolicy", () => {
  it("allows a non-egress tool regardless of co-residency", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "github__get_repo",
      resolved_tool_names: ["github__get_repo", "stripe__get_customer"],
      research_scoped: false,
      agent_slug: "cto-engineer",
      untrusted_inbound: false,
    });
    expect(r.allow).toBe(true);
  });

  it("ALLOWS open-web egress even with a private-data tool co-resident (E-2 block removed 2026-06-03)", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "web_fetch__fetch",
      resolved_tool_names: ["web_fetch__fetch", "stripe__get_customer"],
      research_scoped: false,
      agent_slug: "cto-engineer",
      untrusted_inbound: false,
    });
    expect(r.allow).toBe(true);
  });

  it("ALLOWS open-web egress when only baseline public-web tools are resolved", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "web_fetch__fetch",
      resolved_tool_names: BASELINE_ONLY,
      research_scoped: false,
      agent_slug: "cto-engineer",
      untrusted_inbound: false,
    });
    expect(r.allow).toBe(true);
  });

  it("ALLOWS open-web egress on a research-scoped run even with a private tool", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "web_fetch__fetch",
      resolved_tool_names: ["web_fetch__fetch", "stripe__get_customer"],
      research_scoped: true,
      agent_slug: "research",
      untrusted_inbound: false,
    });
    expect(r.allow).toBe(true);
  });

  it("DENIES operator open-web egress on an untrusted-inbound (email) run (D2)", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "web_fetch__fetch",
      resolved_tool_names: ["web_fetch__fetch"],
      research_scoped: false,
      agent_slug: "operator",
      untrusted_inbound: true,
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("DENIES support-lead open-web egress on an untrusted-inbound (email) run (D2)", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "web_fetch__fetch",
      resolved_tool_names: ["web_fetch__fetch"],
      research_scoped: false,
      agent_slug: "support-lead",
      untrusted_inbound: true,
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("DENIES web_search too, for any agent, on an untrusted-inbound run (D2)", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "web_search__search",
      resolved_tool_names: ["web_search__search"],
      research_scoped: false,
      agent_slug: "cto-engineer",
      untrusted_inbound: true,
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("does NOT deny a NON-egress tool on an untrusted-inbound run (only web egress is killed)", () => {
    const r = evaluateToolCallPolicy({
      tool_name: "email__get_thread",
      resolved_tool_names: ["email__get_thread", "web_fetch__fetch"],
      research_scoped: false,
      agent_slug: "support-lead",
      untrusted_inbound: true,
    });
    expect(r.allow).toBe(true);
  });
});

describe("evaluateToolCallPolicy: shared pages on untrusted turns", () => {
  const base = { resolved_tool_names: ["report__render_artifact"], research_scoped: false, agent_slug: "operator" };
  it("DENIES report__render_artifact on an untrusted-inbound turn", () => {
    for (const tool_name of ["report__render_artifact", "mcp__report__render_artifact"]) {
      const r = evaluateToolCallPolicy({ ...base, tool_name, untrusted_inbound: true });
      expect(r.allow).toBe(false);
    }
  });
  it("ALLOWS it on a normal chat turn", () => {
    const r = evaluateToolCallPolicy({ ...base, tool_name: "report__render_artifact", untrusted_inbound: false });
    expect(r.allow).toBe(true);
  });
});
