
import { describe, expect, it } from "vitest";
import { ALL_SHAPES, DEVELOPMENT_SHAPES, HOLDOUT_SHAPES, questionsFor, type Question } from "../questions";

const all: Question[] = ALL_SHAPES.flatMap((s) => questionsFor(s).questions);

describe("operator-db analytics question bank", () => {
  it("keeps the development and held-out halves separate and complete", () => {
    expect(DEVELOPMENT_SHAPES.slice().sort()).toEqual([
      "consumer",
      "ecommerce",
      "marketplace",
      "saas",
    ]);
    expect(HOLDOUT_SHAPES.slice().sort()).toEqual(["agency", "ledger", "logistics"]);
    expect(ALL_SHAPES.slice().sort()).toEqual(
      [...DEVELOPMENT_SHAPES, ...HOLDOUT_SHAPES].sort(),
    );
    expect(DEVELOPMENT_SHAPES.some((s) => HOLDOUT_SHAPES.includes(s))).toBe(false);
  });

  it("has unique question ids", () => {
    const ids = all.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every question names at least one trap", () => {
    for (const q of all) expect(q.traps.length, q.id).toBeGreaterThan(0);
  });

  it("every shape asks at least one question the schema CANNOT answer", () => {
    for (const shape of ALL_SHAPES) {
      const qs = questionsFor(shape).questions;
      expect(qs.some((q) => q.traps.includes("abstain_missing_field")), shape).toBe(true);
    }
  });

  it("no known-wrong answer collides with the right answer", () => {
    for (const q of all) {
      if (q.kind !== "numeric") continue;
      for (const w of q.knownWrongAnswers ?? []) {
        const drift = q.expected === 0 ? Math.abs(w.value) : Math.abs(w.value - q.expected) / Math.abs(q.expected);
        expect(
          drift > Math.max(q.tolerance, 1e-9),
          `${q.id}: the "${w.because}" mistake produces ${w.value}, which is within tolerance of the correct ${q.expected} — this question no longer catches that mistake`,
        ).toBe(true);
      }
    }
  });

  it("numeric expectations are finite; counts and percentages are non-negative", () => {
    for (const q of all) {
      if (q.kind !== "numeric") continue;
      expect(Number.isFinite(q.expected), q.id).toBe(true);
      if (q.unit !== "usd") expect(q.expected, q.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("percent answers are in 0..100, not 0..1", () => {
    for (const q of all) {
      if (q.kind !== "numeric" || q.unit !== "percent") continue;
      expect(q.expected, q.id).toBeGreaterThan(1);
      expect(q.expected, q.id).toBeLessThanOrEqual(100);
    }
  });

  it("fixtures are deterministic — two builds produce identical rows", () => {
    for (const shape of ALL_SHAPES) {
      const a = questionsFor(shape).dataset;
      const b = questionsFor(shape).dataset;
      expect(JSON.stringify(a.tables), shape).toEqual(JSON.stringify(b.tables));
    }
  });

  it("the truncation questions really do exceed the read cap", () => {
    const ecommerce = questionsFor("ecommerce").dataset;
    const consumer = questionsFor("consumer").dataset;
    expect(ecommerce.tables.find((t) => t.name === "web_sessions")!.rows.length).toBeGreaterThan(5000);
    expect(consumer.tables.find((t) => t.name === "app_events")!.rows.length).toBeGreaterThan(5000);
  });

  it("the marketplace status column really is written in mixed case", () => {
    const rows = questionsFor("marketplace").dataset.tables.find((t) => t.name === "bookings")!.rows;
    const statuses = new Set(rows.map((r) => String(r.status)));
    expect(statuses.has("completed")).toBe(true);
    expect(statuses.has("COMPLETED")).toBe(true);
  });

  it("the e-commerce fixture really contains a Simpson's paradox", () => {
    const sessions = questionsFor("ecommerce").dataset.tables.find((t) => t.name === "web_sessions")!.rows;
    const rate = (month: string, source?: string) => {
      const xs = sessions.filter(
        (s) =>
          String((s.started_at as Date).toISOString()).startsWith(month) &&
          (source === undefined || s.source === source),
      );
      return xs.filter((s) => s.converted).length / xs.length;
    };
    expect(rate("2026-08")).toBeLessThan(rate("2026-07"));
    expect(rate("2026-08", "paid")).toBeGreaterThan(rate("2026-07", "paid"));
    expect(rate("2026-08", "organic")).toBeGreaterThan(rate("2026-07", "organic"));
  });
});

describe("narrative grading hygiene", () => {
  it("hides the harness's own ANSWER line from the judge", async () => {
    const { stripAnswerLine } = await import("../harness/grade");
    expect(stripAnswerLine("Churn was 2.8% of accounts in August.\n\nANSWER: 2.7624")).toBe(
      "Churn was 2.8% of accounts in August.",
    );
    expect(stripAnswerLine("No cancellation event exists.\nANSWER: CANNOT_ANSWER")).toBe(
      "No cancellation event exists.",
    );
    expect(stripAnswerLine("Nothing to strip here.")).toBe("Nothing to strip here.");
    expect(stripAnswerLine("Logo churn was 2.8% of 36 accounts.\n\nANSWER: **2.7624**")).toBe(
      "Logo churn was 2.8% of 36 accounts.",
    );
    expect(stripAnswerLine("No end event exists.\nANSWER: `CANNOT_ANSWER`")).toBe(
      "No end event exists.",
    );
  });
});

describe("trap liveness", () => {
  it("every declared trap is actually reachable in the data", async () => {
    const { checkQuestionBank } = await import("../bank-integrity");
    const { findings } = checkQuestionBank();
    expect(findings.map((f) => `${f.case_id}: ${f.reason}`)).toEqual([]);
  });
});

describe("answer extraction", () => {
  it("accepts a bolded final line — that is markdown, not a wrong answer", async () => {
    const { extractAnswer } = await import("../harness/grade");
    expect(extractAnswer("Completed bookings in August.\nANSWER: **142**")).toEqual({
      kind: "number",
      value: 142,
    });
    expect(extractAnswer("ANSWER: `142`")).toEqual({ kind: "number", value: 142 });
    expect(extractAnswer("ANSWER: 142")).toEqual({ kind: "number", value: 142 });
    expect(extractAnswer("Nothing supports this.\nANSWER: **CANNOT_ANSWER**")).toEqual({
      kind: "cannot",
    });
    expect(extractAnswer("ANSWER: -199")).toEqual({ kind: "number", value: -199 });
  });

  it("still refuses a line that is not an answer", async () => {
    const { extractAnswer } = await import("../harness/grade");
    expect(extractAnswer("I could not work it out.")).toBeNull();
    expect(extractAnswer("ANSWER: about a hundred")).toBeNull();
  });
});
