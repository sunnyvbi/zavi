import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessFailure } from "@/services/eval/shadow-harness";
import { SpendLedger, RESERVE_USD, reservationFor } from "../spend";
import { runTrials, type RunTrialFn, type TrialResult } from "../runner";
import { resolveModel } from "../manifest";
import type { TaskFixture } from "../fixtures";
import {
  allTrialsPassed,
  judgePair,
  scoreTrial,
  taskRates,
  trialPassRate,
  verdictGap,
  type ScoredTrial,
  type Verdict,
} from "../scorer";
import { FakeBenchClient } from "../client";
import { assertNoFixturePayload, publishScorecard, renderScorecard } from "../scorecard";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const model = resolveModel("qwen");

function fx(i: number, over: Partial<TaskFixture> = {}): TaskFixture {
  return {
    fixture_version: 1,
    task_id: `upcar-ai.pm.task${i}`,
    tenant_id: T,
    company: "upcar-ai",
    agent_slug: "pm",
    unit: "pm",
    cohort: "role",
    source_run_id: `src${i}`,
    input: {
      trigger: "cron",
      payload: null,
      prompt: { system: "PROMPT-SENTINEL system text for the pm agent run", initial_user: "What should we ship next quarter, given churn?" },
    },
    evidence: [
      {
        tenant_id: T,
        tool_name: "memory__search",
        input: { q: "churn" },
        content: "EVIDENCE-SENTINEL weekly churn was 7.4 percent across 412 active hosts in Q3",
        is_error: false,
      },
    ],
    filled_by: ["claude-shared"],
    expected: {
      drafted_by: "gpt-5.5",
      drafter_family: "openai",
      assertions: [{ id: "a1", text: "ASSERTION-SENTINEL states the churn rate from the evidence", cites: 0, expect_number: 7.4 }],
      uncited_ids: [],
    },
    ...over,
  };
}

const ok = (text = "churn is 7.4 percent") =>
  ({ value: { output_text: text, parse_ok: true, tool_calls: [], route_verdict: "ok" as const }, billedUsd: 0.4 });

describe("test 12 — reservation cap under concurrency", () => {
  it("3 concurrent runs never commit more than --max-usd, even if every run is slow", async () => {
    const ledger = new SpendLedger(5);
    let inFlight = 0;
    let maxInFlight = 0;
    const runTrial: RunTrialFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      expect(ledger.spentUsd + ledger.inFlightUsd).toBeLessThanOrEqual(5);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ...ok(), billedUsd: 1.9 };
    };
    const results = await runTrials({
      fixtures: [fx(1), fx(2), fx(3)],
      model,
      trials: 3,
      concurrency: 3,
      sandboxConcurrency: 2,
      ledger,
      runTrial,
      provider: "openrouter",
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(ledger.spentUsd).toBeLessThanOrEqual(5);
    expect(ledger.partial).toBe(true);
    expect(results.length).toBeLessThan(9);
  });

  it("engineer trials hold at most sandboxConcurrency boxes at once", async () => {
    const ledger = new SpendLedger(1000);
    let boxes = 0;
    let maxBoxes = 0;
    const runTrial: RunTrialFn = async () => {
      boxes++;
      maxBoxes = Math.max(maxBoxes, boxes);
      await new Promise((r) => setTimeout(r, 5));
      boxes--;
      return ok();
    };
    await runTrials({
      fixtures: [fx(1, { agent_slug: "engineer", unit: "engineer" }), fx(2, { agent_slug: "engineer", unit: "engineer" })],
      model,
      trials: 3,
      concurrency: 3,
      sandboxConcurrency: 2,
      ledger,
      runTrial,
      provider: "openrouter",
    });
    expect(maxBoxes).toBeLessThanOrEqual(2);
    expect(ledger.settled.every((s) => s.reserved === RESERVE_USD.engineer)).toBe(true);
  });
});

describe("reservation size per unit", () => {
  it("a channel run reserves the channel ceiling, a role run the default, engineer its own", () => {
    expect(reservationFor("run", "performance-marketer", "channel")).toBe(RESERVE_USD.channel);
    expect(reservationFor("run", "pm", "role")).toBe(RESERVE_USD.run);
    expect(reservationFor("run", "engineer", "channel")).toBe(RESERVE_USD.engineer);
    expect(RESERVE_USD.channel).toBeGreaterThan(RESERVE_USD.run);
  });
});

describe("test 8 — failure attribution", () => {
  const run = (runTrial: RunTrialFn, trials = 1) =>
    runTrials({
      fixtures: [fx(1)],
      model,
      trials,
      concurrency: 1,
      sandboxConcurrency: 1,
      ledger: new SpendLedger(100),
      runTrial,
      provider: "openrouter",
      sleep: async () => {},
    });

  it("a HarnessFailure aborts the run and produces no rows", async () => {
    const rows: TrialResult[] = [];
    await expect(
      run(async () => {
        throw new HarnessFailure("our bug");
      }).then((r) => rows.push(...r)),
    ).rejects.toBeInstanceOf(HarnessFailure);
    expect(rows).toHaveLength(0);
  });

  it("a local module fault is treated as ours (abort), not a model verdict", async () => {
    await expect(run(async () => { throw new Error("Cannot find module 'x'"); })).rejects.toBeInstanceOf(HarnessFailure);
  });

  it("rate limits retry (every attempt billed) and exhaust into infra, not a model failure", async () => {
    let calls = 0;
    const [r] = await run(async () => {
      calls++;
      throw Object.assign(new Error("rate limited"), { status: 429, billedUsd: 0.05 });
    });
    expect(calls).toBe(4);
    expect(r.outcome).toBe("infra");
    expect(r.billedUsd).toBeCloseTo(0.2);
  });

  it("a transient 5xx that recovers is a normal completed trial", async () => {
    let calls = 0;
    const [r] = await run(async () => {
      if (++calls === 1) throw Object.assign(new Error("upstream 502"), { status: 502 });
      return ok();
    });
    expect(r.outcome).toBe("completed");
    expect(r.attempts).toBe(2);
  });

  it("context overflow is scored context_too_small and COUNTS in the headline", async () => {
    const [r] = await run(async () => {
      throw Object.assign(new Error("This model's maximum context length is 32768 tokens"), { status: 400 });
    });
    expect(r.outcome).toBe("context_too_small");
    expect(scoreTrial(r, null).pass).toBe(false);
  });

  it("a response served by an unpinned route is discarded (excluded), a model without billed usage is refused", async () => {
    const [r] = await run(async () => ({ ...ok(), value: { ...ok().value, route_verdict: "unpinned_route" as const } }));
    expect(r.outcome).toBe("discarded_unpinned");
    expect(scoreTrial(r, null).pass).toBeNull();
    await expect(
      run(async () => ({ ...ok(), value: { ...ok().value, route_verdict: "no_usage_cost" as const } })),
    ).rejects.toBeInstanceOf(HarnessFailure);
  });
});

describe("test 6 — cost cap includes judge calls and marks the scorecard partial", () => {
  it("judge calls reserve against the same ledger and stop before crossing the cap", async () => {
    const ledger = new SpendLedger(1.0);
    const client = new FakeBenchClient(() => '{"better":"A","reason":"r"}', 0.3);
    const f = fx(1);
    const cand: TrialResult = { task_id: f.task_id, unit: "pm", cohort: "role", company: "upcar-ai", model_key: "qwen", trial: 1, outcome: "completed", raw: ok().value, billedUsd: 0, attempts: 1 };
    const ref: TrialResult = { ...cand, model_key: "claude-shared" };
    const j = await judgePair({
      fixture: f,
      candidate: cand,
      reference: ref,
      judges: [resolveModel("gpt-5.5"), resolveModel("gemini-pro")],
      client,
      ledger,
    });
    expect(j).toBeNull();
    expect(client.calls).toHaveLength(2);
    expect(ledger.spentUsd).toBeCloseTo(0.6);
    expect(ledger.spentUsd + ledger.inFlightUsd).toBeLessThanOrEqual(1.0);
    expect(ledger.partial).toBe(true);
  });

  it("run + judge spend share one ledger; the rendered scorecard says PARTIAL", async () => {
    const ledger = new SpendLedger(3);
    const results = await runTrials({
      fixtures: [fx(1), fx(2)],
      model,
      trials: 3,
      concurrency: 3,
      sandboxConcurrency: 2,
      ledger,
      runTrial: async () => ok(),
      provider: "openrouter",
    });
    expect(ledger.partial).toBe(true);
    expect(ledger.spentUsd).toBeLessThanOrEqual(3);
    const scored = results.map((r) => scoreTrial(r, null));
    const md = renderScorecard({
      date: "2026-09-25", model_key: "qwen", model_lineage: "x", harness_sha: "abc", trials: 3,
      fixtures: [fx(1), fx(2)], candidate: scored, reference_sdk: [], harness_shared: [], harness_judges: "judge_unavailable",
      judges: "judge_unavailable", spent_usd: ledger.spentUsd, max_usd: 3, partial: ledger.partial, dry_run: false,
    });
    expect(md).toMatch(/PARTIAL/);
  });
});

describe("test 7 — scorecard math on a fixed result set", () => {
  const st = (
    task: string,
    trial: number,
    pass: boolean | null,
    company = "upcar-ai",
    cohort: "role" | "channel" = "role",
    verdict: Verdict | null = null,
  ): ScoredTrial => ({
    task_id: task, unit: "pm", cohort, company, trial, outcome: "completed",
    hard: { schema_ok: true, forbidden_attempts: 0, tool_calls: 0, invalid_tool_calls: 0, pass: !!pass },
    judge: null, verdict, pass,
  });

  it("trial pass rate + 3-of-3 (not pass^3) + excluded trials never counted", () => {
    const cand = [
      st("t1", 1, true), st("t1", 2, true), st("t1", 3, true),
      st("t2", 1, true), st("t2", 2, false), st("t2", 3, true),
      st("t3", 1, null), st("t3", 2, true), st("t3", 3, true),
    ];
    expect(trialPassRate(cand)).toEqual({ passes: 7, n: 8, rate: 7 / 8 });
    const rates = taskRates(cand);
    expect(rates.map((r) => [r.task_id, r.passes, r.n])).toEqual([["t1", 3, 3], ["t2", 2, 3], ["t3", 2, 2]]);
    expect(allTrialsPassed(rates, 3)).toEqual({ k: 1, of: 2 });
  });

  it("paired gap = mean per-task verdict score (better +1, same 0, worse -1); unjudged trials are skipped", () => {
    const s = [
      st("t1", 1, true, "upcar-ai", "role", "better"), st("t1", 2, true, "upcar-ai", "role", "same"), st("t1", 3, true, "upcar-ai", "role", "better"),
      st("t2", 1, false, "upcar-ai", "role", "worse"), st("t2", 2, true, "upcar-ai", "role", "same"), st("t2", 3, null),
      st("t3", 1, true, "apna-tutor", "role", "same"),
      st("t9", 1, null),
    ];
    const g = verdictGap(s, { iterations: 500, seed: 1 })!;
    expect(g.tasks).toBe(3);
    expect(g.gap).toBeCloseTo((2 / 3 + -1 / 2 + 0) / 3, 10);
    expect(g.lo).toBeLessThanOrEqual(g.gap);
    expect(g.hi).toBeGreaterThanOrEqual(g.gap);
    expect(verdictGap(s, { iterations: 500, seed: 1 })).toEqual(g);
    expect(verdictGap([st("x", 1, null)])).toBeNull();
  });

  it("all-same verdicts give a zero gap with a zero-width interval", () => {
    expect(verdictGap([st("a", 1, true, "upcar-ai", "role", "same"), st("a", 2, true, "upcar-ai", "role", "same")])).toMatchObject({ gap: 0, lo: 0, hi: 0, tasks: 1 });
  });

  it("stratification: a single-task stratum never borrows tasks from another stratum", () => {
    const s = [
      st("r1", 1, true, "upcar-ai", "role", "same"),
      st("r2", 1, true, "upcar-ai", "role", "same"),
      st("c1", 1, true, "upcar-ai", "channel", "better"),
    ];
    const g = verdictGap(s, { iterations: 300, seed: 3 })!;
    expect(g.lo).toBeCloseTo(1 / 3);
    expect(g.hi).toBeCloseTo(1 / 3);
  });
});

describe("test 13 — committed scorecard holds no fixture payload", () => {
  it("the rendered scorecard carries no evidence, prompt or assertion text", () => {
    const fixtures = [fx(1), fx(2)];
    const r: TrialResult = { task_id: fixtures[0].task_id, unit: "pm", cohort: "role", company: "upcar-ai", model_key: "qwen", trial: 1, outcome: "completed", raw: ok("ANSWER churn 7.4").value, billedUsd: 0, attempts: 1 };
    const md = renderScorecard({
      date: "2026-09-25", model_key: "qwen", model_lineage: "x", harness_sha: "abc", trials: 3,
      fixtures, candidate: [scoreTrial(r, null)], reference_sdk: [], harness_shared: [], harness_judges: "judge_unavailable",
      judges: ["gpt-5.5", "gemini-pro"], spent_usd: 1, max_usd: 300, partial: false, dry_run: false,
    });
    for (const s of ["EVIDENCE-SENTINEL", "PROMPT-SENTINEL", "ASSERTION-SENTINEL", "ANSWER churn"]) {
      expect(md).not.toContain(s);
    }
    expect(() => assertNoFixturePayload(md, fixtures)).not.toThrow();
    expect(md).toMatch(/fixture_version: 1/);
    expect(md).toMatch(/upcar-ai\.pm\.task1: [0-9a-f]{16}/);
  });

  it("a scorecard that leaks payload is refused and nothing is published", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-"));
    const fixtures = [fx(1)];
    const leaky = `# card\n${fixtures[0].evidence[0].content.slice(5, 60)}\n`;
    expect(() => publishScorecard(join(dir, "card.md"), leaky, fixtures)).toThrow(HarnessFailure);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(existsSync(join(dir, "card.md"))).toBe(false);
  });

  it("a clean scorecard publishes atomically (no temp file left behind)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-"));
    publishScorecard(join(dir, "card.md"), "# card\n| x | 1/2 |\n", [fx(1)]);
    expect(readdirSync(dir)).toEqual(["card.md"]);
  });
});

void vi;
