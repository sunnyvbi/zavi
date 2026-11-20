import { describe, it, expect } from "vitest";
import { internalToolEffects, allAdvertisableInternalTools, hiddenInternalWriteTools } from "../tool-effects";
import { isSideEffectingTool, INTERNAL_SERVERS } from "../tool-effect-classifier";
import { GOVERNED_EXTERNAL_SERVERS, SELF_GOVERNED_PROPOSALS, TOOL_DECISION_CLASS, resolveGovernanceVerdict } from "../governance-verdict";
import { isReadOnlyToolName } from "@/services/agents/deepagent/tool-bridge";
import { toAnthropicName } from "../types";

const EFFECTS = new Set(["read", "write", "money", "destructive"]);

function split(key: string): { server_id: string; tool_name: string } {
  const i = key.indexOf("__");
  return { server_id: key.slice(0, i), tool_name: key.slice(i + 2) };
}

const INTENDED_LEDGER_CHANGES: Record<string, string> = {
  connectors__request: "records a Connect-card request the user sees",
  operator_db__catalog: "lists the operator DB's tables/collections; read-only",
  operator_db__query_user: "read-only lookup of one user row",
  operator_db__query_listing: "read-only lookup of one listing row",
  operator_db__query_recent_transactions: "read-only transaction read",
  operator_db__query_bookings_by_geo_category: "read-only aggregate",
  operator_db__query_active_supply_by_geo_category: "read-only aggregate",
  operator_db__query_funnel_by_geo_category: "read-only aggregate",
  operator_db__query_verified_bookings_by_campaign: "read-only aggregate",
  operator_db__query_new_users: "read-only count",
  operator_db__query_new_bookings: "read-only count",
  operator_db__codeact: "SELECT/CTE reads in a READ ONLY transaction + Python in a no-egress sandbox",
  memory__read: "returns memory notes by id (agentic read)",
  meta_ads__daily_series: "reads day-by-day Meta insights",
  meta_ads__recent_changes: "reads the Meta account activity log",
  growth__diagnose_funnel: "read-only funnel diagnosis over operator_db reads",
  growth__seo_audit: "fetches public pages; only caches a snapshot of its own measurements",
  growth__liquidity_gap: "read-only supply/demand gap computation",
  growth__content_punchlist: "read-only content gap list",
  growth__marketplace_intelligence: "read-only market data lookup",
  reddit__thread_read: "renders a public Reddit permalink",
  jira__search: "JQL search",
  jira__count: "JQL count",
  jira__lookup_account_id: "user lookup",
  jira__atlassian_user_info: "identity of the connected Atlassian user",
  linear__search: "issue search (GraphQL query)",
  qa_engineer__count_test_cases: "counts the tenant's test cases",
  praxis__second_opinion: "switched off; calls nothing, stores nothing",
};

const INTENDED_BRIDGE_CHANGES: Record<string, string> = {
  growth__propose_creative_brief: "writes a creative brief row",
  connectors__request: "records a Connect-card request the user sees",
  reddit__thread_read: "renders a public Reddit permalink",
  jira__count: "JQL count",
  jira__lookup_account_id: "user lookup",
  jira__atlassian_user_info: "identity of the connected Atlassian user",
  qa_engineer__count_test_cases: "counts the tenant's test cases",
  praxis__second_opinion: "switched off; calls nothing, stores nothing",
};

const NEVER_ADVERTISED_WRITES: Record<string, string> = {
  github__push_branch: "autopilot refine-gate, after the provisioned-repo gate",
  github__open_pr_from_branch: "autopilot refine-gate resolver, after the provisioned-repo gate",
  github__update_pr_branch: "dispatch-decision, after the engineer_pr_followup authorization gate",
  github__post_review: "dispatch-decision (workers/functions/dispatch-decision.ts)",
  github__request_changes: "dispatch-decision (workers/functions/dispatch-decision.ts)",
  github__add_label: "refine-gate, provisioned-repo carve-out in governance-enforce.ts",
  github__close_pr: "cto:e2e test cleanup; declared by no agent",
};

describe("internal tool effect declarations", () => {
  const effects = internalToolEffects();

  it("a. every advertisable tool (all flag variants) and every hidden write has a valid declaration", () => {
    const advertised = allAdvertisableInternalTools();
    const undeclared = advertised.filter((t) => t.effect === undefined).map((t) => toAnthropicName(t.server_id, t.tool_name));
    expect(undeclared).toEqual([]);
    for (const t of advertised) {
      expect(effects.get(toAnthropicName(t.server_id, t.tool_name))).toBe(t.effect);
    }
    for (const t of hiddenInternalWriteTools()) {
      expect(effects.get(toAnthropicName(t.server_id, t.tool_name))).toBe(t.effect);
    }
    for (const [key, effect] of effects) {
      expect(EFFECTS.has(effect), key).toBe(true);
    }
    for (const key of ["memory__search", "memory__write", "memory__list_topics", "memory__read", "connectors__request"]) {
      expect(effects.has(key), key).toBe(true);
    }
    expect(effects.get("github__squash_merge")).toBe("write");
    expect(effects.get("jira__create_issue")).toBe("write");
    expect(effects.get("linear__add_comment")).toBe("write");
  });

  it("a. covers every internal server and nothing outside them", () => {
    const servers = new Set([...effects.keys()].map((k) => split(k).server_id));
    expect([...INTERNAL_SERVERS].filter((s) => !servers.has(s))).toEqual([]);
    expect([...servers].filter((s) => !INTERNAL_SERVERS.has(s))).toEqual([]);
  });

  it("b. isSideEffectingTool equals the declaration for every internal tool", () => {
    const mismatches: string[] = [];
    for (const [key, effect] of effects) {
      const { server_id, tool_name } = split(key);
      if ((effect !== "read") !== isSideEffectingTool(server_id, tool_name)) mismatches.push(key);
    }
    expect(mismatches).toEqual([]);
  });

  it("b. the deep-agent read-only filter equals the declaration for every internal tool", () => {
    const mismatches: string[] = [];
    for (const [key, effect] of effects) {
      if ((effect === "read") !== isReadOnlyToolName(key)) mismatches.push(key);
    }
    expect(mismatches).toEqual([]);
  });

  it("b. every intended behavior change is a real declared tool and classifies as declared", () => {
    for (const key of Object.keys(INTENDED_LEDGER_CHANGES)) {
      const { server_id, tool_name } = split(key);
      expect(effects.has(key), key).toBe(true);
      expect(isSideEffectingTool(server_id, tool_name), key).toBe(effects.get(key) !== "read");
    }
    for (const key of Object.keys(INTENDED_BRIDGE_CHANGES)) {
      expect(effects.has(key), key).toBe(true);
      expect(isReadOnlyToolName(key), key).toBe(effects.get(key) === "read");
    }
  });

  it("b. falsifiers: the writes the old heuristics let through are writes now", () => {
    expect(isReadOnlyToolName("growth__propose_creative_brief")).toBe(false);
    expect(isReadOnlyToolName("connectors__request")).toBe(false);
    expect(isSideEffectingTool("connectors", "request")).toBe(true);
  });

  it("b. falsifier: an undeclared tool on an internal server is a write everywhere", () => {
    for (const [server_id, tool_name] of [
      ["growth", "list_everything_new"],
      ["web_search", "search_v2"],
      ["jira", "get_new_thing"],
    ]) {
      expect(effects.has(`${server_id}__${tool_name}`)).toBe(false);
      expect(isSideEffectingTool(server_id, tool_name), tool_name).toBe(true);
      expect(isReadOnlyToolName(`${server_id}__${tool_name}`), tool_name).toBe(false);
    }
  });

  it("b. falsifier: jira / linear declared reads are no longer governed as writes", () => {
    const internal = (s: string) => INTERNAL_SERVERS.has(s);
    for (const key of ["jira__search", "jira__count", "jira__lookup_account_id", "jira__atlassian_user_info", "linear__search"]) {
      const { server_id, tool_name } = split(key);
      expect(resolveGovernanceVerdict(server_id, tool_name, internal).governed, key).toBe(false);
    }
    expect(resolveGovernanceVerdict("jira", "create_issue", internal).governed).toBe(true);
    expect(resolveGovernanceVerdict("linear", "create_issue", internal).governed).toBe(true);
  });

  it("b. growth__propose_creative_brief is declared a write", () => {
    expect(effects.get("growth__propose_creative_brief")).toBe("write");
  });

  it("c. every non-read tool on a governed external server has a decision class, is a never-advertised write, or is a self-governed proposal", () => {
    const advertised = new Set(allAdvertisableInternalTools().map((t) => toAnthropicName(t.server_id, t.tool_name)));
    const hidden = new Set(hiddenInternalWriteTools().map((t) => toAnthropicName(t.server_id, t.tool_name)));
    const ungoverned: string[] = [];
    for (const [key, effect] of effects) {
      if (!GOVERNED_EXTERNAL_SERVERS.has(split(key).server_id) || effect === "read") continue;
      if (key in TOOL_DECISION_CLASS) continue;
      if (key in NEVER_ADVERTISED_WRITES) continue;
      if (key in SELF_GOVERNED_PROPOSALS) continue;
      if (key === "email__plan_send") continue;
      ungoverned.push(key);
    }
    expect(ungoverned).toEqual([]);
    expect(resolveGovernanceVerdict("email", "plan_send", (s) => INTERNAL_SERVERS.has(s))).toEqual({ governed: true, decision_class: null, mapped: false });
    for (const key of Object.keys(NEVER_ADVERTISED_WRITES)) {
      expect(hidden.has(key), `${key} must be a hidden write`).toBe(true);
      expect(advertised.has(key), `${key} must never be advertised`).toBe(false);
      expect(effects.get(key), key).not.toBe("read");
      expect(key in TOOL_DECISION_CLASS, `${key} is mapped; drop it from the allowlist`).toBe(false);
    }
  });
});

describe("self-governed proposals on governed servers", () => {
  const effects = internalToolEffects();
  const internal = (s: string) => INTERNAL_SERVERS.has(s);

  it("the list is exactly this; adding one is a reviewed edit here", () => {
    expect(Object.keys(SELF_GOVERNED_PROPOSALS).sort()).toEqual(["email__propose_campaign"]);
  });

  it("every entry is a declared propose_* write on a governed server, with no decision class and a reason", () => {
    for (const [key, reason] of Object.entries(SELF_GOVERNED_PROPOSALS)) {
      const { server_id, tool_name } = split(key);
      expect(GOVERNED_EXTERNAL_SERVERS.has(server_id), `${key}: only a governed server needs a carve-out`).toBe(true);
      expect(tool_name.startsWith("propose_"), `${key}: only a proposal may be carved out`).toBe(true);
      expect(effects.has(key), `${key} must be a declared tool`).toBe(true);
      expect(effects.get(key), key).not.toBe("read");
      expect(key in TOOL_DECISION_CLASS, `${key} has a class: it would be double-gated`).toBe(false);
      expect(key in NEVER_ADVERTISED_WRITES, key).toBe(false);
      expect(reason.trim().length, `${key} needs a reason`).toBeGreaterThan(20);
      expect(resolveGovernanceVerdict(server_id, tool_name, internal), key).toEqual({ governed: false, decision_class: null, mapped: false, self_governed: true });
    }
  });

  it("the real write next to it stays governed: email__send", () => {
    expect(resolveGovernanceVerdict("email", "send", internal)).toEqual({ governed: true, decision_class: "send_email", mapped: true });
  });

  it("falsifier: an unlisted propose_* write on a governed server is still governed (fail-closed)", () => {
    expect(resolveGovernanceVerdict("email", "propose_blast", internal)).toEqual({ governed: true, decision_class: null, mapped: false });
    expect(resolveGovernanceVerdict("slack", "propose_campaign", internal).governed).toBe(true);
  });
});

describe("effectOf covers tools with no static list", () => {
  it("a synthesized tenant routine is a write; an unknown tool is a write; a declared read stays read", async () => {
    const { effectOf, TENANT_ROUTINE_SERVER_ID } = await import("../tool-effects");
    const { ROUTINE_SERVER_ID } = await import("@/services/routines/tool-name");
    expect(TENANT_ROUTINE_SERVER_ID).toBe(ROUTINE_SERVER_ID);
    expect(effectOf("tenant_skill", "operator__deadbeef")).toBe("write");
    expect(effectOf("nope", "nothing")).toBe("write");
    expect(effectOf("stripe", "list_charges")).toBe("read");
    expect(effectOf("stripe", "submit_dispute_evidence")).toBe("destructive");
  });
});
