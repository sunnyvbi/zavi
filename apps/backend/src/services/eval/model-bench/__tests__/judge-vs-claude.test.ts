import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger, RESERVE_USD } from "../spend";
import { resolveModel, type ManifestEntry } from "../manifest";
import { ensureBenchDir, loadFixtures, loadNoSubstantive, saveNoSubstantive, type TaskFixture } from "../fixtures";
import { aggregateVerdict, judgePair, scoreTrial, type Verdict } from "../scorer";
import { FakeBenchClient, type CompleteRequest } from "../client";
import { buildFixtures, runBench } from "../bench";
import { renderScorecard } from "../scorecard";
import type { TrialResult } from "../runner";
import type { TaskSeed } from "../miner";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const qwen = resolveModel("qwen");
const judges = [resolveModel("gpt-5.5"), resolveModel("gemini-pro")] as const;

const fx = (i: number, over: Partial<TaskFixture> = {}): TaskFixture => ({
  fixture_version: 1,
  task_id: `upcar-ai.pm.task${i}`,
  tenant_id: T,
  company: "upcar-ai",
  agent_slug: "pm",
  unit: "pm",
  cohort: "role",
  source_run_id: `s${i}`,
  input: { trigger: "cron", payload: { idea: "TASK-INPUT write a spec for referral onboarding" }, prompt: { system: "SYS", initial_user: "TASK-INPUT run context" } },
  evidence: [{ tenant_id: T, tool_name: "memory__search", input: { q: "x" }, content: "EVIDENCE-TEXT 412 hosts", is_error: false }],
  filled_by: ["qwen", "claude-shared", "claude-sdk"],
  ...over,
});

const row = (over: Partial<TrialResult> = {}): TrialResult => ({
  task_id: "upcar-ai.pm.task1",
  unit: "pm",
  cohort: "role",
  company: "upcar-ai",
  model_key: "qwen",
  trial: 1,
  outcome: "completed",
  raw: { output_text: "CAND-ANSWER", parse_ok: true, tool_calls: [], route_verdict: "ok" },
  billedUsd: 0,
  attempts: 1,
  ...over,
});
const ref = row({ model_key: "claude-sdk", raw: { output_text: "SDK-ANSWER", parse_ok: true, tool_calls: [], route_verdict: "sdk" } });

const answerA = (u: string) => u.split("## Answer A\n")[1].split("\n\n## Answer B")[0];
const answerB = (u: string) => u.split("## Answer B\n")[1];

const prefer = (winner: string) => (req: CompleteRequest) => {
  const a = answerA(req.user).includes(winner);
  const b = answerB(req.user).includes(winner);
  return JSON.stringify({ better: a === b ? "tie" : a ? "A" : "B", reason: "r" });
};

describe("verdict aggregation (2 judges x 2 orders)", () => {
  const v = (...xs: Verdict[]) => aggregateVerdict(xs);
  it("strict majority wins; ties and splits are same", () => {
    expect(v("better", "better", "better", "better")).toBe("better");
    expect(v("better", "better", "better", "same")).toBe("better");
    expect(v("worse", "worse", "worse", "better")).toBe("worse");
    expect(v("better", "better", "same", "same")).toBe("same");
    expect(v("better", "better", "worse", "worse")).toBe("same");
    expect(v("better", "same", "worse", "same")).toBe("same");
    expect(v("same", "same", "same", "same")).toBe("same");
  });
});

describe("judgePair vs the Claude prod-loop answer", () => {
  it("issues both orders per judge, shows task + evidence + both answers, never a model identity, and reserves every call", async () => {
    const client = new FakeBenchClient(prefer("CAND"), 0.2);
    const ledger = new SpendLedger(100);
    const j = await judgePair({ fixture: fx(1), candidate: row(), reference: ref, judges, client, ledger });
    expect(j).toMatchObject({ verdict: "better", votes: ["better", "better", "better", "better"], judge_calls: 4 });
    expect(client.calls.map((c) => c.model.key)).toEqual(["gpt-5.5", "gpt-5.5", "gemini-pro", "gemini-pro"]);
    const aIsCand = client.calls.map((c) => answerA(c.user).includes("CAND-ANSWER"));
    expect(aIsCand).toEqual([true, false, true, false]);
    for (const c of client.calls) {
      const sent = `${c.system}\n${c.user}`;
      expect(sent).toContain("TASK-INPUT");
      expect(sent).toContain("EVIDENCE-TEXT 412 hosts");
      expect(sent).toContain("CAND-ANSWER");
      expect(sent).toContain("SDK-ANSWER");
      for (const id of ["qwen", qwen.model_id, "claude", "Claude", "anthropic", "sdk", "prod loop"]) {
        expect(sent, id).not.toContain(id);
      }
    }
    expect(ledger.settled).toHaveLength(4);
    expect(ledger.settled.every((s) => s.reserved === RESERVE_USD.judge && s.actual === 0.2)).toBe(true);
    expect(ledger.spentUsd).toBeCloseTo(0.8);
  });

  it("a judge that always says 'A' is order-biased: the votes split and the verdict is same", async () => {
    const client = new FakeBenchClient(() => '{"better":"A","reason":"first is better"}');
    const j = await judgePair({ fixture: fx(1), candidate: row(), reference: ref, judges, client, ledger: new SpendLedger(100) });
    expect(j?.votes).toEqual(["better", "worse", "better", "worse"]);
    expect(j?.verdict).toBe("same");
  });

  it("the reference-preferred answer makes the candidate worse", async () => {
    const j = await judgePair({ fixture: fx(1), candidate: row(), reference: ref, judges, client: new FakeBenchClient(prefer("SDK")), ledger: new SpendLedger(100) });
    expect(j?.verdict).toBe("worse");
  });
});

describe("pass = hard checks pass AND not worse than Claude prod loop", () => {
  const judged = (verdict: Verdict) => ({ task_id: "t", trial: 1, votes: [verdict, verdict, verdict, verdict], verdict, judge_calls: 4 });
  it("same or better passes, worse fails", () => {
    expect(scoreTrial(row(), judged("better"), true)).toMatchObject({ pass: true, verdict: "better" });
    expect(scoreTrial(row(), judged("same"), true)).toMatchObject({ pass: true, verdict: "same" });
    expect(scoreTrial(row(), judged("worse"), true)).toMatchObject({ pass: false, verdict: "worse" });
  });
  it("a hard-check failure fails even a better answer", () => {
    const blocked = row({ raw: { output_text: "x", parse_ok: true, tool_calls: [{ name: "slack__post", code: "shadow_no_side_effect" }], route_verdict: "ok" } });
    expect(scoreTrial(blocked, judged("better"), true).pass).toBe(false);
    const bad = row({ raw: { output_text: "x", parse_ok: false, tool_calls: [], route_verdict: "ok" } });
    expect(scoreTrial(bad, judged("better"), true).pass).toBe(false);
  });
  it("a missing judgement stays unscored (judge_incomplete)", () => {
    expect(scoreTrial(row(), null, true)).toMatchObject({ pass: null, outcome: "judge_incomplete", verdict: null });
  });
});

describe("runBench judges the candidate and the harness row against the claude-sdk answer", () => {
  const answers: Record<string, string> = { qwen: "CAND-ANSWER", "claude-shared": "SHARED-ANSWER", "claude-sdk": "SDK-ANSWER" };
  const runTrialFor = (m: ManifestEntry) => async () => ({
    value: { output_text: answers[m.key], parse_ok: true, tool_calls: [], route_verdict: m.route === "claude_sdk" ? ("sdk" as const) : ("ok" as const) },
    billedUsd: 0.01,
  });
  const deps = (client: FakeBenchClient, fixtures: TaskFixture[] = [fx(1)]) => ({
    fixtures, candidate: qwen, trials: 1, concurrency: 1, sandboxConcurrency: 1, ledger: new SpendLedger(100),
    runTrialFor, beforeModel: () => {}, client, cache: { get: () => null, put: () => {} },
    date: "2026-09-25", harness_sha: "sha", dry_run: true, sleep: async () => {},
  });

  it("every judge call pairs SDK-ANSWER with the other row; the shared answer never meets the candidate", async () => {
    const client = new FakeBenchClient(prefer("SDK"), 0.001);
    const report = await runBench(deps(client));
    expect(client.calls).toHaveLength(8);
    for (const c of client.calls) expect(c.user).toContain("SDK-ANSWER");
    expect(client.calls.filter((c) => c.user.includes("CAND-ANSWER") && c.user.includes("SHARED-ANSWER"))).toHaveLength(0);
    expect(report.candidate[0]).toMatchObject({ verdict: "worse", pass: false });
    expect(report.harness_shared[0]).toMatchObject({ verdict: "worse", pass: false });
    expect(report.reference_sdk[0]).toMatchObject({ verdict: null, pass: true });
  });

  it("the scorecard headline shows better / same / worse vs Claude prod loop and the pass rate", async () => {
    const report = await runBench(deps(new FakeBenchClient(prefer("CAND"), 0.001)));
    const md = report.markdown;
    expect(md).toContain("## Headline vs Claude prod loop");
    expect(md).toContain("| Row | Better | Same | Worse | Pass |");
    expect(md).toMatch(/\| qwen \| 1 \| 0 \| 0 \| 1\/1 \(100\.0%\) \|/);
    expect(md).toMatch(/\| Claude, shared loop \| 0 \| 1 \| 0 \| 1\/1 \(100\.0%\) \|/);
    expect(md).toMatch(/\| Claude, prod loop \(SDK\) \| \(the bar\) \| - \| - \| 1\/1 \(100\.0%\) \|/);
    expect(md).toMatch(/\| qwen vs Claude \(prod loop\) \| \+1\.00 \|/);
    expect(md).toMatch(/\| Harness effect: Claude shared loop vs prod loop \| \+0\.00 \|/);
    expect(md).toMatch(/\| pm \| 1\/0\/0 \| 0\/1\/0 \| 1\/1 \|/);
    expect(md).not.toMatch(/Expected numbers|Assertions satisfied/);
  });

  it("an old fixture that still carries a drafted `expected` key loads and runs, and the key is ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-legacy-"));
    const legacy = {
      ...fx(1),
      expected: { drafted_by: "gpt-5.5", drafter_family: "openai", assertions: [{ id: "a1", text: "must be JSON", cites: 0, expect_number: 999 }], uncited_ids: [] },
    };
    writeFileSync(join(ensureBenchDir(dir), "fixtures", `${T}__upcar-ai.pm.task1.json`), JSON.stringify(legacy));
    const loaded = loadFixtures(dir);
    expect(loaded).toHaveLength(1);
    const report = await runBench(deps(new FakeBenchClient(prefer("CAND"), 0.001), loaded));
    expect(report.candidate[0]).toMatchObject({ pass: true, verdict: "better" });
  });
});

describe("build no longer drafts an answer key", () => {
  it("only fill runs are reserved; no model call is made and the fixture has no expected", async () => {
    const seed: TaskSeed = {
      task_id: "upcar-ai.pm.aaaa", tenant_id: T, company: "upcar-ai", agent_slug: "pm", unit: "pm", cohort: "role", source_run_id: "aaaa",
      input: { trigger: "cron", payload: null, prompt: { system: "s", initial_user: "u" } },
    };
    const ledger = new SpendLedger(100);
    const models = [qwen, resolveModel("claude-shared"), resolveModel("claude-sdk")];
    const out = await buildFixtures({
      seeds: [seed], fillModels: models, ledger, existing: [], resolvePinnedSha: async () => "0".repeat(40),
      fillTrial: async (f, _m, capture) => {
        capture({ tenant_id: f.tenant_id, tool_name: "memory__search", input: { q: "x" }, content: "c", is_error: false });
        return { billedUsd: 0.01 };
      },
    });
    expect(out[0].expected).toBeUndefined();
    expect(ledger.settled.map((s) => s.label)).toEqual(models.map((m) => `fill:${seed.task_id}:${m.key}`));
    const src = readFileSync(join(__dirname, "../bench.ts"), "utf8");
    expect(src).not.toMatch(/drafter|draftWithRetry/);
  });
});

describe("'not covered: no substantive run' is recorded at build and rendered at run", () => {
  it("round-trips through the bench dir, replacing only the scanned scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-cov-"));
    saveNoSubstantive({ companies: ["upcar-ai", "apna-tutor"], units: null }, [{ company: "upcar-ai", unit: "pm" }, { company: "apna-tutor", unit: "seo" }], dir);
    saveNoSubstantive({ companies: ["upcar-ai"], units: new Set(["pm"]) }, [], dir);
    expect(loadNoSubstantive(dir)).toEqual([{ company: "apna-tutor", unit: "seo" }]);
  });

  it("renders distinctly from 'no usable run'", () => {
    const md = renderScorecard({
      date: "d", model_key: "qwen", model_lineage: "x", harness_sha: "s", trials: 1, fixtures: [fx(1)],
      candidate: [], reference_sdk: [], harness_shared: [],
      judges: "judge_unavailable", harness_judges: "judge_unavailable", spent_usd: 0, max_usd: 1, partial: false, dry_run: false,
      no_substantive: [{ company: "upcar-ai", unit: "advisor" }],
    });
    expect(md).toMatch(/\| advisor \| - \| - \| - \| not covered: no substantive run \(upcar-ai\); no usable run \([^)]+\) \|/);
    expect(md).toContain("| cgo | - | - | - | not covered: no usable run |");
    expect(md).toMatch(/upcar-ai \(marketplace\): 1 task\(s\); not covered: no usable run: [^;]*; not covered: no substantive run: advisor/);
  });
});
