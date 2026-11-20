import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isCronStopped, isWorkerCronStopped } from "@/services/agents/cron-stopped";

const src = readFileSync(join(__dirname, "../goal-reconcile.ts"), "utf8");

describe("goal-reconcile and the cron stop", () => {
  it("the clock asks the worker allowlist before any tenant work", () => {
    expect(src).toMatch(/isWorkerCronStopped\("goal-reconcile"\)/);
  });

  it("is on the allowlist, once a day at 13:30 UTC (before cgo's 14:00 check)", () => {
    expect(isWorkerCronStopped("goal-reconcile")).toBe(false);
    expect(src).toMatch(/\{ cron: "30 13 \* \* \*" \}/);
  });

  it("wakes no agent: it cannot enqueue a run, so no stop can be bypassed", () => {
    expect(src).not.toMatch(/enqueueAgentRun/);
    expect(src).not.toMatch(/agent_slug:/);
    expect(isCronStopped("chief-of-staff")).toBe(true);
  });
});
