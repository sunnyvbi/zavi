import { describe, it, expect } from "vitest";
import {
  extractFirstJsonObject,
  buildResearchRubricPrompt,
  parseResearchRubricReply,
  meanResearchRubric,
} from "../rubric";
import { buildResearchReport } from "../report";
import { parseResearchTasks, parseResearchBaseline } from "../task-loader";
import type { ResearchEvalTask, ResearchRubricResult, ResearchTaskOutcome } from "../types";

const sampleTask: ResearchEvalTask = {
  task_id: "rq-sample",
  agent_slug: "research",
  ask: "What is the TAM for X?",
  notes: "carry the as-of date; hedge stale figures",
};

const validReply =
  '{"source_independence":4,"recency":5,"primary_vs_secondary":3,"so_what":4,"fact_vs_judgment":5,"justification":"hedged the 2021 TAM"}';

describe("rubric.extractFirstJsonObject", () => {
  it("extracts a bare JSON object", () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("extracts from a fenced block with prose around it", () => {
    const raw = 'Here is my grade:\n```json\n{"recency":5,"x":"a"}\n```\nDone.';
    expect(extractFirstJsonObject(raw)).toBe('{"recency":5,"x":"a"}');
  });
  it("returns null when no object present", () => {
    expect(extractFirstJsonObject("no json at all")).toBeNull();
  });
});

describe("rubric.buildResearchRubricPrompt", () => {
  it("includes the ask + notes + report, and is blind (no reference answer)", () => {
    const { system, user } = buildResearchRubricPrompt(sampleTask, "# Report\n…");
    expect(system).toMatch(/BLIND/);
    expect(user).toContain("What is the TAM for X?");
    expect(user).toContain("carry the as-of date");
    expect(user).toContain("# Report");
  });
  it("handles a missing/empty report gracefully", () => {
    const { user } = buildResearchRubricPrompt(sampleTask, "");
    expect(user).toContain("(no report produced)");
  });
});

describe("rubric.parseResearchRubricReply", () => {
  it("parses a valid 5-field reply", () => {
    const r = parseResearchRubricReply("t1", validReply);
    expect(r.error).toBeUndefined();
    expect(r.scores).toEqual({
      source_independence: 4,
      recency: 5,
      primary_vs_secondary: 3,
      so_what: 4,
      fact_vs_judgment: 5,
    });
    expect(r.justification).toBe("hedged the 2021 TAM");
  });
  it("tolerates surrounding prose / fences", () => {
    const raw = `My grade:\n\`\`\`\n${validReply}\n\`\`\``;
    const r = parseResearchRubricReply("t1", raw);
    expect(r.error).toBeUndefined();
    expect(r.scores.recency).toBe(5);
  });
  it("errors (not throws) on out-of-range score", () => {
    const raw =
      '{"source_independence":9,"recency":5,"primary_vs_secondary":3,"so_what":4,"fact_vs_judgment":5,"justification":"x"}';
    const r = parseResearchRubricReply("t1", raw);
    expect(r.error).toBeDefined();
    expect(r.scores.source_independence).toBe(0);
  });
  it("errors (not throws) on non-JSON", () => {
    const r = parseResearchRubricReply("t1", "totally not json");
    expect(r.error).toBeDefined();
  });
  it("errors on a missing dimension", () => {
    const r = parseResearchRubricReply("t1", '{"recency":3,"so_what":3}');
    expect(r.error).toBeDefined();
  });
});

describe("rubric.meanResearchRubric", () => {
  const mk = (
    id: string,
    s: Partial<ResearchRubricResult["scores"]>,
    error?: string,
  ): ResearchRubricResult => ({
    task_id: id,
    scores: {
      source_independence: 0,
      recency: 0,
      primary_vs_secondary: 0,
      so_what: 0,
      fact_vs_judgment: 0,
      ...s,
    },
    justification: "",
    error,
  });

  it("averages error-free results, rounding to 2dp", () => {
    const rs = [
      mk("a", { recency: 5, so_what: 4 }),
      mk("b", { recency: 4, so_what: 3 }),
    ];
    const m = meanResearchRubric(rs);
    expect(m?.recency).toBe(4.5);
    expect(m?.so_what).toBe(3.5);
  });
  it("excludes errored results", () => {
    const rs = [mk("a", { recency: 5 }), mk("b", { recency: 0 }, "bad")];
    expect(meanResearchRubric(rs)?.recency).toBe(5);
  });
  it("returns null when all errored", () => {
    expect(meanResearchRubric([mk("a", {}, "bad")])).toBeNull();
  });
});

describe("report.buildResearchReport", () => {
  const okOutcome = (id: string, scores: ResearchRubricResult["scores"]): ResearchTaskOutcome => ({
    task: { ...sampleTask, task_id: id },
    rendered_preview: "",
    rubric: { task_id: id, scores, justification: "ok" },
  });
  const full = (n: number) => ({
    source_independence: n,
    recency: n,
    primary_vs_secondary: n,
    so_what: n,
    fact_vs_judgment: n,
  });

  it("passes baseline when every dim meets the floor", () => {
    const r = buildResearchReport([okOutcome("a", full(4)), okOutcome("b", full(4))], full(3));
    expect(r.scored).toBe(2);
    expect(r.passed_baseline).toBe(true);
    expect(r.mean_rubric).toEqual(full(4));
  });

  it("fails baseline when a dim drops below its floor", () => {
    const low = { ...full(4), so_what: 2 };
    const r = buildResearchReport([okOutcome("a", low)], full(3));
    expect(r.passed_baseline).toBe(false);
  });

  it("excludes run-error outcomes from the scored count", () => {
    const errOutcome: ResearchTaskOutcome = {
      task: { ...sampleTask, task_id: "z" },
      rendered_preview: "",
      run_error: "no envelope",
      rubric: { task_id: "z", scores: full(0), justification: "", error: "run failed" },
    };
    const r = buildResearchReport([okOutcome("a", full(4)), errOutcome], full(3));
    expect(r.total).toBe(2);
    expect(r.run_errors).toBe(1);
    expect(r.scored).toBe(1);
    expect(r.passed_baseline).toBe(true);
  });

  it("is vacuously passing with no baseline", () => {
    const r = buildResearchReport([okOutcome("a", full(1))], null);
    expect(r.passed_baseline).toBe(true);
  });
});

describe("task-loader (parses the committed suite + baseline)", () => {
  it("rejects invalid tasks JSON", () => {
    expect(() => parseResearchTasks("{not json")).toThrow(/not valid JSON/);
  });
  it("rejects an empty task array", () => {
    expect(() => parseResearchTasks("[]")).toThrow();
  });
  it("rejects a duplicate task_id", () => {
    const dup = JSON.stringify([sampleTask, sampleTask]);
    expect(() => parseResearchTasks(dup)).toThrow(/duplicate task_id/);
  });
  it("accepts a valid single task", () => {
    const tasks = parseResearchTasks(JSON.stringify([sampleTask]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("rq-sample");
  });
  it("parses a valid baseline", () => {
    const b = parseResearchBaseline(JSON.stringify({
      source_independence: 3,
      recency: 3,
      primary_vs_secondary: 3,
      so_what: 3,
      fact_vs_judgment: 3,
    }));
    expect(b.recency).toBe(3);
  });
  it("rejects a baseline missing a dimension", () => {
    expect(() => parseResearchBaseline('{"recency":3}')).toThrow();
  });
});
