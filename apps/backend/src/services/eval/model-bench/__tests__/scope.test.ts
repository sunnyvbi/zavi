import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtures, replaceTenantFixtures, type TaskFixture } from "../fixtures";
import { renderScorecard } from "../scorecard";
import { parseArgs, resolveScope } from "../../../../../scripts/model-bench";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
function fx(unit: string, cohort: "role" | "channel" = "role", filled = ["gpt-5.5", "claude-shared", "claude-sdk"]): TaskFixture {
  return {
    fixture_version: 1,
    task_id: `upcar-ai.${unit}.t`,
    tenant_id: T,
    company: "upcar-ai",
    agent_slug: unit,
    unit,
    cohort,
    source_run_id: `s-${unit}`,
    input: { trigger: "cron", payload: null, prompt: { system: "s", initial_user: "u" } },
    evidence: [],
    filled_by: filled,
    expected: { drafted_by: "gemini-pro", drafter_family: "google", assertions: [], uncited_ids: [] },
  } as TaskFixture;
}

describe("--companies / --units scope", () => {
  it("parses and validates scope; unknown names are refused", () => {
    const a = parseArgs(["run", "--model", "gpt-5.5", "--companies", "upcar-ai", "--units", "pm", "--trials", "1"]);
    expect(a.companies).toEqual(["upcar-ai"]);
    expect(a.units).toEqual(["pm"]);
    const sc = resolveScope(a);
    expect(sc.tenants.map((t) => t.company)).toEqual(["upcar-ai"]);
    expect([...sc.units!]).toEqual(["pm"]);
    expect(() => resolveScope({ companies: ["acme"], units: [] })).toThrow(/unknown --companies/);
    expect(() => resolveScope({ companies: [], units: ["nope"] })).toThrow(/--units/);
    expect(resolveScope({ companies: [], units: [] }).scope).toBeNull();
  });

  it("a scoped build never touches fixtures of units outside the scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-scope-"));
    replaceTenantFixtures(T, [fx("pm", "role", ["qwen", "claude-shared", "claude-sdk"]), fx("seo", "channel", ["qwen", "claude-shared", "claude-sdk"])], dir, ["qwen", "claude-shared", "claude-sdk"]);
    replaceTenantFixtures(T, [fx("pm")], dir, ["gpt-5.5", "claude-shared", "claude-sdk"], new Set(["pm"]));
    const units = loadFixtures(dir).map((f) => f.unit).sort();
    expect(units).toEqual(["pm", "seo"]);
  });

  it("a unit whose runs were all trivial this build loses its old fixture instead of keeping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-trivial-"));
    const all = ["gpt-5.5", "claude-shared", "claude-sdk"];
    replaceTenantFixtures(T, [fx("pm"), fx("seo", "channel")], dir, all);
    const out = replaceTenantFixtures(T, [fx("seo", "channel")], dir, all, null, new Set(["pm"]));
    expect(loadFixtures(dir).map((f) => f.unit)).toEqual(["seo"]);
    expect(out.keptStale).toEqual([]);
  });

  it("a scoped scorecard says so and lists only the scoped units", () => {
    const md = renderScorecard({
      date: "2026-09-25", model_key: "gpt-5.5", model_lineage: "x", harness_sha: "h", trials: 1,
      fixtures: [fx("pm")], candidate: [], reference_sdk: [], harness_shared: [],
      judges: "judge_unavailable", harness_judges: "judge_unavailable", harness_partial: false,
      spent_usd: 0, max_usd: 5, partial: false,
      scope: { companies: ["upcar-ai"], units: ["pm"] },
    } as never);
    expect(md).toMatch(/SCOPED RUN/);
    expect(md).not.toMatch(/\| operator \|/);
    expect(md).not.toMatch(/apna-tutor/);
  });
});

import { scopeSuffix } from "../../../../../scripts/model-bench";

describe("scope review fixes", () => {
  it("an empty --units / --companies value is refused, never widened to the fleet", () => {
    expect(() => parseArgs(["build", "--models", "gpt-5.5", "--units"])).toThrow(/non-empty/);
    expect(() => parseArgs(["build", "--models", "gpt-5.5", "--companies", ""])).toThrow(/non-empty/);
  });

  it("scoped runs get their own scorecard filename", () => {
    expect(scopeSuffix(null)).toBe("");
    expect(scopeSuffix({ companies: ["upcar-ai"], units: ["pm"] })).toBe(".scoped-upcar-ai-pm");
    expect(scopeSuffix({ companies: [], units: ["seo", "pm"] })).toBe(".scoped-all-pm+seo");
  });
});

import { measurableUnits } from "../miner";

describe("scoped filename is bounded", () => {
  it("a scope of every unit stays short and stable", () => {
    const units = measurableUnits().map((u) => u.unit);
    const a = scopeSuffix({ companies: [], units });
    expect(a.length).toBeLessThanOrEqual(60);
    expect(scopeSuffix({ companies: [], units: [...units].reverse() })).toBe(a);
    expect(scopeSuffix({ companies: [], units: units.slice(1) })).not.toBe(a);
  });
});
