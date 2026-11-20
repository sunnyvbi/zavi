
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "run-agent.ts"),
  "utf-8",
);

describe("run-agent builds the agent context exactly once per run", () => {
  it("has exactly two buildContext call sites: dispatch + the lazy rebuild thunk", () => {
    const sites = SRC.match(/buildContext\(claim, run_id\)/g) ?? [];
    expect(sites).toHaveLength(2);
  });

  it("takes the run's model from the definition already loaded, with no load-context step", () => {
    expect(SRC).not.toContain('step.run("load-context"');
    const line = "const ctx = { model: modelUsedFor(claim.payload, agentDef.metadata_praxis.model) };";
    expect(SRC).toContain(line);
    const at = SRC.indexOf(line);
    expect(SRC.slice(at - 250, at)).toContain("if (!agentDef) throw new AgentNotFoundError(claim.agent_slug);");
  });
});
