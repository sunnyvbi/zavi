import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger } from "../spend";
import { runTrials, type RunTrialFn, type TrialResult } from "../runner";
import { resolveModel } from "../manifest";
import { ensureBenchDir, loadFixtures, replaceTenantFixtures, type TaskFixture } from "../fixtures";
import { hardChecks, judgePair, parseJudge, scoreTrial } from "../scorer";
import { FakeBenchClient, type CompleteRequest } from "../client";
import { runBench, type RowCache } from "../bench";
import { traceToToolCalls } from "../live";
import { UNIT_SCAN_LIMIT, validRowsForUnit, type SourceRunRow } from "../miner";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const qwen = resolveModel("qwen");
const judges = [resolveModel("gpt-5.5"), resolveModel("gemini-pro")] as const;

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

const okJudge = () => new FakeBenchClient(() => '{"better":"tie","reason":"r"}', 0.001);

describe("r2 item 1 — a failed shared-loop attempt with no billed calls settles at the full reservation", () => {
  it("live.ts attaches billedUsd on error ONLY when the verdict is ok", () => {
    const live = readFileSync(join(__dirname, "../live.ts"), "utf8");
    expect(live).toMatch(/if \(b\.verdict === "ok"\) \(e as BilledError\)\.billedUsd = b\.usd;/);
    expect(live).not.toMatch(/b\.verdict === "no_calls"\) \(e as BilledError\)/);
  });
});

describe("r2 item 2 — an overrun is booked and stops all further scheduling", () => {
  it("actual > reserved: booked in full, partial, reason reservation_exceeded, next reserve refused", () => {
    const l = new SpendLedger(100);
    l.settle(l.tryReserve(2, "a")!, 3.5);
    expect(l.spentUsd).toBe(3.5);
    expect(l.partial).toBe(true);
    expect(l.stopReason).toBe("reservation_exceeded");
    expect(l.tryReserve(0.01, "b")).toBeNull();
  });
});

describe("r2 item 3 — a capped trial is excluded and never cached", () => {
  it("capped row is excluded from means, not cached, and a later bigger budget reruns it", async () => {
    const f = fx(1);
    const store = new Map<string, TrialResult[]>();
    const cache: RowCache = {
      get: (m, fx_) => store.get(`${m.key}|${fx_.task_id}`) ?? null,
      put: (m, fx_, rows) => void store.set(`${m.key}|${fx_.task_id}`, rows),
    };
    const flaky = vi.fn(async () => {
      throw Object.assign(new Error("429"), { status: 429, billedUsd: 0.6 });
    });
    const small = new SpendLedger(2.5);
    const r1 = await runTrials({ fixtures: [f], model: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger: small, runTrial: flaky, provider: "openrouter", sleep: async () => {} });
    expect(r1[0].outcome).toBe("capped");
    expect(scoreTrial(r1[0], null, true).pass).toBeNull();

    const runTrial = vi.fn(async () => ({ value: { output_text: "12", parse_ok: true, tool_calls: [], route_verdict: "ok" as const }, billedUsd: 0.01 }));
    const deps = (ledger: SpendLedger, rt: RunTrialFn) => ({
      fixtures: [f], candidate: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger,
      runTrialFor: () => rt, beforeModel: () => {}, client: okJudge(), cache,
      date: "d", harness_sha: "sha", dry_run: true, sleep: async () => {},
    });
    await runBench(deps(new SpendLedger(2.5), flaky));
    expect(store.size).toBe(0);
    await runBench(deps(new SpendLedger(100), runTrial));
    expect(runTrial).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(3);
  });
});

describe("r2 item 4 — Claude reference rows + harness judging run before the candidate", () => {
  it("every harness judge call and Claude trial happens before the first candidate trial", async () => {
    const log: string[] = [];
    const client = new FakeBenchClient((req: CompleteRequest) => {
      log.push(`judge:${req.model.key}`);
      return '{"better":"tie","reason":"r"}';
    }, 0.001);
    await runBench({
      fixtures: [fx(1)], candidate: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger: new SpendLedger(100),
      runTrialFor: (m) => async () => {
        log.push(`run:${m.key}`);
        return { value: { output_text: "12", parse_ok: true, tool_calls: [], route_verdict: "ok" }, billedUsd: 0.01 };
      },
      beforeModel: () => {}, client, cache: { get: () => null, put: () => {} },
      date: "d", harness_sha: "sha", dry_run: true, sleep: async () => {},
    });
    const firstCand = log.indexOf("run:qwen");
    expect(log.slice(0, firstCand)).toEqual([
      "run:claude-shared",
      "run:claude-sdk",
      "judge:gpt-5.5", "judge:gpt-5.5", "judge:gemini-pro", "judge:gemini-pro",
    ]);
  });

  it("if the cap stops before the harness pairs complete, the harness line is n/a (partial)", async () => {
    const report = await runBench({
      fixtures: [fx(1)], candidate: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger: new SpendLedger(3),
      runTrialFor: () => async () => ({ value: { output_text: "12", parse_ok: true, tool_calls: [], route_verdict: "ok" }, billedUsd: 1.2 }),
      beforeModel: () => {}, client: okJudge(), cache: { get: () => null, put: () => {} },
      date: "d", harness_sha: "sha", dry_run: true, sleep: async () => {},
    });
    const line = report.markdown.split("\n").find((l) => l.startsWith("| Harness effect"));
    expect(line).toContain("n/a (partial)");
  });
});

describe("r2 item 5 — strict judge verdicts", () => {
  it("accepts {better, reason}; rejects any 'better' other than A|B|tie, a missing/non-string reason, or no JSON", () => {
    expect(parseJudge('{"better":"B","reason":"cites the evidence"}')).toEqual({ better: "B", reason: "cites the evidence" });
    expect(parseJudge(`{"better":"tie","reason":"${"x".repeat(300)}"}`).reason).toHaveLength(200);
    for (const bad of [
      '{"better":"a","reason":"r"}',
      '{"better":"both","reason":"r"}',
      '{"reason":"r"}',
      '{"better":"A"}',
      '{"better":"A","reason":7}',
      "no json here",
    ]) {
      expect(() => parseJudge(bad), bad).toThrow();
    }
  });

  it("a malformed verdict makes the pair incomplete -> judge_incomplete", async () => {
    const client = new FakeBenchClient(() => '{"better":"maybe","reason":"r"}');
    const j = await judgePair({ fixture: fx(1), candidate: row(), reference: row(), judges, client, ledger: new SpendLedger(100) });
    expect(j).toBeNull();
    expect(scoreTrial(row(), j, true).outcome).toBe("judge_incomplete");
  });
});

describe("r2 item 6 — the repo's real invalid-tool codes fail hard checks", () => {
  it("an SDK trial with a tool_input_invalid error then a good answer fails", () => {
    const calls = traceToToolCalls([
      {
        name: "mcp__server__memory__search",
        input_preview: "{}",
        output_preview: JSON.stringify([{ type: "text", text: JSON.stringify({ error: "tool_input_invalid", message: "q required" }) }]),
        ms: 0,
        status: "tool_error",
      },
      { name: "mcp__server__memory__search", input_preview: "{}", output_preview: "ok", ms: 0, status: "ok" },
    ]);
    expect(calls[0].code).toBe("tool_input_invalid");
    const r = row({ raw: { output_text: "the answer is 12", parse_ok: true, tool_calls: calls, route_verdict: "sdk" } });
    const h = hardChecks(r);
    expect(h.invalid_tool_calls).toBe(1);
    expect(h.pass).toBe(false);
  });
  it("tool_unknown counts too, and a plain JSON error body is read directly", () => {
    const [c] = traceToToolCalls([{ name: "x", input_preview: "{}", output_preview: '{"error":"tool_unknown"}', ms: 0, status: "tool_error" }]);
    expect(c.code).toBe("tool_unknown");
    expect(hardChecks(row({ raw: { output_text: "12", parse_ok: true, tool_calls: [c], route_verdict: "sdk" } })).pass).toBe(false);
  });
});

describe("r2 item 8 — temp files are never loadable", () => {
  it("a leftover temp write is ignored by load and deleted by the next replace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-r2-"));
    replaceTenantFixtures(T, [fx(1)], dir);
    const fdir = join(ensureBenchDir(dir), "fixtures");
    writeFileSync(join(fdir, `.tmp-999-${T}__upcar-ai.pm.task7.json.partial`), JSON.stringify(fx(7)));
    writeFileSync(join(fdir, `.tmp-999-${T}__upcar-ai.pm.task8.json`), JSON.stringify(fx(8)));
    expect(loadFixtures(dir).map((f) => f.task_id)).toEqual(["upcar-ai.pm.task1"]);
    replaceTenantFixtures(T, [fx(1)], dir);
    expect(readdirSync(fdir).filter((n) => n.startsWith(".tmp-"))).toHaveLength(0);
  });
});

describe("r2 item 9 — per-unit mining and keep-stale", () => {
  const SNAP = "--- system ---\nS\n\n--- initial user ---\nWhich onboarding step loses the most new hosts, and why?";
  const r = (i: number, snap: string | null): SourceRunRow => ({
    id: `id${i}`, tenant_id: T, agent_slug: "pm", trigger: "cron", payload: null, prompt_snapshot: snap, enqueued_at: `2026-09-${10 + i}`,
  });
  it("keeps the first perUnit rows that PASS snapshot validation (limit after validation)", () => {
    const rows = [r(9, null), r(8, "garbage"), r(7, SNAP), r(6, SNAP), r(5, SNAP)];
    expect(validRowsForUnit(rows, 2).map((x) => x.id)).toEqual(["id7", "id6"]);
    expect(validRowsForUnit([r(1, null)], 1)).toEqual([]);
    expect(UNIT_SCAN_LIMIT).toBe(50);
  });
  it("the live read scans UNIT_SCAN_LIMIT rows per unit and the CLI passes --per-unit through", () => {
    const live = readFileSync(join(__dirname, "../live.ts"), "utf8");
    expect(live).toMatch(/\.limit\(UNIT_SCAN_LIMIT\)/);
    expect(live).toMatch(/out\.push\(\.\.\.validRowsForUnit\(rows, perUnit\)\)/);
    const cli = readFileSync(join(__dirname, "../../../../../scripts/model-bench.ts"), "utf8");
    expect(cli).toMatch(/live\.readSourceRuns\(t\.id as string, a\.perUnit, sc\.units\)/);
    expect(cli).toMatch(/STALE \(kept, no replacement this build\)/);
  });
  it("a unit whose rebuild produced no replacement keeps its previous fixture (reported stale)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-r2s-"));
    const seo = fx(5, { task_id: "upcar-ai.seo.task5", unit: "seo", cohort: "channel" });
    replaceTenantFixtures(T, [fx(1), seo], dir);
    const out = replaceTenantFixtures(T, [fx(2)], dir);
    expect(loadFixtures(dir).map((f) => f.task_id).sort()).toEqual(["upcar-ai.pm.task2", "upcar-ai.seo.task5"]);
    expect(out.keptStale.map((f) => f.task_id)).toEqual(["upcar-ai.seo.task5"]);
  });
});
