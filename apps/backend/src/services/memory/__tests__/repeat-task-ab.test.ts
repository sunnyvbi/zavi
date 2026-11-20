import { describe, it, expect, vi } from "vitest";
import {
  dispatcherResultToArmResult,
  runRepeatTaskAb,
  type AbDispatchResult,
  type RepeatTaskAbDeps,
  type RepeatTaskGoldenLite,
} from "../repeat-task-ab";
import { computeGoldenDelta, type AbArm } from "../repeat-task-ab-types";

const golden: RepeatTaskGoldenLite = {
  id: "g-1",
  tenant_id: "t-1",
  agent_slug: "pm",
  query: "How many active hosts last week?",
};

describe("dispatcherResultToArmResult", () => {
  it("maps model cost + tokens; leaves retrieval/judge/correctness null (P4.3 fills)", () => {
    const result: AbDispatchResult = {
      output_text: "412 active hosts",
      parse_ok: true,
      usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.03 },
    };
    const row = dispatcherResultToArmResult({
      golden,
      arm: "brain_on",
      eval_run_id: "run-1",
      result,
      walltime_ms: 1500,
    });
    expect(row.model_cost_usd).toBe(0.03);
    expect(row.retrieval_cost_usd).toBeNull();
    expect(row.judge_cost_usd).toBeNull();
    expect(row.correctness_score).toBeNull();
    expect(row.terminal_status).toBe("finished");
    expect(row.walltime_ms).toBe(1500);
  });

  it("never fabricates cost — absent usage ⇒ null, not 0", () => {
    const row = dispatcherResultToArmResult({
      golden,
      arm: "brain_off",
      eval_run_id: "run-1",
      result: { output_text: "x", parse_ok: true },
      walltime_ms: 10,
    });
    expect(row.model_cost_usd).toBeNull();
  });

  it("flags a parse-failed run as parse_failed status", () => {
    const row = dispatcherResultToArmResult({
      golden,
      arm: "brain_on",
      eval_run_id: "run-1",
      result: { output_text: "", parse_ok: false },
      walltime_ms: 5,
    });
    expect(row.terminal_status).toBe("parse_failed");
  });
});

describe("runRepeatTaskAb", () => {
  function fixedDeps(
    dispatch: RepeatTaskAbDeps["dispatch"],
  ): { deps: RepeatTaskAbDeps; written: unknown[] } {
    const written: unknown[] = [];
    let t = 1000;
    const deps: RepeatTaskAbDeps = {
      dispatch,
      writeMetric: async (row) => {
        written.push(row);
      },
      newEvalRunId: () => "eval-fixed",
      now: () => (t += 100),
    };
    return { deps, written };
  }

  it("runs BOTH arms and writes a metric row for each", async () => {
    const seen: AbArm[] = [];
    const { deps, written } = fixedDeps(async (_g, arm) => {
      seen.push(arm);
      return {
        output_text: `answer-${arm}`,
        parse_ok: true,
        usage: { cost_usd: arm === "brain_on" ? 0.05 : 0.03 },
      };
    });
    const { eval_run_id, outcomes } = await runRepeatTaskAb(golden, deps);
    expect(seen).toEqual(["brain_on", "brain_off"]);
    expect(eval_run_id).toBe("eval-fixed");
    expect(written).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const okOut = outcomes.find((o) => o.ok && o.arm === "brain_on");
    expect(okOut && okOut.ok && okOut.output_text).toBe("answer-brain_on");

    const rows = outcomes.filter((o): o is Extract<typeof o, { ok: true }> => o.ok).map((o) => o.row);
    const delta = computeGoldenDelta(rows);
    expect(delta.customer_cost_delta).toBeCloseTo(0.02);
  });

  it("a thrown arm is recorded as an error row and does NOT abort the other arm", async () => {
    const { deps, written } = fixedDeps(async (_g, arm) => {
      if (arm === "brain_on") throw new Error("model timeout");
      return { output_text: "ok", parse_ok: true, usage: { cost_usd: 0.01 } };
    });
    const { outcomes } = await runRepeatTaskAb(golden, deps);
    expect(outcomes[0]).toMatchObject({ arm: "brain_on", ok: false });
    expect(outcomes[1]).toMatchObject({ arm: "brain_off", ok: true });
    expect(written).toHaveLength(2);
    const errRow = written[0] as { terminal_status: string };
    expect(errRow.terminal_status).toBe("dispatch_error");
  });

  it("a metric-write failure after a SUCCESSFUL dispatch is metric_write_error, NOT dispatch_error", async () => {
    const { deps } = fixedDeps(async () => ({
      output_text: "ok",
      parse_ok: true,
      usage: { cost_usd: 0.02 },
    }));
    deps.writeMetric = async () => {
      throw new Error("db down");
    };
    const { outcomes } = await runRepeatTaskAb(golden, deps);
    expect(outcomes).toHaveLength(2);
    for (const o of outcomes) {
      expect(o.ok).toBe(false);
      expect(o.ok === false && o.kind).toBe("metric_write_error");
    }
  });

  it("swallows a writeMetric failure on the error path (never loses the other arm)", async () => {
    let calls = 0;
    const deps: RepeatTaskAbDeps = {
      dispatch: async (_g, arm) => {
        if (arm === "brain_on") throw new Error("boom");
        return { output_text: "ok", parse_ok: true };
      },
      writeMetric: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db down");
      },
      newEvalRunId: () => "eval-x",
      now: () => 0,
    };
    const { outcomes } = await runRepeatTaskAb(golden, deps);
    expect(outcomes[1]).toMatchObject({ arm: "brain_off", ok: true });
  });
});
