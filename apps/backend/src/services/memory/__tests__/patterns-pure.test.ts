import { describe, it, expect } from "vitest";
import {
  hashPatternTitle,
  validatePatternArtifact,
  parsePatternArtifacts,
  buildPatternsPrompt,
  estimatePatternCostUsd,
  maxRunsUnderCostCap,
  PATTERNS_MAX_PER_CALL,
  PATTERNS_TITLE_MAX,
  PATTERNS_BODY_MAX,
  PATTERNS_COST_CAP_USD,
  type AgentRunSnippet,
} from "../patterns";

describe("hashPatternTitle", () => {
  it("deterministic", () => {
    expect(hashPatternTitle("Hello")).toBe(hashPatternTitle("Hello"));
  });
  it("collapses case + whitespace", () => {
    expect(hashPatternTitle("Hello World")).toBe(hashPatternTitle("  hello   world  "));
  });
  it("different titles → different hashes", () => {
    expect(hashPatternTitle("disputes about late returns")).not.toBe(
      hashPatternTitle("disputes about damage claims"),
    );
  });
  it("returns 16 hex chars", () => {
    const h = hashPatternTitle("x");
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("validatePatternArtifact", () => {
  const valid = {
    title: "late-return disputes",
    body_markdown: "body",
    evidence_run_ids: ["r1", "r2", "r3"],
    theme_recurrence: 3,
  };

  it("accepts valid shape", () => {
    expect(validatePatternArtifact(valid)).toBe(true);
  });
  it("rejects null/non-object", () => {
    expect(validatePatternArtifact(null)).toBe(false);
    expect(validatePatternArtifact("x")).toBe(false);
  });
  it("rejects missing title", () => {
    expect(validatePatternArtifact({ ...valid, title: "" })).toBe(false);
  });
  it("rejects oversized title", () => {
    expect(validatePatternArtifact({ ...valid, title: "x".repeat(PATTERNS_TITLE_MAX + 1) })).toBe(
      false,
    );
  });
  it("rejects oversized body", () => {
    expect(
      validatePatternArtifact({ ...valid, body_markdown: "x".repeat(PATTERNS_BODY_MAX + 1) }),
    ).toBe(false);
  });
  it("rejects empty evidence array", () => {
    expect(validatePatternArtifact({ ...valid, evidence_run_ids: [] })).toBe(false);
  });
  it("rejects non-string evidence id", () => {
    expect(validatePatternArtifact({ ...valid, evidence_run_ids: [1, 2, 3] })).toBe(false);
  });
  it("rejects recurrence < 1", () => {
    expect(validatePatternArtifact({ ...valid, theme_recurrence: 0 })).toBe(false);
  });
  it("rejects non-number recurrence", () => {
    expect(validatePatternArtifact({ ...valid, theme_recurrence: "3" })).toBe(false);
  });
});

describe("parsePatternArtifacts", () => {
  it("empty string → empty", () => {
    expect(parsePatternArtifacts("")).toEqual({ artifacts: [], invalid: 0 });
  });
  it("malformed JSON → empty + 0 invalid", () => {
    expect(parsePatternArtifacts("not-json")).toEqual({ artifacts: [], invalid: 0 });
  });
  it("top-level array works", () => {
    const json = JSON.stringify([
      { title: "t", body_markdown: "b", evidence_run_ids: ["r1"], theme_recurrence: 3 },
    ]);
    expect(parsePatternArtifacts(json).artifacts.length).toBe(1);
  });
  it("{patterns: [...]} envelope works", () => {
    const json = JSON.stringify({
      patterns: [
        { title: "t", body_markdown: "b", evidence_run_ids: ["r1"], theme_recurrence: 3 },
      ],
    });
    expect(parsePatternArtifacts(json).artifacts.length).toBe(1);
  });
  it("tolerates ```json fenced response", () => {
    const json = "```json\n" + JSON.stringify({
      patterns: [{ title: "t", body_markdown: "b", evidence_run_ids: ["r1"], theme_recurrence: 3 }],
    }) + "\n```";
    expect(parsePatternArtifacts(json).artifacts.length).toBe(1);
  });
  it("caps at PATTERNS_MAX_PER_CALL", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `t${i}`,
      body_markdown: "b",
      evidence_run_ids: ["r1"],
      theme_recurrence: 3,
    }));
    const r = parsePatternArtifacts(JSON.stringify({ patterns: many }));
    expect(r.artifacts.length).toBe(PATTERNS_MAX_PER_CALL);
  });
  it("counts invalid entries", () => {
    const mixed = [
      { title: "valid", body_markdown: "b", evidence_run_ids: ["r1"], theme_recurrence: 3 },
      { title: "bad: no body" },
      { title: "x".repeat(200), body_markdown: "b", evidence_run_ids: ["r1"], theme_recurrence: 3 },
    ];
    const r = parsePatternArtifacts(JSON.stringify({ patterns: mixed }));
    expect(r.artifacts.length).toBe(1);
    expect(r.invalid).toBe(2);
  });
});

describe("buildPatternsPrompt", () => {
  const runs: AgentRunSnippet[] = [
    { run_id: "r1", agent_slug: "dispute-response", finished_at: "2026-05-10T00:00:00Z", output_text: "alpha" },
    { run_id: "r2", agent_slug: "support-lead", finished_at: "2026-05-11T00:00:00Z", output_text: "beta" },
  ];

  it("contains every run_id", () => {
    const p = buildPatternsPrompt(runs);
    expect(p).toContain('run_id="r1"');
    expect(p).toContain('run_id="r2"');
  });
  it("contains agent_slug per run", () => {
    expect(buildPatternsPrompt(runs)).toContain('agent="dispute-response"');
  });
  it("declares the count up top", () => {
    expect(buildPatternsPrompt(runs)).toMatch(/^You are analyzing 2 agent_run outputs/);
  });
  it("instructs JSON-only output", () => {
    expect(buildPatternsPrompt(runs)).toContain("Return JSON only");
  });
  it("truncates per-run snippet at 1000 chars", () => {
    const big: AgentRunSnippet[] = [{
      run_id: "r1",
      agent_slug: "x",
      finished_at: "2026-05-01T00:00:00Z",
      output_text: "y".repeat(5000),
    }];
    const p = buildPatternsPrompt(big);
    expect(p).toContain("[truncated]");
  });
});

describe("estimatePatternCostUsd", () => {
  it("returns 4-decimal USD value", () => {
    const c = estimatePatternCostUsd(40000);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThan(0);
  });
  it("increases with prompt size", () => {
    expect(estimatePatternCostUsd(80000)).toBeGreaterThan(estimatePatternCostUsd(40000));
  });
});

describe("maxRunsUnderCostCap", () => {
  it("returns all runs when total cost fits", () => {
    const tiny: AgentRunSnippet[] = Array.from({ length: 5 }, (_, i) => ({
      run_id: `r${i}`,
      agent_slug: "x",
      finished_at: "2026-05-01T00:00:00Z",
      output_text: "small",
    }));
    expect(maxRunsUnderCostCap(tiny, PATTERNS_COST_CAP_USD)).toBe(5);
  });
  it("returns prefix when cap is tiny", () => {
    const tiny: AgentRunSnippet[] = Array.from({ length: 50 }, (_, i) => ({
      run_id: `r${i}`,
      agent_slug: "x",
      finished_at: "2026-05-01T00:00:00Z",
      output_text: "a".repeat(1000),
    }));
    const fit = maxRunsUnderCostCap(tiny, 0.01);
    expect(fit).toBeLessThan(tiny.length);
    expect(fit).toBeGreaterThanOrEqual(0);
  });
});
