import { describe, it, expect } from "vitest";
import { buildCostReport, percentile, toCostRun, type CostRunInput } from "../build-costs";

const T = "t-1";
let n = 0;
const run = (build_id: string, over: Partial<CostRunInput> = {}): CostRunInput => ({
  id: `r${++n}`,
  build_id,
  agent_slug: "engineer",
  status: "success",
  model: "claude-opus-5-5",
  usd: 1,
  stage: "build",
  fast: false,
  repair: false,
  vision_fix: false,
  finished: true,
  input_tokens: 10,
  output_tokens: 100,
  cache_read_tokens: 900,
  cache_creation_tokens: 90,
  ...over,
});
const b = (id: string, at: string, refine = false, over: Partial<{ status: string; fast: boolean }> = {}) => ({ id, tenant_id: T, status: "done", created_at: at, refine, fast: false, ...over });

describe("buildCostReport", () => {
  it("splits fast builds, staged builds and edits, with stage, model and pass breakdowns", () => {
    const fast1 = run("f1", { fast: true, usd: 1.2 });
    const fast1Repair = run("f1", { fast: true, repair: true, usd: 0.8 });
    const r = buildCostReport({
      days: 14,
      scope: "real",
      builds: [b("f1", "2026-10-05T00:00:00Z"), b("f2", "2026-10-06T00:00:00Z"), b("s1", "2026-09-28T00:00:00Z"), b("e1", "2026-10-06T01:00:00Z", true), b("none", "2026-10-06T02:00:00Z")],
      runs: [
        fast1,
        fast1Repair,
        run("f2", { fast: true, usd: 1 }),
        run("s1", { stage: "spec", agent_slug: "pm", model: "claude-sonnet-5-5", usd: 0.5 }),
        run("s1", { stage: "scaffold", usd: 3 }),
        run("s1", { stage: "build", usd: 1.5 }),
        run("e1", { usd: 0.4, model: null }),
        run("e1", { usd: 0, model: null, vision_fix: true }),
      ],
      images: [{ run_id: fast1.id, usd: 0.08 }],
      slugs: { [T]: "acme" },
    });
    expect(r.totals).toMatchObject({ builds: 4, unfinished: 0, runs: 8, model_usd: 8.4, tool_usd: 0, image_usd: 0.08, usd: 8.48 });
    expect(r.truncated).toEqual({ builds: false, runs: false, images: false, tool_costs: false });
    expect(r.per_build.fast).toMatchObject({ builds: 2, avg: 1.54, p50: 1, p90: 2.08, max: 2.08 });
    expect(r.per_build.staged).toMatchObject({ builds: 1, avg: 5 });
    expect(r.per_build.edit).toMatchObject({ builds: 1, avg: 0.4 });
    const f1 = r.builds.find((x) => x.id === "f1")!;
    expect(f1).toMatchObject({ flow: "fast", usd: 2.08, model_usd: 2, image_usd: 0.08, runs: 2, passes: { first: 1, repair: 1, visual_fix: 0 }, tenant_slug: "acme" });
    expect(f1.by_stage.build).toMatchObject({ runs: 2, usd: 2 });
    const s1 = r.builds.find((x) => x.id === "s1")!;
    expect(Object.keys(s1.by_stage).sort()).toEqual(["build", "scaffold", "spec"]);
    expect(s1.by_model["claude-sonnet-5-5"]).toMatchObject({ runs: 1, usd: 0.5 });
    const e1 = r.builds.find((x) => x.id === "e1")!;
    expect(e1).toMatchObject({ flow: "edit", passes: { first: 1, repair: 0, visual_fix: 1 } });
    expect(Object.keys(e1.by_model).sort()).toEqual(["no model call", "unrecorded"]);
    expect(r.by_stage[0]).toMatchObject({ stage: "scaffold", flow: "staged", pass: "first", usd: 3 });
    expect(r.by_stage.find((x) => x.flow === "fast" && x.pass === "repair")).toMatchObject({ runs: 1, usd: 0.8 });
    expect(r.by_model[0]).toMatchObject({ model: "claude-opus-5-5", runs: 5, usd: 7.5 });
    expect(r.totals.cache_read_share).toBeCloseTo(900 / 1000, 3);
    expect(r.builds.map((x) => x.id)).toEqual(["e1", "f2", "f1", "s1"]);
    expect(r.not_included.length).toBeGreaterThan(0);
  });

  it("unfinished builds count in the totals, never in the averages", () => {
    const r = buildCostReport({
      days: 14,
      scope: "real",
      builds: [b("done", "2026-10-05T00:00:00Z", false, { fast: true }), b("running", "2026-10-06T00:00:00Z", false, { status: "active", fast: true })],
      runs: [run("done", { usd: 2 }), run("running", { usd: 0 })],
      images: [],
      slugs: {},
    });
    expect(r.totals).toMatchObject({ builds: 2, unfinished: 1, usd: 2 });
    expect(r.per_build.fast).toMatchObject({ builds: 1, avg: 2 });
  });

  it("the build graph decides fast vs staged, even when a run lacks the marker", () => {
    const r = buildCostReport({ days: 14, scope: "real", builds: [b("g", "2026-10-05T00:00:00Z", false, { fast: true })], runs: [run("g", { fast: false })], images: [], slugs: {} });
    expect(r.builds[0]!.flow).toBe("fast");
  });

  it("tool spend folded into a run is split out of model cost, never added twice", () => {
    const x = run("t", { usd: 1.5 });
    const r = buildCostReport({ days: 14, scope: "real", builds: [b("t", "2026-10-05T00:00:00Z")], runs: [x], images: [], side: [{ run_id: x.id, usd: 0.25 }], slugs: {} });
    expect(r.builds[0]).toMatchObject({ usd: 1.5, model_usd: 1.25, tool_usd: 0.25 });
    expect(r.totals).toMatchObject({ usd: 1.5, model_usd: 1.25, tool_usd: 0.25 });
  });

  it("a running run's tool spend is not folded yet: it is added, not split out", () => {
    const x = run("t", { usd: 0, finished: false });
    const r = buildCostReport({ days: 14, scope: "real", builds: [b("t", "2026-10-05T00:00:00Z", false, { status: "active" })], runs: [x], images: [], side: [{ run_id: x.id, usd: 0.25 }], slugs: {} });
    expect(r.builds[0]).toMatchObject({ usd: 0.25, model_usd: 0, tool_usd: 0.25 });
  });

  it("passes truncation through so a capped query is never read as the whole window", () => {
    const r = buildCostReport({ days: 14, scope: "real", builds: [], runs: [], images: [], slugs: {}, truncated: { builds: false, runs: true, images: false, tool_costs: false } });
    expect(r.truncated.runs).toBe(true);
  });

  it("an empty window is an empty report", () => {
    const r = buildCostReport({ days: 7, scope: "all", builds: [], runs: [], images: [], slugs: {} });
    expect(r.totals).toEqual({ builds: 0, unfinished: 0, usd: 0, model_usd: 0, tool_usd: 0, image_usd: 0, runs: 0, cache_read_share: null });
    expect(r.per_build).toEqual({ fast: null, staged: null, edit: null });
  });
});

describe("percentile", () => {
  it("is nearest-rank", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("toCostRun", () => {
  it("reads the payload columns, and drops a run with no build", () => {
    expect(
      toCostRun({ id: "x", agent_slug: "engineer", status: "success", finished_at: "2026-10-05T00:00:00Z", model_used: "m", cost_usd: "1.25", input_tokens: 3, output_tokens: null, cache_read_tokens: 7, cache_creation_tokens: 1, build: "b", stage: "build", fast: "true", repair: null, vision_fix: "true" }),
    ).toEqual({ id: "x", build_id: "b", agent_slug: "engineer", status: "success", model: "m", usd: 1.25, stage: "build", fast: true, repair: false, vision_fix: true, finished: true, input_tokens: 3, output_tokens: 0, cache_read_tokens: 7, cache_creation_tokens: 1 });
    expect(toCostRun({ id: "x", build: null })).toBeNull();
  });
});
