import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refineCommitServedVerdict } from "@/services/agents/conductor-driver";
import { stampRefineEngineerRun } from "@/services/agents/conductor";
import type { ConductorNode } from "@/services/agents/conductor";

describe("a refine is only 'live' once Render serves its commit", () => {
  it("commit landed but Render still deploying it → keep waiting, not live", () => {
    expect(refineCommitServedVerdict("pending", false)).toBe("provisioning");
  });

  it("Render serves the refine commit → live", () => {
    expect(refineCommitServedVerdict("live", false)).toBe("ready");
  });

  it("Render failed to build the refine commit → failed, never 'Live on your app'", () => {
    expect(refineCommitServedVerdict("failed", false)).toBe("failed");
    expect(refineCommitServedVerdict("failed", true)).toBe("failed");
  });

  it("a landed commit still deploying at the bound is never false-failed", () => {
    expect(refineCommitServedVerdict("pending", true)).toBe("ready");
  });

  it("when Render cannot be read it keeps the landed-commit verdict", () => {
    expect(refineCommitServedVerdict("unknown", false)).toBe("ready");
  });

  it("the gate asks Render about this refine's own commit, falling back to HEAD", () => {
    const src = readFileSync(join(__dirname, "../conductor-driver.ts"), "utf-8");
    expect(src).toMatch(/const own = refine\.engineer_run_id \? await readRunLandedCommit\(refine\.engineer_run_id\) : null;\s*return refineCommitServedVerdict\(await renderServesCommit\(tenant_id, own \?\? head\), overBound\);/);
    expect(src).not.toMatch(/if \(head && head !== refine\.pre_refine_sha\) return "ready";/);
  });
});

describe("the deploy gate is tied to this refine's own engineer run", () => {
  const engineer = { id: "refine-1", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, child_run_id: "run-eng-1", estimate_usd: 3 } as unknown as ConductorNode;
  const deploy = () => ({ id: "refine-deploy-1", status: "pending", target_agent_slug: "", payload: { stage: "deploy", pre_refine_sha: "a".repeat(40) }, child_run_id: null, estimate_usd: 0 }) as unknown as ConductorNode;

  it("stamps the engineer run id on the refine deploy node once", () => {
    const d = deploy();
    expect(stampRefineEngineerRun([engineer, d], d)).toBe(true);
    expect((d.payload as Record<string, unknown>).refine_engineer_run_id).toBe("run-eng-1");
    expect(stampRefineEngineerRun([engineer, d], d)).toBe(false);
  });

  it("never stamps a normal build deploy node or a graph without a dispatched engineer", () => {
    const build = { ...deploy(), payload: { stage: "deploy" } } as unknown as ConductorNode;
    expect(stampRefineEngineerRun([engineer, build], build)).toBe(false);
    const d = deploy();
    expect(stampRefineEngineerRun([{ ...engineer, child_run_id: null } as unknown as ConductorNode, d], d)).toBe(false);
  });

  it("the conductor saves the stamp", () => {
    const src = readFileSync(join(__dirname, "../conductor.ts"), "utf-8");
    expect(src).toMatch(/if \(stampRefineEngineerRun\(graph, firstPending\)\) dirty = true;\s*hs = await deps\.hostingStatus\(row\.tenant_id, firstPending\);/);
  });
});
