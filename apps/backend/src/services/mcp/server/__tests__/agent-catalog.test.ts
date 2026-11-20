
import { describe, it, expect } from "vitest";
import { listAgents, isChannelOnlyAgent } from "@/services/agents/registry";
import { MCP_AGENT_CATALOG } from "@/services/mcp/server/agent-catalog";

const NOT_OFFERED = new Set(["browser-operator"]);

const globalSlugs = listAgents().map((a) => a.slug);

describe("MCP_AGENT_CATALOG", () => {
  it("has an entry for every agent zavi_list_agents can show", () => {
    const listable = globalSlugs.filter((s) => !isChannelOnlyAgent(s) && !NOT_OFFERED.has(s));
    expect(listable.length).toBeGreaterThan(0);
    expect(listable.filter((s) => !MCP_AGENT_CATALOG[s])).toEqual([]);
  });

  it("has no entry for a missing, channel-only or retired agent", () => {
    const known = new Set(globalSlugs);
    const stale = Object.keys(MCP_AGENT_CATALOG).filter(
      (s) => !known.has(s) || isChannelOnlyAgent(s) || NOT_OFFERED.has(s),
    );
    expect(stale).toEqual([]);
  });

  it("gives each agent a name and a one-line description with no internal references", () => {
    for (const [slug, { name, description }] of Object.entries(MCP_AGENT_CATALOG)) {
      expect(name.trim(), slug).not.toBe("");
      expect(description.length, slug).toBeGreaterThan(20);
      expect(description.length, slug).toBeLessThanOrEqual(160);
      expect(description, slug).not.toMatch(/\d{4}-\d{2}-\d{2}|PLAN-|praxis|retired|__|src\//i);
    }
  });
});
