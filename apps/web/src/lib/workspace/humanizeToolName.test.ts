import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  humanizeToolName,
  isInternalToolName,
  shortToolName,
} from "./humanizeToolName";

const LEAKY = "mcp__server__meta_ads__list_campaigns";

describe("humanizeToolName", () => {
  it("strips a full mcp__ chain — no mcp__, no __, no 'server' leak", () => {
    const out = humanizeToolName(LEAKY);
    expect(out).not.toContain("mcp__");
    expect(out).not.toContain("__");
    expect(out.toLowerCase()).not.toContain("mcp");
    expect(out.toLowerCase()).not.toContain("server");
    expect(out).toBe("List");
  });

  it("maps a known verb", () => {
    expect(humanizeToolName("mcp__sandbox__run_bash")).toBe("Run");
    expect(humanizeToolName("meta_ads__list_ad_sets")).toBe("List");
    expect(humanizeToolName("ToolSearch")).toBe("Search");
  });

  it("titleCases an unknown tool, still no separators", () => {
    const out = humanizeToolName("mcp__crm__update_contact_owner");
    expect(out).toBe("Update Contact Owner");
    expect(out).not.toContain("__");
  });

  it("empty / null / undefined -> 'tool' (safe fallback, no throw)", () => {
    expect(humanizeToolName(undefined)).toBe("tool");
    expect(humanizeToolName(null)).toBe("tool");
    expect(humanizeToolName("")).toBe("tool");
    expect(humanizeToolName("   ")).toBe("tool");
  });

  it("shortToolName keeps only the final bare segment", () => {
    expect(shortToolName(LEAKY)).toBe("list_campaigns");
    expect(shortToolName("ToolSearch")).toBe("ToolSearch");
  });
});

describe("isInternalToolName", () => {
  it("flags the handoff family, prefixed or bare", () => {
    expect(isInternalToolName("praxis__handoff")).toBe(true);
    expect(isInternalToolName("praxis__handoff_parallel")).toBe(true);
    expect(isInternalToolName("handoff")).toBe(true);
    expect(isInternalToolName("HANDOFF")).toBe(true);
  });

  it("does NOT flag work the customer asked for", () => {
    expect(isInternalToolName("praxis__slack__post_message")).toBe(false);
    expect(isInternalToolName("praxis__remind")).toBe(false);
    expect(isInternalToolName("web_search__search")).toBe(false);
    expect(isInternalToolName("meta_ads__list_campaigns")).toBe(false);
  });

  it("flags OUR handoff through the SDK trace wrapper", () => {
    expect(isInternalToolName("mcp__server__praxis__handoff")).toBe(true);
    expect(isInternalToolName("mcp__praxis__handoff_parallel")).toBe(true);
  });

  it("does NOT flag a customer MCP tool whose last segment is 'handoff'", () => {
    expect(isInternalToolName("mcp__server__acme_crm__handoff")).toBe(false);
    expect(isInternalToolName("zendesk__handoff")).toBe(false);
    expect(isInternalToolName("mcp__server__support_desk__handoff_parallel")).toBe(false);
  });

  it("still does not flag a name that merely contains handoff", () => {
    expect(isInternalToolName("praxis__handoff_report")).toBe(false);
    expect(isInternalToolName("mcp__server__praxis__handoff_report")).toBe(false);
  });

  it("is safe on empty/garbage input", () => {
    expect(isInternalToolName("")).toBe(false);
    expect(isInternalToolName("   ")).toBe(false);
    expect(isInternalToolName(null)).toBe(false);
    expect(isInternalToolName(undefined)).toBe(false);
  });
});

describe("no raw tool_name leak in chat surfaces", () => {
  const SURFACES = [
    "lib/workspace/useInlineStatus.ts",
    "components/workspace/RunActivityFeed.tsx",
    "components/AgentRunProgress.tsx",
  ];
  const root = fileURLToPath(new URL("../../", import.meta.url));

  for (const rel of SURFACES) {
    it(`${rel} never renders a raw tool_name`, () => {
      const src = readFileSync(root + rel, "utf8");
      const lines = src.split("\n");
      const offenders: string[] = [];
      for (const line of lines) {
        const inTemplate = /\$\{[^}]*tool_name[^}]*\}/.test(line);
        const inJsx = /\{[^}]*\btool_name\b[^}]*\}/.test(line) && line.includes("<");
        const hasRender = inTemplate || /title=\{[^}]*tool_name/.test(line);
        if ((inTemplate || hasRender || inJsx) && !line.includes("humanizeToolName")) {
          offenders.push(line.trim());
        }
      }
      expect(offenders, `raw tool_name render in ${rel}:\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
