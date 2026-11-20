import { describe, it, expect } from "vitest";
import { toolSourceLabel, GENERIC_SOURCE_LABEL } from "@/services/agents/tool-source-label";

describe("toolSourceLabel", () => {
  it("maps a known tool to server + plain tool label", () => {
    expect(toolSourceLabel("github__list_open_prs")).toBe("GitHub: open pull requests");
    expect(toolSourceLabel("operator_db__query")).toBe("your database: a query");
  });

  it("tolerates the SDK's MCP wrappers", () => {
    expect(toolSourceLabel("mcp__server__github__list_open_prs")).toBe("GitHub: open pull requests");
    expect(toolSourceLabel("mcp__github__list_open_prs")).toBe("GitHub: open pull requests");
  });

  it("falls back to the server label for an unmapped tool on a known server", () => {
    expect(toolSourceLabel("stripe__balance_history")).toBe("Stripe");
  });

  it("names Zavi's own growth reads plainly", () => {
    expect(toolSourceLabel("mcp__server__growth__read_business_controls")).toBe("your goals and limits");
    expect(toolSourceLabel("growth__compute")).toBe("a calculation");
    expect(toolSourceLabel("growth__seo_audit")).toBe("your growth data");
  });

  it("never returns the raw name for unknown input", () => {
    for (const raw of ["acme__thing", "list_open_prs", "", null, undefined, "__x"]) {
      expect(toolSourceLabel(raw)).toBe(GENERIC_SOURCE_LABEL);
    }
  });
});
