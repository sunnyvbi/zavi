
import { describe, it, expect } from "vitest";
import {
  decideEgress,
  isEgressTool,
  carriesPrivateData,
  carriesWriteOrPii,
  EGRESS_TOOLS,
  ORDERED_WEB_EXEMPT_AGENTS,
  isOrderedWebExemptAgent,
} from "../egress-policy";
import {
  READ_BASELINE,
  isReadBaselineTool,
  effectiveDeclaredTools,
} from "../write-allowlist";

const WEB_FETCH = "web_fetch__fetch";
const WEB_SEARCH = "web_search__search";
const APIFY_RAG = "apify__rag_web_browser";

const A_WRITE = "praxis__action";
const A_PII_READ_WRITE = "memory__write";
const A_PRIVATE_READ = "operator_db__query";
const A_SLACK_HISTORY = "slack__get_channel_history";

describe("READ_BASELINE — the universal read-only research set", () => {
  it("contains exactly the three sanitized open-web read tools (no browser-MCP)", () => {
    expect([...READ_BASELINE].sort()).toEqual(
      [WEB_SEARCH, WEB_FETCH, APIFY_RAG].sort(),
    );
    expect(READ_BASELINE.has("browser__action")).toBe(false);
    expect(READ_BASELINE.has("browser_navigate")).toBe(false);
  });

  it("isReadBaselineTool is true only for baseline names", () => {
    expect(isReadBaselineTool(WEB_FETCH)).toBe(true);
    expect(isReadBaselineTool(WEB_SEARCH)).toBe(true);
    expect(isReadBaselineTool(APIFY_RAG)).toBe(true);
    expect(isReadBaselineTool(A_WRITE)).toBe(false);
    expect(isReadBaselineTool("totally__made_up")).toBe(false);
  });
});

describe("effectiveDeclaredTools — declared ∪ READ_BASELINE", () => {
  it("unions the baseline onto a declared set, declared-first, no dupes", () => {
    const eff = effectiveDeclaredTools([A_PRIVATE_READ, A_WRITE]);
    expect(eff.slice(0, 2)).toEqual([A_PRIVATE_READ, A_WRITE]);
    for (const b of READ_BASELINE) expect(eff).toContain(b);
    expect(new Set(eff).size).toBe(eff.length);
  });

  it("does not double-add a baseline tool the agent already declared", () => {
    const eff = effectiveDeclaredTools([WEB_SEARCH, A_PRIVATE_READ]);
    expect(eff.filter((t) => t === WEB_SEARCH)).toHaveLength(1);
  });

  it("resolves the baseline even for a ZERO-declared agent (early-return seam)", () => {
    const eff = effectiveDeclaredTools([]);
    expect([...eff].sort()).toEqual([WEB_SEARCH, WEB_FETCH, APIFY_RAG].sort());
  });
});

describe("carriesPrivateData — fail-safe (only the 3 baseline reads are public)", () => {
  it("baseline public-web read tools are NOT private", () => {
    expect(carriesPrivateData(WEB_FETCH)).toBe(false);
    expect(carriesPrivateData(WEB_SEARCH)).toBe(false);
    expect(carriesPrivateData(APIFY_RAG)).toBe(false);
  });

  it("write / write-self tools are private", () => {
    expect(carriesPrivateData(A_WRITE)).toBe(true);
    expect(carriesPrivateData(A_PII_READ_WRITE)).toBe(true);
    expect(carriesPrivateData("slack__post_message")).toBe(true);
    expect(carriesPrivateData("stripe__create_refund")).toBe(true);
  });

  it("PRIVATE READS are also private (the P1 #2 fix — reads no longer exempt)", () => {
    expect(carriesPrivateData(A_PRIVATE_READ)).toBe(true);
    expect(carriesPrivateData(A_SLACK_HISTORY)).toBe(true);
    expect(carriesPrivateData("github__read_file")).toBe(true);
    expect(carriesPrivateData("memory__search")).toBe(true);
    expect(carriesPrivateData("stripe__list_charges")).toBe(true);
  });

  it("FAIL-SAFE: an unparseable or unknown-remote tool is private", () => {
    expect(carriesPrivateData("no_separator_here")).toBe(true);
    expect(carriesPrivateData("composio__SOME_UNKNOWN_TOOL")).toBe(true);
    expect(carriesPrivateData("pipedream_acme__do_something")).toBe(true);
  });

  it("carriesWriteOrPii is a backward-compat alias for carriesPrivateData", () => {
    expect(carriesWriteOrPii).toBe(carriesPrivateData);
    expect(carriesWriteOrPii(A_SLACK_HISTORY)).toBe(true);
    expect(carriesWriteOrPii(WEB_FETCH)).toBe(false);
  });
});

describe("isEgressTool / EGRESS_TOOLS", () => {
  it("the three baseline open-web tools are egress tools", () => {
    expect(isEgressTool(WEB_FETCH)).toBe(true);
    expect(isEgressTool(WEB_SEARCH)).toBe(true);
    expect(isEgressTool(APIFY_RAG)).toBe(true);
    expect([...EGRESS_TOOLS].sort()).toEqual(
      [WEB_SEARCH, WEB_FETCH, APIFY_RAG].sort(),
    );
  });
  it("non-egress tools are not egress tools", () => {
    expect(isEgressTool(A_WRITE)).toBe(false);
    expect(isEgressTool(A_PRIVATE_READ)).toBe(false);
  });
});

describe("decideEgress — web egress ALWAYS allowed (co-residency block removed 2026-06-03)", () => {
  it("ALLOWS web_fetch even when a write tool co-resides (previously blocked)", () => {
    const d = decideEgress({
      tool_name: WEB_FETCH,
      resolved_tool_names: [WEB_FETCH, A_WRITE, A_PRIVATE_READ],
      research_scoped: false,
    });
    expect(d.allow).toBe(true);
  });

  it("ALLOWS web_search + apify_rag even with a PII write co-resident", () => {
    for (const egress of [WEB_SEARCH, APIFY_RAG]) {
      const d = decideEgress({
        tool_name: egress,
        resolved_tool_names: [egress, A_PII_READ_WRITE],
        research_scoped: false,
      });
      expect(d.allow, `${egress}`).toBe(true);
    }
  });

  it("ALLOWS web_fetch when a private READ tool co-resides (the old exfil-hole case)", () => {
    const d = decideEgress({
      tool_name: WEB_FETCH,
      resolved_tool_names: [WEB_FETCH, WEB_SEARCH, A_SLACK_HISTORY],
      research_scoped: false,
    });
    expect(d.allow).toBe(true);
  });

  it("ALLOWS baseline-only, research-scoped, non-egress, and unclassifiable-co-resident runs alike", () => {
    const cases: Array<Parameters<typeof decideEgress>[0]> = [
      { tool_name: WEB_FETCH, resolved_tool_names: [WEB_FETCH, WEB_SEARCH, APIFY_RAG], research_scoped: false },
      { tool_name: WEB_FETCH, resolved_tool_names: [WEB_FETCH, A_WRITE, A_SLACK_HISTORY], research_scoped: true },
      { tool_name: A_WRITE, resolved_tool_names: [A_WRITE, WEB_FETCH], research_scoped: false },
      { tool_name: WEB_FETCH, resolved_tool_names: [WEB_FETCH, "composio__MYSTERY_TOOL"], research_scoped: false },
    ];
    for (const c of cases) expect(decideEgress(c).allow).toBe(true);
  });
});

describe("ordered-web exemption — allowlist", () => {
  it("the allowlist contains advisor (and is the source of truth)", () => {
    expect(ORDERED_WEB_EXEMPT_AGENTS.has("advisor")).toBe(true);
    expect(isOrderedWebExemptAgent("advisor")).toBe(true);
  });
  it("non-allowlisted agents (and undefined) are NOT exempt", () => {
    expect(isOrderedWebExemptAgent("operator")).toBe(false);
    expect(isOrderedWebExemptAgent("performance-marketer")).toBe(false);
    expect(isOrderedWebExemptAgent(undefined)).toBe(false);
  });
});

describe("decideEgress — operator (and every agent) now gets web even with private tools", () => {
  it("ALLOWS the operator's co-resident web_search (the Turo-lookup case)", () => {
    const d = decideEgress({
      tool_name: WEB_SEARCH,
      resolved_tool_names: [WEB_SEARCH, A_SLACK_HISTORY, A_PRIVATE_READ],
      research_scoped: false,
      agent_slug: "operator",
      private_data_touched: true,
    });
    expect(d.allow).toBe(true);
  });
});

describe("T5 — product__probe is not an open-web egress tool", () => {
  const PRODUCT_PROBE = "product__probe";

  it("product__probe is NOT in EGRESS_TOOLS / EGRESS_TOOL_NAMES", () => {
    expect(EGRESS_TOOLS.has(PRODUCT_PROBE)).toBe(false);
    expect(isEgressTool(PRODUCT_PROBE)).toBe(false);
  });

  it("decideEgress ALLOWS product__probe even co-resident with private-data tools", () => {
    const d = decideEgress({
      tool_name: PRODUCT_PROBE,
      resolved_tool_names: [PRODUCT_PROBE, A_SLACK_HISTORY, A_PRIVATE_READ],
      research_scoped: false,
      agent_slug: "advisor",
      private_data_touched: true,
    });
    expect(d.allow).toBe(true);
  });

  it("the only egress tools remain the 3 open-web reads (product__probe excluded)", () => {
    expect([...EGRESS_TOOLS].sort()).toEqual(
      [WEB_SEARCH, WEB_FETCH, APIFY_RAG].sort(),
    );
  });
});
