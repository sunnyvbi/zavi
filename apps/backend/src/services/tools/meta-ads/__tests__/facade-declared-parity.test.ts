
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listMetaAdsTools } from "@/services/mcp/internal/meta-ads";

const AGENTS_DIR = join(__dirname, "..", "..", "..", "..", "agents");

function declaredToolItems(agentMd: string): Set<string> {
  const parts = agentMd.split(/^---$/m);
  const frontmatter = parts.length > 1 ? parts[1] : "";
  const items = new Set<string>();
  for (const m of frontmatter.matchAll(/^\s*-\s+([a-z0-9_]+__[a-z0-9_]+)\s*$/gim)) {
    items.add(m[1]);
  }
  return items;
}

const PERFMKT = readFileSync(join(AGENTS_DIR, "performance-marketer", "agent.md"), "utf-8");
const META_ADS = readFileSync(join(AGENTS_DIR, "meta_ads", "agent.md"), "utf-8");

describe("meta_ads facade ↔ performance-marketer frontmatter parity", () => {
  it("declares EVERY tool the facade advertises", () => {
    const advertised = listMetaAdsTools().map((t) => `meta_ads__${t.tool_name}`);
    const declared = new Set([...declaredToolItems(PERFMKT), ...declaredToolItems(META_ADS)]);
    const undeclared = advertised.filter((n) => !declared.has(n));
    expect(
      undeclared,
      `These meta_ads tools are registered in the facade but declared by no agent, so ` +
        `discovery filters them out whenever ALL_AGENTS_ALL_TOOLS="0". Add them to ` +
        `performance-marketer/agent.md or meta_ads/agent.md frontmatter tools:. Undeclared: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("declares no meta_ads tool the facade does not provide", () => {
    const advertised = new Set(listMetaAdsTools().map((t) => `meta_ads__${t.tool_name}`));
    const declaredMeta = [...declaredToolItems(PERFMKT)].filter((n) => n.startsWith("meta_ads__"));
    const phantom = declaredMeta.filter((n) => !advertised.has(n));
    expect(phantom, `Declared but not registered: ${phantom.join(", ")}`).toEqual([]);
  });

  it("only the expected agents declare meta_ads tools", () => {
    const declaring = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => {
        try {
          const md = readFileSync(join(AGENTS_DIR, d.name, "agent.md"), "utf-8");
          return [...declaredToolItems(md)].some((n) => n.startsWith("meta_ads__"));
        } catch {
          return false;
        }
      })
      .map((d) => d.name);
    const ALLOWED = ["cgo", "meta_ads", "operator", "performance-marketer"];
    expect([...declaring].sort()).toEqual(ALLOWED);
  });

  it("keeps the SPEND tools to the two ad agents — a read grant never widens the money path", () => {
    const SPEND_AGENTS = ["cgo", "meta_ads", "performance-marketer"];
    const declaringSpend = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => {
        try {
          const md = readFileSync(join(AGENTS_DIR, d.name, "agent.md"), "utf-8");
          return [...declaredToolItems(md)].some((n) => n.startsWith("meta_ads__propose_"));
        } catch {
          return false;
        }
      })
      .map((d) => d.name);
    expect(
      declaringSpend.sort(),
      `An agent outside ${SPEND_AGENTS.join(" / ")} declares a meta_ads__propose_* tool. ` +
        `Those move real ad spend; holding them is an E3 decision, not a grant to add in passing.`,
    ).toEqual(SPEND_AGENTS);
  });
});

describe("search_interests reachability (the specific 2026-08-26 regression)", () => {
  it("is declared, because the create path's error message tells the agent to call it", () => {
    expect(declaredToolItems(PERFMKT).has("meta_ads__search_interests")).toBe(true);
  });

  it("the prompt tells the agent interest ids must be real, never invented", () => {
    expect(PERFMKT).toMatch(/never invent an id/i);
    expect(PERFMKT).toMatch(/meta_ads__search_interests/);
  });
});
