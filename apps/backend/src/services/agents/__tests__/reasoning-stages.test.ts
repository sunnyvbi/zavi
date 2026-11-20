import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  REASONING_STAGES,
  stagesFor,
  stagesAtSeam,
  describeReasoningStages,
} from "@/services/agents/reasoning-stages";

const SRC_ROOT = resolve(process.cwd(), "src");

describe("REASONING_STAGES registry", () => {
  it("drift guard — every referenced module actually exists on disk", () => {
    const missing = REASONING_STAGES.filter(
      (s) => !existsSync(resolve(SRC_ROOT, s.module)),
    ).map((s) => s.module);
    expect(missing).toEqual([]);
  });

  it("covers every stage", () => {
    expect(stagesFor("triangulate").length).toBeGreaterThan(0);
    expect(stagesFor("ground").length).toBeGreaterThan(0);
    expect(stagesFor("critic").length).toBeGreaterThan(0);
  });

  it("best-of-n is the triangulate stage AT THE GENERATION SEAM (not pre-emit)", () => {
    const tri = stagesFor("triangulate");
    expect(tri.some((s) => s.mechanism === "best-of-n" && s.seam === "generation")).toBe(true);
    expect(tri.every((s) => s.seam !== "pre-emit-decision")).toBe(true);
  });

  it("the 6 deterministic ground verifiers + prose shadow all run at post-text", () => {
    const ground = stagesAtSeam("post-text");
    expect(ground.length).toBeGreaterThanOrEqual(7);
    expect(ground.every((s) => s.stage === "ground")).toBe(true);
  });

  it("per-agent critics are registered at per-agent-emit, not moved to pre-emit", () => {
    const perAgent = stagesAtSeam("per-agent-emit").map((s) => s.mechanism);
    expect(perAgent).toContain("advisor critic");
    expect(perAgent).toContain("pm critic");
    expect(perAgent).toContain("research claim-grounding");
  });

  it("describeReasoningStages renders one line per stage", () => {
    const out = describeReasoningStages();
    expect(out).toMatch(/^triangulate:/m);
    expect(out).toMatch(/^ground:/m);
    expect(out).toMatch(/^critic:/m);
  });
});
