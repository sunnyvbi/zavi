import { describe, it, expect } from "vitest";
import { dryRunBench } from "../dry-run";
import { assertNoFixturePayload } from "../scorecard";

describe("model-bench --dry-run", () => {
  it("builds versioned fixtures with no answer key and renders an aggregates-only scorecard", async () => {
    const { fixtures, report } = await dryRunBench("qwen", 3);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.fixture_version).toBe(1);
      expect(f.expected).toBeUndefined();
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.filled_by).toEqual(["qwen", "claude-shared", "claude-sdk"]);
      if (f.agent_slug === "engineer") expect(f.pinned_sha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(report.partial).toBe(false);
    expect(report.markdown).toMatch(/DRY RUN/);
    expect(report.markdown).toMatch(/qwen vs Claude \(prod loop\)/);
    expect(report.markdown).toMatch(/Harness effect/);
    expect(report.markdown).toMatch(/Judges: gpt-5\.5 \+ gemini-pro/);
    expect(report.markdown).toMatch(/not measurable yet/);
    expect(report.markdown).toMatch(/couple-app \(consumer app\): 3 task\(s\); not covered: no usable run: advisor/);
    expect(report.markdown).toMatch(/\| youtube_organic \| - \| - \| - \| not covered: no usable run \|/);
    expect(() => assertNoFixturePayload(report.markdown, fixtures)).not.toThrow();
    expect(report.candidate).toHaveLength(fixtures.length * 3);
    expect(report.reference_sdk).toHaveLength(fixtures.length * 3);
    expect(report.candidate.some((s) => s.verdict === "worse" && s.pass === false)).toBe(true);
    expect(report.harness_shared.every((s) => s.verdict === "same" && s.pass === true)).toBe(true);
  });
});
