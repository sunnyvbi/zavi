import { describe, expect, it } from "vitest";
import { HarnessFailure } from "@/services/eval/shadow-harness";
import { runBench, type RowCache } from "../bench";
import { FakeBenchClient, type CompleteRequest } from "../client";
import type { ProdReference, TaskFixture } from "../fixtures";
import { resolveModel, type ManifestEntry } from "../manifest";
import {
  assertSourceRuns,
  diffFromGithubFiles,
  prodReferenceFixture,
  referenceLocator,
  seedsFromSourceRuns,
  type SourceRunFullRow,
} from "../prod-reference";
import type { RunTrialFn } from "../runner";
import { hardChecks } from "../scorer";
import { SpendLedger } from "../spend";
import { BENCH_TENANTS, fleetBenchTenants } from "../tenants";

const MOHIT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const SNAP = "--- system ---\nengineer system\n\n--- initial user ---\nRun context";

function row(over: Partial<SourceRunFullRow> = {}): SourceRunFullRow {
  return {
    id: "e35a1170-f639-4e59-a8f7-6089e6e2a64c",
    tenant_id: MOHIT,
    agent_slug: "engineer",
    trigger: "a2a",
    status: "success",
    payload: { stage: "scaffold", idea: "house rental landing with a countdown to October 1" },
    prompt_snapshot: SNAP,
    enqueued_at: "2026-09-25T13:27:52Z",
    model_used: "claude-opus-4-7",
    output_text: "## Plan\nREF-REPORT-SENTINEL pivoted the seed to Roost",
    parsed: { repo: "Praxis-build/mohit-93bd8436", postdeploy_verify: { commit_sha: "c".repeat(40) } },
    ...over,
  };
}

const REF: ProdReference = {
  run_id: "e35a1170-f639-4e59-a8f7-6089e6e2a64c",
  model_used: "claude-opus-4-7",
  date: "2026-09-25T13:27:52Z",
  repo: "Praxis-build/mohit-93bd8436",
  start_sha: "a".repeat(40),
  head_sha: "c".repeat(40),
  source: "shipped_commit",
  summary: "## Plan\nREF-REPORT-SENTINEL pivoted the seed to Roost",
  diff: "diff --git a/lib/brand.ts b/lib/brand.ts\n+REF-DIFF-SENTINEL launchAtIso",
  typecheck_ok: true,
  tests_failed: 0,
};

function fixture(): TaskFixture {
  return prodReferenceFixture(seedsFromSourceRuns([row()])[0], REF);
}

describe("--source-runs refusals", () => {
  it("accepts a successful engineer run from an allowlisted tenant", () => {
    expect(() => assertSourceRuns([row().id], [row()])).not.toThrow();
  });
  it("refuses a row from a non-bench tenant", () => {
    const stray = row({ tenant_id: "11111111-2222-3333-4444-555555555555" });
    expect(() => assertSourceRuns([stray.id], [stray])).toThrow(/not on the model-bench allowlist/);
  });
  it("refuses an id not found in any bench tenant", () => {
    expect(() => assertSourceRuns(["e35a1170-f639-4e59-a8f7-6089e6e2a64d"], [row()])).toThrow(/not found in any bench tenant/);
  });
  it("refuses a non-engineer row and a non-success row", () => {
    expect(() => assertSourceRuns([row().id], [row({ agent_slug: "pm" })])).toThrow(/not engineer/);
    expect(() => assertSourceRuns([row().id], [row({ status: "failed" })])).toThrow(/not success/);
  });
  it("refuses a row without a parseable prompt snapshot", () => {
    expect(() => assertSourceRuns([row().id], [row({ prompt_snapshot: null })])).toThrow(HarnessFailure);
  });
  it("a snapshot purged by retention says so, with the window", () => {
    expect(() => assertSourceRuns([row().id], [row({ prompt_snapshot: null })])).toThrow(/purged after 14 days/);
    expect(() => assertSourceRuns([row().id], [row({ prompt_snapshot: "not json" })])).toThrow(/no parseable prompt snapshot/);
  });
  it("the mohit test tenant is allowlisted but never part of a fleet run", () => {
    expect(BENCH_TENANTS.some((t) => t.id === MOHIT)).toBe(true);
    expect(fleetBenchTenants().some((t) => t.id === MOHIT)).toBe(false);
  });
});

describe("reference locator", () => {
  it("a direct-pushed build step uses the shipped commit", () => {
    expect(referenceLocator(row().parsed)).toMatchObject({ kind: "shipped_commit", head_sha: "c".repeat(40) });
  });
  it("otherwise falls back to the pushed branch vs its base, and refuses when neither exists", () => {
    expect(referenceLocator({ repo: "o/r", head_branch: "engineer/x", base_branch: "main" })).toMatchObject({ kind: "branch" });
    expect(() => referenceLocator({ repo: "o/r" })).toThrow(/neither a shipped commit/);
  });
  it("drops lockfile patches from the reference diff", () => {
    const d = diffFromGithubFiles([
      { filename: "package-lock.json", status: "modified", additions: 900, deletions: 3, patch: "LOCK-NOISE" },
      { filename: "app/page.tsx", status: "modified", additions: 1, deletions: 0, patch: "+ok" },
    ]);
    expect(d).not.toContain("LOCK-NOISE");
    expect(d).toContain("+ok");
  });
});

function memCache(): RowCache {
  const m = new Map<string, ReturnType<RowCache["get"]>>();
  return { get: (mo, f) => m.get(`${mo.key}|${f.task_id}`) ?? null, put: (mo, f, r) => void m.set(`${mo.key}|${f.task_id}`, r) };
}

async function run(candidateKey: string) {
  const f = fixture();
  const scheduled: string[] = [];
  const prompts: string[] = [];
  const runTrialFor = (m: ManifestEntry): RunTrialFn => async () => {
    scheduled.push(m.key);
    return {
      value: {
        output_text: "CAND-REPORT-SENTINEL built Roost",
        parse_ok: true,
        tool_calls: [{ name: "sandbox__run_bash", status: "ok" }],
        route_verdict: "ok",
        code_diff: "diff --git a/app/page.tsx b/app/page.tsx\n+CAND-DIFF-SENTINEL",
        engineer_checks: { typecheck_ok: true, typecheck_verified: true, tests_failed: 0 },
      },
      billedUsd: 0.01,
    };
  };
  const client = new FakeBenchClient((req: CompleteRequest) => {
    prompts.push(req.user);
    return JSON.stringify({ better: "tie", reason: "same" });
  }, 0.001);
  const report = await runBench({
    fixtures: [f],
    candidate: resolveModel(candidateKey),
    trials: 2,
    concurrency: 1,
    sandboxConcurrency: 1,
    ledger: new SpendLedger(100),
    runTrialFor,
    beforeModel: () => {},
    client,
    cache: memCache(),
    date: "2026-09-26",
    harness_sha: "test",
    dry_run: false,
    sleep: async () => {},
    reference: "prod",
  });
  return { report, scheduled, prompts };
}

describe("prod-reference run", () => {
  it("never schedules a Claude trial: only the candidate runs", async () => {
    const { scheduled, report } = await run("gpt-5.6-luna");
    expect(scheduled).toEqual(["gpt-5.6-luna", "gpt-5.6-luna"]);
    expect(Object.keys(report.raw)).not.toContain("claude-sdk");
    expect(Object.keys(report.raw)).not.toContain("claude-shared");
    expect(report.harness_shared).toEqual([]);
  });

  it("refuses a Claude candidate", async () => {
    await expect(run("claude-shared")).rejects.toThrow(/never runs Claude/);
  });

  it("the prod report AND diff reach the judge, next to the candidate's", async () => {
    const { prompts, report } = await run("gpt-6-sol");
    expect(prompts.length).toBe(2 * 4);
    for (const p of prompts) {
      expect(p).toContain("REF-REPORT-SENTINEL");
      expect(p).toContain("REF-DIFF-SENTINEL");
      expect(p).toContain("CAND-REPORT-SENTINEL");
      expect(p).toContain("CAND-DIFF-SENTINEL");
      expect(p).toContain("house rental landing");
      expect(p).not.toMatch(/claude|gpt|opus/i);
    }
    expect(report.candidate.every((s) => s.pass === true && s.verdict === "same")).toBe(true);
  });

  it("the scorecard labels the prod run as the reference, not re-run", async () => {
    const { report } = await run("gpt-6-sol");
    expect(report.markdown).toContain(
      `reference = prod run ${REF.run_id} (Claude claude-opus-4-7, 2026-09-25), not re-run`,
    );
    expect(report.markdown).not.toContain("Claude, shared loop |");
    expect(report.markdown).toContain("n/a (prod-reference mode, Claude not re-run)");
  });

  it("a normal run refuses a prod-reference fixture", async () => {
    await expect(
      runBench({
        fixtures: [fixture()],
        candidate: resolveModel("gpt-6-sol"),
        trials: 1,
        concurrency: 1,
        sandboxConcurrency: 1,
        ledger: new SpendLedger(10),
        runTrialFor: () => async () => {
          throw new Error("must not run");
        },
        beforeModel: () => {},
        client: new FakeBenchClient(() => "{}", 0),
        cache: memCache(),
        date: "2026-09-26",
        harness_sha: "t",
        dry_run: false,
      }),
    ).rejects.toThrow(/--reference prod/);
  });
});

describe("build-step hard checks", () => {
  const base = {
    task_id: "t", unit: "engineer", cohort: "role" as const, company: "c", model_key: "m", trial: 1,
    outcome: "completed" as const, billedUsd: 0, attempts: 1,
  };
  const raw = (over: object) => ({
    output_text: "x", parse_ok: true, tool_calls: [], route_verdict: "ok" as const,
    code_diff: "+a", engineer_checks: { typecheck_ok: true, typecheck_verified: true, tests_failed: 0 }, ...over,
  });
  it("fails on a verified typecheck failure, failing tests, or no code change", () => {
    expect(hardChecks({ ...base, raw: raw({}) }).pass).toBe(true);
    expect(hardChecks({ ...base, raw: raw({ engineer_checks: { typecheck_ok: true, typecheck_verified: false, tests_failed: 0 } }) }).pass).toBe(false);
    expect(hardChecks({ ...base, raw: raw({ engineer_checks: { typecheck_ok: null, typecheck_verified: null, tests_failed: 2 } }) }).pass).toBe(false);
    expect(hardChecks({ ...base, raw: raw({ code_diff: "" }) }).pass).toBe(false);
  });
});

describe("typecheck re-run marker", () => {
  it("a failing tsc is false, not 'not checked'; install failure and timeouts are unverified", async () => {
    const { typecheckFromMarker } = await import("../live");
    expect(typecheckFromMarker("PRAXIS_TSC=2\n")).toBe(false);
    expect(typecheckFromMarker("PRAXIS_TSC=0\n")).toBe(true);
    for (const s of ["PRAXIS_TSC=skip", "PRAXIS_TSC=install_failed", "PRAXIS_TSC=124", "PRAXIS_TSC=127", ""]) {
      expect(typecheckFromMarker(s), s).toBeNull();
    }
  });
});

describe("sandbox change capture", () => {
  const SHA = "c155e99000c35d8d30cf64400ee519c8095d18d3";
  it("never names gitignored dirs to git add (that exits 1), and a failure carries git's own stderr", async () => {
    const { captureSandboxChange } = await import("../live");
    const cmds: string[] = [];
    const exec = async (_id: string, cmd: string) => {
      cmds.push(cmd);
      return { exit_code: 3, stdout: "", stderr: "fatal: something real\ncapture: git add failed" };
    };
    await expect(captureSandboxChange(exec, "sbx", SHA)).rejects.toThrow(/exit 3\).*fatal: something real/s);
    const add = cmds[0].split(";").find((p) => p.includes("git add"))!;
    expect(add).not.toMatch(/exclude|node_modules|\.next|2>&1/);
  });

  it("an empty diff is a captured no-change, not a failure", async () => {
    const { captureSandboxChange } = await import("../live");
    const exec = async (_id: string, cmd: string) =>
      cmd.includes("git diff") ? { exit_code: 0, stdout: "\n", stderr: "" } : { exit_code: 0, stdout: "PRAXIS_TSC=0\n", stderr: "" };
    await expect(captureSandboxChange(exec, "sbx", SHA)).resolves.toEqual({ code_diff: "", typecheck_verified: true });
  });

  it("summarizes tool calls by name and code only", async () => {
    const { summarizeToolCalls } = await import("../live");
    expect(
      summarizeToolCalls([
        { name: "sandbox__view", status: "ok" },
        { name: "sandbox__view", status: "ok" },
        { name: "sandbox__run_bash", status: "tool_error", code: "tool_input_invalid" },
      ] as never),
    ).toBe("3 tool call(s): sandbox__view x2, sandbox__run_bash (tool_input_invalid) x1");
  });
});
