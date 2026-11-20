import { describe, it, expect, vi, beforeEach } from "vitest";

type CountRes = { data: unknown; error: unknown; count: number | null };

let runStatus: string | null | undefined;
let decisionCount = 0;
let noteCount = 0;
let eventCount = 0;
let rollupRunIds: string[] = [];
let raise: { table: string; message: string } | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => makeClient(),
}));

function makeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      let isHeadCount = false;

      const chain = () => builder;
      builder.select = (
        _c?: unknown,
        opts?: { head?: boolean; count?: string },
      ) => {
        isHeadCount = !!opts?.head;
        return builder;
      };
      builder.eq = chain;
      builder.in = chain;
      builder.order = chain;
      builder.limit = chain;

      builder.maybeSingle = () => {
        if (raise && raise.table === table)
          return Promise.resolve({ data: null, error: { message: raise.message } });
        if (runStatus === undefined)
          return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: { status: runStatus }, error: null });
      };

      builder.then = (resolve: (v: unknown) => unknown) => {
        if (raise && raise.table === table)
          return resolve({ data: null, error: { message: raise.message }, count: null });

        if (table === "agent_runs" && !isHeadCount) {
          return resolve({
            data: rollupRunIds.map((id) => ({ id })),
            error: null,
          });
        }
        const count =
          table === "decisions"
            ? decisionCount
            : table === "memory_note"
              ? noteCount
              : table === "agent_run_events"
                ? eventCount
                : 0;
        const res: CountRes = { data: null, error: null, count };
        return resolve(res);
      };

      return builder;
    },
  };
}

import {
  classifyOutcomeFromCounts,
  rollupOutcomes,
  isSucceededButEmpty,
  classifyCronRunOutcome,
  fetchOutcomeCounts,
  rollupCronOutcomes,
  SUCCESS_STATUSES,
  TERMINAL_STATUSES,
  type CronRunOutcome,
} from "@/services/agents/cron-outcome";
import { cronOutcomeLabel } from "@/services/agents/cron-summary";

beforeEach(() => {
  runStatus = undefined;
  decisionCount = 0;
  noteCount = 0;
  eventCount = 0;
  rollupRunIds = [];
  raise = null;
});

describe("classifyOutcomeFromCounts — outcome taxonomy", () => {
  it("Bug-B: status=success ∧ 0 decisions ∧ 0 notes ∧ 0 side-effects → empty", () => {
    const o = classifyOutcomeFromCounts({
      status: "success",
      decisionCount: 0,
      noteCount: 0,
      sideEffectCount: 0,
    });
    expect(o).toBe("empty");
    expect(isSucceededButEmpty(o)).toBe(true);
  });

  it("success ∧ ≥1 decision → produced_decision (decision is the strongest signal)", () => {
    expect(
      classifyOutcomeFromCounts({
        status: "success",
        decisionCount: 1,
        noteCount: 0,
        sideEffectCount: 0,
      }),
    ).toBe("produced_decision");
    expect(
      classifyOutcomeFromCounts({
        status: "success",
        decisionCount: 3,
        noteCount: 5,
        sideEffectCount: 9,
      }),
    ).toBe("produced_decision");
  });

  it("success ∧ 0 decisions ∧ ≥1 note → produced_note", () => {
    expect(
      classifyOutcomeFromCounts({
        status: "success",
        decisionCount: 0,
        noteCount: 2,
        sideEffectCount: 0,
      }),
    ).toBe("produced_note");
    expect(
      classifyOutcomeFromCounts({
        status: "success",
        decisionCount: 0,
        noteCount: 1,
        sideEffectCount: 4,
      }),
    ).toBe("produced_note");
  });

  it("success ∧ only a side-effect (no decision/note) → produced_artifact", () => {
    expect(
      classifyOutcomeFromCounts({
        status: "success",
        decisionCount: 0,
        noteCount: 0,
        sideEffectCount: 1,
      }),
    ).toBe("produced_artifact");
  });

  it("non-success terminal statuses → failed (never empty/produced)", () => {
    for (const status of ["parse_failed", "dispatch_error", "error", "failed"]) {
      expect(
        classifyOutcomeFromCounts({
          status,
          decisionCount: 0,
          noteCount: 0,
          sideEffectCount: 0,
        }),
      ).toBe("failed");
    }
  });

  it("a partial side-effect on a NON-success run still grades failed (never masks)", () => {
    expect(
      classifyOutcomeFromCounts({
        status: "dispatch_error",
        decisionCount: 1,
        noteCount: 1,
        sideEffectCount: 1,
      }),
    ).toBe("failed");
  });

  it("in-flight runs (queued/running/unknown) → null (skip, not graded)", () => {
    expect(
      classifyOutcomeFromCounts({
        status: "queued",
        decisionCount: 0,
        noteCount: 0,
        sideEffectCount: 0,
      }),
    ).toBeNull();
    expect(
      classifyOutcomeFromCounts({
        status: "running",
        decisionCount: 5,
        noteCount: 0,
        sideEffectCount: 0,
      }),
    ).toBeNull();
    expect(
      classifyOutcomeFromCounts({
        status: "some_future_status",
        decisionCount: 0,
        noteCount: 0,
        sideEffectCount: 0,
      }),
    ).toBeNull();
  });

  it("status set invariants", () => {
    expect(SUCCESS_STATUSES.has("success")).toBe(true);
    expect(TERMINAL_STATUSES.has("success")).toBe(true);
    expect(TERMINAL_STATUSES.has("parse_failed")).toBe(true);
    expect(TERMINAL_STATUSES.has("queued")).toBe(false);
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
  });
});

describe("rollupOutcomes — per-(tenant,agent) health rates", () => {
  it("empty input → all-zero, no NaN", () => {
    const r = rollupOutcomes([]);
    expect(r.count).toBe(0);
    expect(r.empty_rate).toBe(0);
    expect(r.fail_rate).toBe(0);
    expect(r.productive_rate).toBe(0);
  });

  it("skips in-flight nulls from count and rates", () => {
    const r = rollupOutcomes([null, "produced_decision", null, "empty"]);
    expect(r.count).toBe(2);
    expect(r.by_class.produced_decision).toBe(1);
    expect(r.by_class.empty).toBe(1);
    expect(r.empty_rate).toBeCloseTo(0.5, 10);
  });

  it("computes empty/fail/productive rates correctly (Bug-B trend visible)", () => {
    const outcomes: CronRunOutcome[] = [
      "produced_decision",
      "produced_decision",
      "produced_decision",
      "produced_decision",
      "produced_note",
      "produced_artifact",
      "empty",
      "empty",
      "failed",
      "failed",
    ];
    const r = rollupOutcomes(outcomes);
    expect(r.count).toBe(10);
    expect(r.empty_rate).toBeCloseTo(0.2, 10);
    expect(r.fail_rate).toBeCloseTo(0.2, 10);
    expect(r.productive_rate).toBeCloseTo(0.6, 10);
    expect(r.by_class.empty).toBe(2);
  });

  it("all-empty agent (the Bug-B growth-lead pattern) → empty_rate 1.0", () => {
    const r = rollupOutcomes(["empty", "empty", "empty", "empty"]);
    expect(r.empty_rate).toBe(1);
    expect(r.productive_rate).toBe(0);
    expect(r.fail_rate).toBe(0);
  });
});

describe("classifyCronRunOutcome — fetch + classify (stubbed client)", () => {
  it("missing run row → null", async () => {
    runStatus = undefined;
    expect(await classifyCronRunOutcome("run-missing")).toBeNull();
  });

  it("Bug-B end-to-end: success run with 0 side-effects → empty", async () => {
    runStatus = "success";
    decisionCount = 0;
    noteCount = 0;
    eventCount = 0;
    const o = await classifyCronRunOutcome("run-buggy");
    expect(o).toBe("empty");
    expect(isSucceededButEmpty(o)).toBe(true);
  });

  it("success run with a decision → produced_decision", async () => {
    runStatus = "success";
    decisionCount = 2;
    const o = await classifyCronRunOutcome("run-good");
    expect(o).toBe("produced_decision");
  });

  it("success run with only a note → produced_note", async () => {
    runStatus = "success";
    noteCount = 1;
    expect(await classifyCronRunOutcome("run-note")).toBe("produced_note");
  });

  it("success run with only a completed-tool event → produced_artifact", async () => {
    runStatus = "success";
    eventCount = 3;
    expect(await classifyCronRunOutcome("run-art")).toBe("produced_artifact");
  });

  it("failed run → failed", async () => {
    runStatus = "dispatch_error";
    expect(await classifyCronRunOutcome("run-fail")).toBe("failed");
  });

  it("in-flight run → null", async () => {
    runStatus = "running";
    expect(await classifyCronRunOutcome("run-inflight")).toBeNull();
  });

  it("a DB read error throws (never silently mis-grades)", async () => {
    runStatus = "success";
    raise = { table: "agent_runs", message: "boom" };
    await expect(classifyCronRunOutcome("run-x")).rejects.toThrow(/agent_runs read failed: boom/);
  });

  it("fetchOutcomeCounts returns the raw counts struct", async () => {
    runStatus = "success";
    decisionCount = 1;
    noteCount = 2;
    eventCount = 3;
    const c = await fetchOutcomeCounts("run-counts");
    expect(c).toEqual({
      status: "success",
      decisionCount: 1,
      noteCount: 2,
      sideEffectCount: 3,
    });
  });
});

describe("cronOutcomeLabel — additive UI display string", () => {
  it("maps each outcome class to a human label; Bug-B empty → 'produced: nothing'", () => {
    expect(cronOutcomeLabel("produced_decision")).toBe("produced: a decision");
    expect(cronOutcomeLabel("produced_note")).toBe("produced: a note");
    expect(cronOutcomeLabel("produced_artifact")).toBe("produced: an artifact");
    expect(cronOutcomeLabel("empty")).toBe("produced: nothing");
    expect(cronOutcomeLabel("failed")).toBe("failed");
  });

  it("null/undefined → no label (status-only fallback, backward compatible)", () => {
    expect(cronOutcomeLabel(null)).toBeNull();
    expect(cronOutcomeLabel(undefined)).toBeNull();
  });
});

describe("rollupCronOutcomes — per-(tenant,agent) trend (stubbed client)", () => {
  it("no recent runs → all-zero rollup", async () => {
    rollupRunIds = [];
    const r = await rollupCronOutcomes("tenant-1", "growth-lead");
    expect(r.count).toBe(0);
    expect(r.empty_rate).toBe(0);
  });

  it("classifies each recent run and folds rates (all-empty Bug-B agent)", async () => {
    runStatus = "success";
    decisionCount = 0;
    noteCount = 0;
    eventCount = 0;
    rollupRunIds = ["r1", "r2", "r3"];
    const r = await rollupCronOutcomes("tenant-1", "growth-lead", {
      limit: 30,
    });
    expect(r.count).toBe(3);
    expect(r.by_class.empty).toBe(3);
    expect(r.empty_rate).toBe(1);
    expect(r.productive_rate).toBe(0);
  });

  it("a productive agent rolls up productive", async () => {
    runStatus = "success";
    decisionCount = 1;
    rollupRunIds = ["r1", "r2"];
    const r = await rollupCronOutcomes("tenant-1", "engineer");
    expect(r.count).toBe(2);
    expect(r.by_class.produced_decision).toBe(2);
    expect(r.productive_rate).toBe(1);
  });
});
