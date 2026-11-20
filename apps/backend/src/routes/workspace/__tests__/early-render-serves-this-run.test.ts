import { describe, it, expect } from "vitest";
import { earlyRenderServesThisRun } from "../autopilot";

const RUN_AT = "2026-09-28T10:00:00.000Z";
const HOSTING_FRESH = "2026-09-28T10:00:30.000Z";
const HOSTING_REBUILD = "2026-09-25T10:00:00.000Z";

function stages(scaffoldStatus: string) {
  return [
    { stage: "provision", status: "done" },
    { stage: "spec", status: "done" },
    { stage: "scaffold", status: scaffoldStatus },
    { stage: "build", status: "running" },
    { stage: "qa", status: "pending" },
  ];
}

describe("earlyRenderServesThisRun", () => {
  it("fresh workspace: hosting created after run start + scaffold done -> true", () => {
    expect(earlyRenderServesThisRun(HOSTING_FRESH, RUN_AT, stages("done"))).toBe(true);
  });

  it("fresh workspace: hosting created after run start + scaffold skipped -> true", () => {
    expect(earlyRenderServesThisRun(HOSTING_FRESH, RUN_AT, stages("skipped"))).toBe(true);
  });

  it("fresh workspace: hosting created exactly at run start + scaffold skipped -> true", () => {
    expect(earlyRenderServesThisRun(RUN_AT, RUN_AT, stages("skipped"))).toBe(true);
  });

  it("rebuild: hosting predates run + scaffold done -> false (the reused service still serves the previous app until Render redeploys)", () => {
    expect(earlyRenderServesThisRun(HOSTING_REBUILD, RUN_AT, stages("done"))).toBe(false);
  });

  it("rebuild: hosting predates run + scaffold skipped -> false (no new code pushed)", () => {
    expect(earlyRenderServesThisRun(HOSTING_REBUILD, RUN_AT, stages("skipped"))).toBe(false);
  });

  it("rebuild: hosting predates run + scaffold running -> false", () => {
    expect(earlyRenderServesThisRun(HOSTING_REBUILD, RUN_AT, stages("running"))).toBe(false);
  });

  it("fresh workspace: scaffold still running -> false", () => {
    expect(earlyRenderServesThisRun(HOSTING_FRESH, RUN_AT, stages("running"))).toBe(false);
  });

  it("no scaffold stage at all -> false", () => {
    expect(
      earlyRenderServesThisRun(HOSTING_FRESH, RUN_AT, [{ stage: "build", status: "done" }]),
    ).toBe(false);
  });

  it("null or garbage timestamps -> false", () => {
    expect(earlyRenderServesThisRun(null, RUN_AT, stages("done"))).toBe(false);
    expect(earlyRenderServesThisRun(HOSTING_FRESH, null, stages("done"))).toBe(false);
    expect(earlyRenderServesThisRun(null, null, stages("done"))).toBe(false);
    expect(earlyRenderServesThisRun("not-a-date", RUN_AT, stages("done"))).toBe(false);
    expect(earlyRenderServesThisRun(HOSTING_FRESH, "garbage", stages("done"))).toBe(false);
    expect(earlyRenderServesThisRun("", RUN_AT, stages("done"))).toBe(false);
  });
});
