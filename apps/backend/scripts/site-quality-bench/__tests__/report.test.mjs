import { describe, expect, it } from "vitest";
import { buildReport, systemMetrics } from "../lib/report.mjs";
import { loadRecordEntries, MOCK_DIR, loadBriefs } from "../lib/io.mjs";
import { SCORE_AXES } from "../lib/schema.mjs";
import { baseRecord } from "./helpers.mjs";

const briefIds = loadBriefs().map((b) => b.id);
const mocks = () => loadRecordEntries([MOCK_DIR], { briefIds }).entries.map((e) => e.record);

function zavi(i, over = {}) {
  return baseRecord({ run_id: `z${i}`, brief_id: briefIds[i % 6], ...over });
}

function lovable(i, over = {}) {
  return baseRecord({ run_id: `l${i}`, brief_id: briefIds[i % 6], system: "lovable", provenance: "manual_import", repairs: null, cost: { usd: null, source: "manual: not recorded" }, ...over });
}

function sectionBetween(text, start, end) {
  const s = text.indexOf(start);
  const e = end ? text.indexOf(end, s) : text.length;
  return text.slice(s, e);
}

describe("report refusal and labelling", () => {
  it("mocked fixtures alone: no headline, every mocked row listed in its own table", () => {
    const { text, data } = buildReport({ records: mocks() });
    expect(data.headline).toBe(false);
    expect(text).toMatch(/NO COMPARISON HEADLINE: zavi has 0 actual_ai_build\/manual_import records; lovable has 0/);
    expect(text).not.toMatch(/COMPARISON HEADLINE: zavi vs/);
    const mockedSection = sectionBetween(text, "MOCKED (not evidence)");
    for (const r of mocks()) expect(mockedSection).toContain(r.run_id);
    const perSystem = sectionBetween(text, "PER SYSTEM", "MOCKED (not evidence)");
    expect(perSystem).not.toMatch(/mock-/);
    expect(perSystem).toMatch(/records: +0 \(n=0\)/);
    expect(data.per_system.zavi.to_first_preview_s.median).toBeNull();
  });

  it("refuses when only one side has evidence, naming the empty side", () => {
    const { text, data } = buildReport({ records: [zavi(0), zavi(1), ...mocks()] });
    expect(data.headline).toBe(false);
    expect(data.missing_systems).toEqual(["lovable"]);
    expect(text).toMatch(/NO COMPARISON HEADLINE: lovable has 0 actual_ai_build\/manual_import records\./);
  });

  it("a hand-written demo never counts as evidence", () => {
    const demo = lovable(0, { provenance: "hand_written_demo" });
    const { data, text } = buildReport({ records: [zavi(0), demo] });
    expect(data.headline).toBe(false);
    expect(sectionBetween(text, "MOCKED (not evidence)")).toContain("hand_written_demo");
  });

  it("prints the headline only with evidence on both sides, labels every number with its provenance count, and keeps mocks out of the math", () => {
    const records = [
      zavi(0, { timings: { to_first_preview_s: 100, to_usable_complete_s: 500 } }),
      zavi(1, { timings: { to_first_preview_s: 300, to_usable_complete_s: null }, repairs: 2 }),
      zavi(2, { timings: { to_first_preview_s: null, to_usable_complete_s: 700 }, repairs: null }),
      lovable(0, { timings: { to_first_preview_s: 10, to_usable_complete_s: 200 } }),
      lovable(1, { timings: { to_first_preview_s: 20, to_usable_complete_s: 100 } }),
      baseRecord({ run_id: "mock-huge", provenance: "mocked", timings: { to_first_preview_s: 99999, to_usable_complete_s: 99999 } }),
    ];
    const { text, data } = buildReport({ records });
    expect(data.headline).toBe(true);
    expect(data.paired_briefs).toEqual([briefIds[0], briefIds[1]]);
    expect(text).toMatch(/COMPARISON HEADLINE: zavi vs lovable on 2 paired briefs \(target 20\)/);
    expect(text).toMatch(/CAUTION: 2 of 20 planned paired builds/);
    expect(text).toMatch(/p90 time to first preview: zavi 300s \(n=3 actual_ai_build\) vs lovable 20s \(n=2 manual_import\)/);
    const z = data.per_system.zavi;
    expect(z.to_first_preview_s).toMatchObject({ n: 2, nulls: 1, median: 200, p90: 300 });
    expect(z.to_usable_complete_s).toMatchObject({ n: 2, nulls: 1, median: 600, p90: 700 });
    expect(z.repair_rate).toEqual({ value: 0.5, n: 2, nulls: 1 });
    expect(text).toMatch(/time to first preview: +median 200s \/ p90 300s \(n=3 actual_ai_build; 2 with value, 1 null excluded\)/);
    expect(text).toMatch(/cost per build: +median n\/a \/ p90 n\/a \(n=2 manual_import; 0 with value, 2 null excluded\)/);
    expect(sectionBetween(text, "MOCKED (not evidence)")).toContain("mock-huge");
    expect(sectionBetween(text, "PER SYSTEM", "MOCKED")).not.toContain("99999");
  });

  it("no caution line once the 20-pair target is met", () => {
    const records = [];
    for (let i = 0; i < 20; i++) {
      records.push(zavi(i, { brief_id: `b${i}` }), lovable(i, { brief_id: `b${i}` }));
    }
    const { text, data } = buildReport({ records });
    expect(data.paired_briefs).toHaveLength(20);
    expect(text).not.toMatch(/CAUTION/);
  });
});

describe("rates and blind ratings", () => {
  it("journey pass rate and requirement coverage count items, not records", () => {
    const m = systemMetrics([
      zavi(0, { journeys: [{ name: "a", passed: true }, { name: "b", passed: false }], requirement_coverage: [{ requirement: "x", met: true, evidence: "" }] }),
      zavi(1, { journeys: [{ name: "a", passed: true }], requirement_coverage: [{ requirement: "x", met: false, evidence: "" }, { requirement: "y", met: false, evidence: "" }, { requirement: "z", met: true, evidence: "" }] }),
    ]);
    expect(m.journey_pass_rate).toEqual({ value: 2 / 3, n: 3 });
    expect(m.requirement_coverage).toEqual({ value: 0.5, n: 4 });
  });

  it("axis means and win rate use only blind judgments where both sides are evidence", () => {
    const sc = (v) => Object.fromEntries(SCORE_AXES.map((a) => [a, v]));
    const row = (run_id, opp, outcome, v) => ({
      rater: "r", item_id: "i", brief_id: "b", viewport: "desktop", side: "A", run_id, system: "zavi", provenance: "actual_ai_build",
      opponent_run_id: "x", opponent_system: "lovable", opponent_provenance: opp, scores: { rater: "r", ...sc(v) }, outcome,
    });
    const joined = [row("z0", "manual_import", "win", 5), row("z0", "manual_import", "tie", 3), row("z0", "manual_import", "loss", 4), row("z0", "mocked", "win", 1)];
    const m = systemMetrics([zavi(0, { scores: { rater: "self", hierarchy: 2 } })], joined);
    expect(m.preference).toEqual({ win_rate: 1 / 3, wins: 1, ties: 1, losses: 1, n: 3 });
    expect(m.axes.hierarchy).toEqual({ mean: (2 + 5 + 3 + 4) / 4, n: 4, nulls: 0 });
    expect(m.axes.typography).toEqual({ mean: 4, n: 3, nulls: 1 });
  });
});
