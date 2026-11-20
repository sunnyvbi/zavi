import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { HarnessFailure, preflightInstrumentSelfTest } from "@/services/eval/shadow-harness";
import { SHADOW_EXCLUDED_SANDBOX_TOOLS } from "@/services/agents/engine/openai-sandbox-tools";
import { SHADOW_DENY_BODY } from "@/services/agents/engine/shadow-tool-policy";
import { SpendLedger, withBenchRetries } from "../spend";
import { runTrials, type RunTrialFn, type TrialResult } from "../runner";
import { resolveModel } from "../manifest";
import { replaceTenantFixtures, loadFixtures, type TaskFixture } from "../fixtures";
import { hardChecks, judgePair, scoreTrial } from "../scorer";
import { FakeBenchClient } from "../client";
import { assertFixturesFilledFor, isReusableCache, runBench, type RowCache } from "../bench";
import { dryRunBench } from "../dry-run";
import { assertSharedLoopEnv } from "../live";
import {
  BENCH_EXCLUDED_SANDBOX_VERBS,
  BENCH_TOOL_DENY_BODY,
  benchDenyCodeFromPreview,
} from "../modes";
import {
  REQUIRED_CHANNEL_UNITS,
  REQUIRED_ROLE_UNITS,
  measurableUnits,
  missingUnits,
} from "../miner";
import { renderScorecard } from "../scorecard";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const qwen = resolveModel("qwen");

function fx(i: number, over: Partial<TaskFixture> = {}): TaskFixture {
  return {
    fixture_version: 1,
    task_id: `upcar-ai.pm.task${i}`,
    tenant_id: T,
    company: "upcar-ai",
    agent_slug: "pm",
    unit: "pm",
    cohort: "role",
    source_run_id: `s${i}`,
    input: { trigger: "cron", payload: null, prompt: { system: "s", initial_user: "u" } },
    evidence: [{ tenant_id: T, tool_name: "memory__search", input: { q: "x" }, content: "c", is_error: false }],
    filled_by: ["qwen", "claude-shared", "claude-sdk"],
    expected: {
      drafted_by: "gpt-5.5",
      drafter_family: "openai",
      assertions: [{ id: "a1", text: "t", cites: 0, expect_number: 12 }],
      uncited_ids: [],
    },
    ...over,
  };
}

const row = (over: Partial<TrialResult> = {}): TrialResult => ({
  task_id: "upcar-ai.pm.task1",
  unit: "pm",
  cohort: "role",
  company: "upcar-ai",
  model_key: "qwen",
  trial: 1,
  outcome: "completed",
  raw: { output_text: "the answer is 12", parse_ok: true, tool_calls: [], route_verdict: "ok" },
  billedUsd: 0,
  attempts: 1,
  ...over,
});

describe("fix 1 — per-attempt reservation, unknown cost at full reservation, ledger first", () => {
  it("4 retries at $1.50 under a $2 remainder cannot push spentUsd past maxUsd", async () => {
    const ledger = new SpendLedger(10);
    const pre = ledger.tryReserve(8, "prior spend")!;
    ledger.settle(pre, 8);
    let sent = 0;
    const out = await withBenchRetries(
      async () => {
        sent++;
        throw Object.assign(new Error("rate limited"), { status: 429, billedUsd: 1.5 });
      },
      { provider: "openrouter", sleep: async () => {}, reserve: { ledger, usd: 2, label: "t" } },
    );
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.maxUsd);
    expect(sent).toBe(1);
    expect(out.kind).toBe("capped");
    expect(ledger.partial).toBe(true);
  });

  it("a failed attempt with no billed cost is booked at the full reservation, never 0", async () => {
    const ledger = new SpendLedger(100);
    await withBenchRetries(
      async () => {
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
      { provider: "openrouter", sleep: async () => {}, reserve: { ledger, usd: 2, label: "t" } },
    );
    expect(ledger.spentUsd).toBe(2);
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const l = new SpendLedger(10);
      l.settle(l.tryReserve(3, "x")!, bad as number | undefined);
      expect(l.spentUsd).toBe(3);
    }
  });

  it("the runner reserves per attempt: retries each reserve their own ceiling", async () => {
    const ledger = new SpendLedger(100);
    let n = 0;
    const runTrial: RunTrialFn = async () => {
      if (++n < 3) throw Object.assign(new Error("502"), { status: 502, billedUsd: 0.1 });
      return { value: { output_text: "x", parse_ok: true, tool_calls: [], route_verdict: "ok" }, billedUsd: 0.2 };
    };
    await runTrials({ fixtures: [fx(1)], model: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger, runTrial, provider: "openrouter", sleep: async () => {} });
    expect(ledger.settled.map((s) => s.label)).toEqual([
      "run:upcar-ai.pm.task1#1#a1",
      "run:upcar-ai.pm.task1#1#a2",
      "run:upcar-ai.pm.task1#1#a3",
    ]);
    expect(ledger.spentUsd).toBeCloseTo(0.4);
  });

  it("--max-usd <= 0 / NaN is rejected", () => {
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new SpendLedger(v)).toThrow(HarnessFailure);
  });

  it("self-test probes are metered on the ledger (reserve before send, settle to billed cost)", async () => {
    const ledger = new SpendLedger(100);
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ usage: { cost: 0.001 } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await preflightInstrumentSelfTest({
      label: "openrouter", baseURL: "https://x", apiKey: "k", model: "a/b", fetchImpl,
      meter: (label) => {
        const r = ledger.tryReserve(0.5, label)!;
        seen.push(label);
        return (b) => ledger.settle(r, b);
      },
    });
    expect(seen).toHaveLength(2);
    expect(ledger.spentUsd).toBeCloseTo(0.002);
    const capped = new SpendLedger(0.4);
    await expect(
      preflightInstrumentSelfTest({
        label: "openrouter", baseURL: "https://x", apiKey: "k", model: "a/b", fetchImpl,
        meter: (label) => {
          const r = capped.tryReserve(0.5, label);
          if (!r) throw new HarnessFailure("cap");
          return (b) => capped.settle(r, b);
        },
      }),
    ).rejects.toBeInstanceOf(HarnessFailure);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("CLI source: the ledger is built before any self-test", () => {
    const src = readFileSync(join(__dirname, "../../../../../scripts/model-bench.ts"), "utf8");
    for (const fn of ["async function cmdBuild", "async function cmdRun"]) {
      const body = src.slice(src.indexOf(fn));
      expect(body.indexOf("new SpendLedger(a.maxUsd)")).toBeGreaterThan(0);
      expect(body.indexOf("new SpendLedger(a.maxUsd)")).toBeLessThan(body.indexOf("await selfTest("));
    }
  });
});

describe("fix 2 — incomplete judging leaves the trial unscored", () => {
  const judges = [resolveModel("gpt-5.5"), resolveModel("gemini-pro")] as const;

  it("all judge calls fail -> pair null -> pass=null, outcome judge_incomplete", async () => {
    const client = new FakeBenchClient(() => "not json at all");
    const j = await judgePair({ fixture: fx(1), candidate: row(), reference: row({ model_key: "claude-shared" }), judges, client, ledger: new SpendLedger(100) });
    expect(j).toBeNull();
    const s = scoreTrial(row(), j, true);
    expect(s.pass).toBeNull();
    expect(s.outcome).toBe("judge_incomplete");
  });

  it("one unparseable call of four makes the pair incomplete (never averaged over 3)", async () => {
    let n = 0;
    const client = new FakeBenchClient(() => (++n === 3 ? "garbage" : '{"better":"tie","reason":"r"}'));
    const j = await judgePair({ fixture: fx(1), candidate: row(), reference: row(), judges, client, ledger: new SpendLedger(100) });
    expect(j).toBeNull();
  });

  it("a retryable provider error is rethrown so withBenchRetries retries it", async () => {
    const client = { complete: vi.fn(async () => { throw Object.assign(new Error("429"), { status: 429 }); }) };
    await expect(
      judgePair({ fixture: fx(1), candidate: row(), reference: row(), judges, client, ledger: new SpendLedger(100) }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("without a judge requirement (judge_unavailable) hard checks stand alone", () => {
    expect(scoreTrial(row(), null, false).pass).toBe(true);
  });
});

describe("fix 3 — hard checks", () => {
  it("pass requires zero invalid tool calls", () => {
    const r = row({ raw: { output_text: "12", parse_ok: true, tool_calls: [{ name: "x", code: "invalid_input" }], route_verdict: "ok" } });
    expect(hardChecks(r).pass).toBe(false);
  });

  it("a legacy answer key on the fixture changes nothing: no number is required", () => {
    const h = hardChecks(row({ raw: { output_text: "a markdown spec with no numbers", parse_ok: true, tool_calls: [], route_verdict: "ok" } }));
    expect(h.pass).toBe(true);
    expect(Object.keys(h)).not.toContain("expected_numbers");
  });
});

describe("fix 4 — harness-gap row is independent of the candidate", () => {
  it("the Claude shared-vs-SDK gap line and harness judges are identical across two candidates", async () => {
    const a = await dryRunBench("qwen", 3);
    const b = await dryRunBench("gpt-5.5", 3);
    const line = (md: string) => md.split("\n").find((l) => l.startsWith("| Harness effect"));
    const judgesLine = (md: string) => md.split("\n").find((l) => l.startsWith("- Harness-effect judges"));
    expect(line(a.report.markdown)).toBeTruthy();
    expect(line(a.report.markdown)).not.toContain("n/a");
    expect(line(a.report.markdown)).toEqual(line(b.report.markdown));
    expect(judgesLine(a.report.markdown)).toEqual(judgesLine(b.report.markdown));
    expect(a.report.markdown).toMatch(/- Judges: gpt-5\.5 \+ gemini-pro/);
    expect(b.report.markdown).not.toMatch(/- Judges: gpt-5\.5/);
    expect(a.report.harness_shared.every((s) => s.judge !== null || s.pass === null)).toBe(true);
  });
});

describe("fix 5 — cache reuse only on an exact, complete, same-provenance row set", () => {
  const f = fx(1);
  const good = (t: number): TrialResult => row({ trial: t, harness_sha: "sha1", model_id: qwen.model_id, upstream: qwen.upstream, fixture_version: 1 });
  const want = { trials: 3, harness_sha: "sha1", model: qwen, fixture: f };
  it("accepts a complete matching set and rejects every mismatch", () => {
    expect(isReusableCache([good(1), good(2), good(3)], want)).toBe(true);
    expect(isReusableCache([good(1), good(2)], want)).toBe(false);
    expect(isReusableCache([good(1), good(1), good(3)], want)).toBe(false);
    expect(isReusableCache([good(1), good(2), { ...good(3), harness_sha: "sha0" }], want)).toBe(false);
    expect(isReusableCache([good(1), good(2), { ...good(3), model_id: "other/x" }], want)).toBe(false);
    expect(isReusableCache([good(1), good(2), { ...good(3), upstream: "Together" }], want)).toBe(false);
    expect(isReusableCache([good(1), good(2), { ...good(3), fixture_version: 0 }], want)).toBe(false);
    expect(isReusableCache(null, want)).toBe(false);
  });

  it("runBench reruns a stale cached set instead of reusing it", async () => {
    const stale: RowCache = { get: () => [good(1), good(2), good(3)].map((r) => ({ ...r, harness_sha: "old" })), put: () => {} };
    const runTrial = vi.fn(async () => ({ value: { output_text: "12", parse_ok: true, tool_calls: [], route_verdict: "ok" as const }, billedUsd: 0.01 }));
    await runBench({
      fixtures: [f], candidate: qwen, trials: 3, concurrency: 1, sandboxConcurrency: 1, ledger: new SpendLedger(100),
      runTrialFor: () => runTrial, beforeModel: () => {},
      client: new FakeBenchClient(() => '{"better":"tie","reason":"r"}', 0.001),
      cache: stale, date: "d", harness_sha: "sha1", dry_run: true, sleep: async () => {},
    });
    expect(runTrial).toHaveBeenCalledTimes(9);
  });
});

describe("fix 6 — fixtures must be filled by the candidate and both Claude rows", () => {
  it("refuses with a rebuild instruction", () => {
    expect(() => assertFixturesFilledFor([fx(1, { filled_by: ["claude-shared", "claude-sdk"] })], qwen)).toThrow(/Rebuild: model-bench build --models qwen/);
    expect(() => assertFixturesFilledFor([fx(1, { filled_by: ["qwen", "claude-shared"] })], qwen)).toThrow(HarnessFailure);
    expect(() => assertFixturesFilledFor([fx(1)], qwen)).not.toThrow();
  });
});

describe("fix 7 — mining coverage against the required roster", () => {
  it("roster = 16 enabled role agents + 20 channels", () => {
    expect(REQUIRED_ROLE_UNITS).toHaveLength(16);
    expect(REQUIRED_CHANNEL_UNITS).toHaveLength(20);
    expect(REQUIRED_CHANNEL_UNITS).not.toContain("influencers");
    expect(measurableUnits().map((u) => u.unit)).not.toContain("qa");
  });

  it("every missing measurable unit renders as 'not covered: no usable run'", () => {
    const fixtures = [fx(1)];
    const md = renderScorecard({
      date: "d", model_key: "qwen", model_lineage: "x", harness_sha: "s", trials: 1, fixtures,
      candidate: [], reference_sdk: [], harness_shared: [],
      judges: "judge_unavailable", harness_judges: "judge_unavailable", spent_usd: 0, max_usd: 1, partial: false, dry_run: false,
    });
    const missing = missingUnits("upcar-ai", fixtures);
    expect(missing).not.toContain("pm");
    expect(missing).toContain("seo");
    for (const u of missing) expect(md).toContain(`| ${u} | - | - | - | not covered: no usable run |`);
    expect(md).toContain("| qa | - | - | - | not measurable yet:");
    expect(md).toMatch(/apna-tutor \(tutoring\): 0 task\(s\); not covered: no usable run: advisor/);
  });

  it("live read issues one scoped query per unit (source-level)", () => {
    const src = readFileSync(join(__dirname, "../live.ts"), "utf8");
    expect(src).toMatch(/for \(const \{ unit, cohort \} of measurableUnits\(\)\)/);
    expect(src).toMatch(/q\.eq\("trigger", "channel_recipe"\)\.eq\("payload->>channel_slug", unit\)/);
    expect(src).not.toMatch(/limit\(600\)|limit = 600/);
  });
});

describe("fix 8 — a build replaces the tenant's fixture set", () => {
  it("removes files not in the new set, keeps other tenants, leaves no temp files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-fx-"));
    const other = "f47c4bdc-c90d-424f-ab68-bf8b045ac8c0";
    replaceTenantFixtures(T, [fx(1), fx(2)], dir);
    replaceTenantFixtures(other, [fx(9, { tenant_id: other, company: "apna-tutor", evidence: [] })], dir);
    replaceTenantFixtures(T, [fx(2)], dir);
    const ids = loadFixtures(dir).map((f) => f.task_id).sort();
    expect(ids).toEqual(["upcar-ai.pm.task2", "upcar-ai.pm.task9"]);
    expect(readdirSync(join(dir, "fixtures")).filter((n) => n.startsWith(".tmp"))).toHaveLength(0);
    expect(() => replaceTenantFixtures(T, [fx(3, { tenant_id: other })], dir)).toThrow(HarnessFailure);
  });
});

const dispatcher = readFileSync(join(__dirname, "../../../agents/generic-dispatcher.ts"), "latin1");

describe("fix 9 — a bench ctx never enters best-of-N", () => {
  it("routes straight to runGenericOnce before resolveBestOfNPolicy", () => {
    const body = dispatcher.slice(dispatcher.indexOf("export async function runGeneric("));
    const bypass = body.indexOf("if (ctx.draft_mode === true || isBenchRun(ctx)");
    expect(bypass).toBeGreaterThan(0);
    expect(bypass).toBeLessThan(body.indexOf("await resolveBestOfNPolicy()"));
  });
});

describe("fix 10 — bench runs write no setup-block row and no channel_skill telemetry", () => {
  it("both writes are guarded by writesSuppressed(ctx), which is true for every shadow (bench) run", () => {
    expect(dispatcher).toMatch(/if \(!writesSuppressed\(ctx\)\) await recordSetupBlock\(/);
    expect(dispatcher).toMatch(/for \(const name of writesSuppressed\(ctx\) \? \[\] : built\.skills\)/);
    expect(dispatcher).toMatch(/return ctx\.shadow_mode === true \|\| ctx\.draft_mode === true;/);
  });
});

describe("fix 11 — a row can only run on the model it is labelled with", () => {
  const env = { PRAXIS_SHADOW_PROVIDER: "openrouter", PRAXIS_SHADOW_OPENROUTER_MODEL: qwen.model_id, PRAXIS_SHADOW_OPENROUTER_UPSTREAM: qwen.upstream! };
  it("assertSharedLoopEnv refuses any mismatch", () => {
    expect(() => assertSharedLoopEnv(qwen, env as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertSharedLoopEnv(qwen, { ...env, PRAXIS_SHADOW_OPENROUTER_MODEL: "openai/gpt-5.5" } as NodeJS.ProcessEnv)).toThrow(HarnessFailure);
    expect(() => assertSharedLoopEnv(qwen, { ...env, PRAXIS_SHADOW_OPENROUTER_UPSTREAM: "Together" } as NodeJS.ProcessEnv)).toThrow(HarnessFailure);
    expect(() => assertSharedLoopEnv(qwen, { ...env, PRAXIS_SHADOW_PROVIDER: "openai" } as NodeJS.ProcessEnv)).toThrow(HarnessFailure);
  });
  it("liveTrial asserts routing before every trial; runBench calls beforeModel (required)", () => {
    const live = readFileSync(join(__dirname, "../live.ts"), "utf8");
    const body = live.slice(live.indexOf("export async function liveTrial"));
    expect(body.indexOf("assertSharedLoopEnv(a.model);")).toBeGreaterThan(0);
    expect(body.indexOf("assertSharedLoopEnv(a.model);")).toBeLessThan(body.indexOf("runGeneric"));
    const bench = readFileSync(join(__dirname, "../bench.ts"), "utf8");
    expect(bench).toMatch(/beforeModel: \(model: ManifestEntry\) => void;/);
  });
});

describe("fix 12 — one source of truth for excluded sandbox verbs", () => {
  it("BENCH_EXCLUDED_SANDBOX_VERBS IS the shadow exclusion set", () => {
    expect(BENCH_EXCLUDED_SANDBOX_VERBS).toBe(SHADOW_EXCLUDED_SANDBOX_TOOLS);
  });
});

describe("fix 13 — SDK-path denials count as forbidden-action attempts", () => {
  it("the deny bodies map to forbidden codes; a replay miss does not", () => {
    expect(benchDenyCodeFromPreview(JSON.stringify([{ type: "text", text: BENCH_TOOL_DENY_BODY }]))).toBe("bench_tool_outside_boundary");
    expect(benchDenyCodeFromPreview(SHADOW_DENY_BODY)).toBe("shadow_no_side_effect");
    expect(benchDenyCodeFromPreview("shadow same-evidence replay: no captured result")).toBeUndefined();
    const r = row({ raw: { output_text: "12", parse_ok: true, tool_calls: [{ name: "mcp__server__slack__post", status: "tool_error", code: benchDenyCodeFromPreview(BENCH_TOOL_DENY_BODY) }], route_verdict: "sdk" } });
    expect(hardChecks(r).forbidden_attempts).toBe(1);
    expect(hardChecks(r).pass).toBe(false);
  });
  it("live.ts derives the code from the trace preview for code-less tool errors", () => {
    const live = readFileSync(join(__dirname, "../live.ts"), "utf8");
    expect(live).toMatch(/t\.code \?\? \(t\.status === "tool_error" \? codeFromSdkToolError\(t\.output_preview\) : undefined\)/);
  });
});
