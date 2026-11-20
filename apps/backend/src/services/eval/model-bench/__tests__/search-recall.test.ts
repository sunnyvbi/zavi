
import { describe, it, expect } from "vitest";
import { computeSearchRecall, renderScorecard, type ScorecardInput } from "../scorecard";
import type { TrialResult } from "../runner";

function row(task: string, trial: number, calls: string[], surfaced?: string[]): TrialResult {
  return {
    task_id: task,
    unit: "pm",
    cohort: "role",
    company: "upcar-ai",
    model_key: "m",
    trial,
    outcome: "completed",
    raw: {
      output_text: "x",
      parse_ok: true,
      tool_calls: calls.map((name) => ({ name, status: "ok" })),
      route_verdict: "ok",
      ...(surfaced ? { surfaced_tools: surfaced } : {}),
    },
    billedUsd: 0,
    attempts: 1,
  };
}

describe("computeSearchRecall", () => {
  it("a candidate trial misses when the prod-loop reference called a tool it was never shown (SDK names normalized)", () => {
    const ref = [
      row("t1", 1, ["mcp__server__github__search_code", "mcp__memory__search", "ToolSearch"]),
      row("t2", 1, ["web_fetch__fetch"]),
    ];
    const cand = [
      row("t1", 1, [], ["memory__search"]),
      row("t1", 2, [], ["memory__search", "github__search_code"]),
      row("t2", 1, [], ["web_fetch__fetch"]),
      row("t2", 2, []),
    ];
    const s = computeSearchRecall(cand, ref);
    expect(s).toEqual({
      tasks: 2,
      tasks_with_miss: 1,
      trials: 3,
      no_reference: 0,
      trials_with_miss: 1,
      missed_tools: [{ name: "github__search_code", trials: 1 }],
    });
  });

  it("rows whose outcome is not 'completed' are skipped in BOTH loops", () => {
    const failedRef = { ...row("t1", 1, ["github__search_code"]), outcome: "infra" as const };
    const okRef = row("t1", 2, ["web_fetch__fetch"]);
    const failedCand = { ...row("t1", 1, [], []), outcome: "model_failure" as const };
    const okCand = row("t1", 2, [], ["web_fetch__fetch"]);
    const s = computeSearchRecall([failedCand, okCand], [failedRef, okRef]);
    expect(s).toEqual({ tasks: 1, tasks_with_miss: 0, trials: 1, no_reference: 0, trials_with_miss: 0, missed_tools: [] });
  });

  it("a task with no completed reference is not measured; a completed reference with zero calls is", () => {
    const refs = [
      { ...row("t1", 1, ["github__search_code"]), outcome: "infra" as const },
      row("t2", 1, []),
    ];
    const cand = [row("t1", 1, [], []), row("t2", 1, [], [])];
    expect(computeSearchRecall(cand, refs)).toEqual({
      tasks: 1,
      tasks_with_miss: 0,
      trials: 1,
      no_reference: 1,
      trials_with_miss: 0,
      missed_tools: [],
    });
  });

  it("no measured trial -> zero counts", () => {
    expect(computeSearchRecall([row("t1", 1, [])], [row("t1", 1, ["a__b"])]).trials).toBe(0);
  });
});

describe("scorecard renders the recall line apart from model failures", () => {
  const base = {
    date: "2026-09-25",
    model_key: "gpt-5.5",
    model_lineage: "openai",
    harness_sha: "abc",
    trials: 1,
    fixtures: [],
    candidate: [],
    reference_sdk: [],
    harness_shared: [],
    judges: "judge_unavailable",
    harness_judges: "judge_unavailable",
    spent_usd: 0,
    max_usd: 5,
    partial: false,
    dry_run: false,
  } as unknown as ScorecardInput;

  it("measured", () => {
    const md = renderScorecard({
      ...base,
      search_recall: {
        tasks: 2,
        tasks_with_miss: 1,
        trials: 3,
        no_reference: 0,
        trials_with_miss: 1,
        missed_tools: [{ name: "github__search_code", trials: 1 }],
      },
    });
    expect(md).toContain("## Search recall (candidate; counted apart from model failures)");
    expect(md).toContain(
      "Tasks where a tool the Claude prod-loop reference called was never surfaced to the candidate: 1 of 2 (1 of 3 trials)",
    );
    expect(md).toContain("Most-missed tools: github__search_code (1)");
  });

  it("not measured", () => {
    expect(renderScorecard(base)).toContain("Not measured: tool search was not active on any candidate trial.");
  });
});

import { searchRecallLines } from "../scorecard";

describe("recall zero-state distinguishes a missing reference from inactive search", () => {
  it("says the reference is missing, not that search was inactive", () => {
    const lines = searchRecallLines({ trials: 0, no_reference: 2, trials_with_miss: 0, missed_tools: [] } as never).join("\n");
    expect(lines).toMatch(/no completed Claude prod-loop reference/);
    expect(lines).not.toMatch(/not active on any candidate/);
  });
});
