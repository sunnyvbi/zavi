import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listAgents } from "@/services/agents/registry";
import { ALL_BROWSER_TOOL_NAMES } from "../types";
import { AUTO_EXECUTE_BROWSER_AGENTS } from "../browser-auto-execute-policy";

const BROWSER_TOOLS = new Set<string>(ALL_BROWSER_TOOL_NAMES as readonly string[]);

describe("fleet browser-tool isolation (browser__task era)", () => {
  it("ZERO agents declare browser_* tools", () => {
    const withBrowserTools = listAgents()
      .filter((a) => (a.metadata_praxis.tools ?? []).some((t) => BROWSER_TOOLS.has(t)))
      .map((a) => a.slug);
    expect(withBrowserTools).toEqual([]);
  });

  it("no slug may auto-execute a browser write", () => {
    expect([...AUTO_EXECUTE_BROWSER_AGENTS]).toEqual([]);
  });

  it("browser-operator is hidden fleet-wide (default_state disabled)", () => {
    const bo = listAgents().find((a) => a.slug === "browser-operator");
    expect(bo, "browser-operator not found in registry").toBeDefined();
    const vis = (bo!.metadata_praxis as { visibility?: { default_state?: string } }).visibility;
    expect(vis?.default_state).toBe("disabled");
  });
});

describe("operator routes browser-shaped work to browser__task", () => {
  const operatorMd = readFileSync(
    join(__dirname, "..", "..", "..", "..", "agents", "operator", "agent.md"),
    "utf8",
  );

  it("operator prompt no longer hands browsing to browser-operator", () => {
    expect(operatorMd).not.toContain('praxis__handoff(target_agent_slug: "browser-operator"');
    expect(operatorMd).not.toContain("`browser-operator`");
  });
});
