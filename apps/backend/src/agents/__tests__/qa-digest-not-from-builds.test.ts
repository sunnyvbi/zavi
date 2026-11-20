import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBuildStepRun } from "../lib/build-step-run";

const CONDUCTOR = "5b1a2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("isBuildStepRun", () => {
  it("is true for an a2a run the Build conductor dispatched", () => {
    expect(isBuildStepRun("a2a", { stage: "qa", build_conductor_run_id: CONDUCTOR })).toBe(true);
    expect(isBuildStepRun("a2a", { build_conductor_run_id: CONDUCTOR })).toBe(true);
    expect(isBuildStepRun("a2a", { stage: "qa" })).toBe(true);
  });

  it("is false for qa runs a person starts, whatever the payload says", () => {
    for (const trigger of ["chat", "slack", "manual", "mcp", "cron", undefined, null]) {
      expect(isBuildStepRun(trigger, { stage: "qa" }), String(trigger)).toBe(false);
      expect(isBuildStepRun(trigger, { stage: "qa", build_conductor_run_id: CONDUCTOR }), String(trigger)).toBe(false);
    }
  });

  it("is false for an a2a run with no Build provenance in its payload", () => {
    expect(isBuildStepRun("a2a", undefined)).toBe(false);
    expect(isBuildStepRun("a2a", null)).toBe(false);
    expect(isBuildStepRun("a2a", { message: "add a test for checkout", mode: "chat-add" })).toBe(false);
    expect(isBuildStepRun("a2a", { mode: "weekly-execute" })).toBe(false);
    expect(isBuildStepRun("a2a", { build_conductor_run_id: "not-a-uuid" })).toBe(false);
  });
});

describe("the qa dispatcher", () => {
  const src = readFileSync(join(__dirname, "../index.ts"), "utf8");
  const qaEntry = src.slice(src.indexOf('"qa": withQaWeeklyCase(createSideEffectDispatcher('));

  it("still emits qa.weekly-digest, gated on the run not being a Build step", () => {
    expect(qaEntry).toMatch(/decisionClass: "qa\.weekly-digest"/);
    expect(qaEntry.slice(0, qaEntry.indexOf("}),"))).toMatch(
      /shouldEmit: \(_parsed, ctx, payload\) => !isBuildStepRun\(ctx\.trigger, payload\)/,
    );
  });
});
