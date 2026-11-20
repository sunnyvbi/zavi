import { describe, it, expect } from "vitest";
import {
  extractFirstJsonObject,
  parseRubricReply,
  meanRubric,
} from "../rubric";
import { buildReport } from "../report";
import { parseTasks } from "../task-loader";
import { scoreDeterministic, safeResolve } from "../deterministic";
import { FIXTURE_REPO_PATH } from "../task-loader";
import type { EvalTask, RubricResult, TaskOutcome } from "../types";

const sampleTask: EvalTask = {
  task_id: "eq-sample",
  agent_slug: "engineer",
  bucket: "bug-fix",
  source: "synthetic",
  prompt: "fix it",
  fixture_file: "src/clamp.mjs",
  test_file: "test/clamp.test.mjs",
  pass_check: "node --test test/clamp.test.mjs",
  expected_touch: ["src/clamp.mjs"],
  known_good_reference: "clamp to [1,100], default 20",
};

describe("rubric.extractFirstJsonObject", () => {
  it("extracts a bare JSON object", () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("extracts from a fenced block with prose around it", () => {
    const raw = 'Here is my grade:\n```json\n{"correctness":5,"x":"a"}\n```\nDone.';
    expect(extractFirstJsonObject(raw)).toBe('{"correctness":5,"x":"a"}');
  });
  it("handles braces inside string literals", () => {
    const raw = '{"justification":"used a {map} here"}';
    expect(extractFirstJsonObject(raw)).toBe(raw);
  });
  it("returns null when no object present", () => {
    expect(extractFirstJsonObject("no json at all")).toBeNull();
  });
});

describe("rubric.parseRubricReply", () => {
  it("parses a valid reply", () => {
    const raw = '{"correctness":5,"scope_fit":4,"regression_safety":3,"justification":"clean fix"}';
    const r = parseRubricReply("t1", raw);
    expect(r.error).toBeUndefined();
    expect(r.scores).toEqual({ correctness: 5, scope_fit: 4, regression_safety: 3 });
    expect(r.justification).toBe("clean fix");
  });
  it("tolerates surrounding prose / fences", () => {
    const raw = 'My grade:\n```\n{"correctness":2,"scope_fit":2,"regression_safety":2,"justification":"meh"}\n```';
    const r = parseRubricReply("t1", raw);
    expect(r.error).toBeUndefined();
    expect(r.scores.correctness).toBe(2);
  });
  it("errors (not throws) on out-of-range score", () => {
    const raw = '{"correctness":9,"scope_fit":2,"regression_safety":2,"justification":"x"}';
    const r = parseRubricReply("t1", raw);
    expect(r.error).toBeDefined();
    expect(r.scores.correctness).toBe(0);
  });
  it("errors (not throws) on non-JSON", () => {
    const r = parseRubricReply("t1", "totally not json");
    expect(r.error).toBeDefined();
  });
  it("errors on missing field", () => {
    const r = parseRubricReply("t1", '{"correctness":3,"scope_fit":3}');
    expect(r.error).toBeDefined();
  });
});

describe("rubric.meanRubric", () => {
  it("averages error-free results, rounding to 2dp", () => {
    const rs: RubricResult[] = [
      { task_id: "a", scores: { correctness: 5, scope_fit: 4, regression_safety: 3 }, justification: "" },
      { task_id: "b", scores: { correctness: 4, scope_fit: 3, regression_safety: 2 }, justification: "" },
    ];
    expect(meanRubric(rs)).toEqual({ correctness: 4.5, scope_fit: 3.5, regression_safety: 2.5 });
  });
  it("excludes errored results", () => {
    const rs: RubricResult[] = [
      { task_id: "a", scores: { correctness: 5, scope_fit: 5, regression_safety: 5 }, justification: "" },
      { task_id: "b", scores: { correctness: 0, scope_fit: 0, regression_safety: 0 }, justification: "", error: "bad" },
    ];
    expect(meanRubric(rs)).toEqual({ correctness: 5, scope_fit: 5, regression_safety: 5 });
  });
  it("returns null when all errored", () => {
    const rs: RubricResult[] = [
      { task_id: "a", scores: { correctness: 0, scope_fit: 0, regression_safety: 0 }, justification: "", error: "bad" },
    ];
    expect(meanRubric(rs)).toBeNull();
  });
});

describe("report.buildReport", () => {
  const det = (
    green: boolean,
    failure_kind: "infra" | "nofix" | null = null,
  ): TaskOutcome["deterministic"] => ({
    task_id: "t",
    tests_green: green,
    typecheck_ok: null,
    touched: [],
    out_of_scope: [],
    output_tail: "",
    failure_kind,
  });
  it("computes merge-equivalent % across tasks", () => {
    const outcomes: TaskOutcome[] = [
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(false), rubric: null },
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(true), rubric: null },
    ];
    const r = buildReport(outcomes);
    expect(r.total).toBe(4);
    expect(r.merge_equivalent_pct).toBe(75);
    expect(r.mean_rubric).toBeNull();
  });
  it("includes mean rubric when rubrics present", () => {
    const rubric: RubricResult = {
      task_id: "t",
      scores: { correctness: 4, scope_fit: 4, regression_safety: 4 },
      justification: "ok",
    };
    const outcomes: TaskOutcome[] = [
      { task: sampleTask, deterministic: det(true), rubric },
    ];
    const r = buildReport(outcomes);
    expect(r.merge_equivalent_pct).toBe(100);
    expect(r.mean_rubric).toEqual({ correctness: 4, scope_fit: 4, regression_safety: 4 });
  });
  it("is 0% for an empty suite", () => {
    expect(buildReport([]).merge_equivalent_pct).toBe(0);
  });

  it("EXCLUDES infra-failed tasks from the baseline denominator", () => {
    const outcomes: TaskOutcome[] = [
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(false, "infra"), rubric: null },
    ];
    const r = buildReport(outcomes);
    expect(r.total).toBe(4);
    expect(r.infra_errors).toBe(1);
    expect(r.scored).toBe(3);
    expect(r.merge_equivalent_pct).toBe(100);
  });

  it("COUNTS a genuine no-fix miss against the baseline", () => {
    const outcomes: TaskOutcome[] = [
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(true), rubric: null },
      { task: sampleTask, deterministic: det(false, "nofix"), rubric: null },
    ];
    const r = buildReport(outcomes);
    expect(r.infra_errors).toBe(0);
    expect(r.scored).toBe(4);
    expect(r.merge_equivalent_pct).toBe(75);
  });

  it("is 0% when every task is infra-failed (nothing scored)", () => {
    const outcomes: TaskOutcome[] = [
      { task: sampleTask, deterministic: det(false, "infra"), rubric: null },
    ];
    const r = buildReport(outcomes);
    expect(r.scored).toBe(0);
    expect(r.merge_equivalent_pct).toBe(0);
  });
});

describe("task-loader.parseTasks", () => {
  it("rejects invalid JSON", () => {
    expect(() => parseTasks("{not json")).toThrow(/not valid JSON/);
  });
  it("rejects an empty array", () => {
    expect(() => parseTasks("[]")).toThrow();
  });
  it("rejects a duplicate task_id", () => {
    const dup = JSON.stringify([
      { ...sampleTask },
      { ...sampleTask },
    ]);
    expect(() => parseTasks(dup)).toThrow(/duplicate task_id/);
  });
  it("accepts a valid single task", () => {
    const ok = JSON.stringify([sampleTask]);
    const tasks = parseTasks(ok);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("eq-sample");
  });
});

describe("deterministic.safeResolve", () => {
  const root = "/tmp/eq-root";
  it("accepts an in-tree relative path", () => {
    expect(safeResolve(root, "src/foo.mjs")).toBe("/tmp/eq-root/src/foo.mjs");
  });
  it("rejects an absolute path", () => {
    expect(safeResolve(root, "/etc/passwd")).toBeNull();
  });
  it("rejects a parent-traversal path", () => {
    expect(safeResolve(root, "../escape.mjs")).toBeNull();
  });
  it("rejects a sneaky traversal that resolves outside", () => {
    expect(safeResolve(root, "src/../../escape.mjs")).toBeNull();
  });
});

describe("deterministic.scoreDeterministic (against the real fixture)", () => {
  it("reports tests_green=true when a known-good fix is applied", () => {
    const goodClamp =
      "export function clampPageSize(n) {\n  if (!Number.isFinite(n)) return 20;\n  return Math.max(1, Math.min(100, n));\n}\n";
    const res = scoreDeterministic(FIXTURE_REPO_PATH, sampleTask, {
      task_id: sampleTask.task_id,
      files: [{ path: "src/clamp.mjs", action: "modify", content: goodClamp }],
    });
    expect(res.error).toBeUndefined();
    expect(res.tests_green).toBe(true);
    expect(res.touched).toEqual(["src/clamp.mjs"]);
    expect(res.out_of_scope).toEqual([]);
  });

  it("reports tests_green=false when the bug is left in place", () => {
    const stillBuggy =
      "export function clampPageSize(n) {\n  return Math.max(100, Math.min(1, n));\n}\n";
    const res = scoreDeterministic(FIXTURE_REPO_PATH, sampleTask, {
      task_id: sampleTask.task_id,
      files: [{ path: "src/clamp.mjs", action: "modify", content: stillBuggy }],
    });
    expect(res.error).toBeUndefined();
    expect(res.tests_green).toBe(false);
  });

  it("flags out-of-scope edits", () => {
    const goodClamp =
      "export function clampPageSize(n) {\n  if (!Number.isFinite(n)) return 20;\n  return Math.max(1, Math.min(100, n));\n}\n";
    const res = scoreDeterministic(FIXTURE_REPO_PATH, sampleTask, {
      task_id: sampleTask.task_id,
      files: [
        { path: "src/clamp.mjs", action: "modify", content: goodClamp },
        { path: "src/unrelated-new.mjs", action: "create", content: "export const x = 1;\n" },
      ],
    });
    expect(res.out_of_scope).toEqual(["src/unrelated-new.mjs"]);
  });

  it("errors (not throws) on an empty diff", () => {
    const res = scoreDeterministic(FIXTURE_REPO_PATH, sampleTask, {
      task_id: sampleTask.task_id,
      files: [],
    });
    expect(res.error).toBeDefined();
    expect(res.tests_green).toBe(false);
  });

  it("rejects an unsafe produced path", () => {
    const res = scoreDeterministic(FIXTURE_REPO_PATH, sampleTask, {
      task_id: sampleTask.task_id,
      files: [{ path: "../../escape.mjs", action: "create", content: "x" }],
    });
    expect(res.error).toMatch(/unsafe produced path/);
  });
});
