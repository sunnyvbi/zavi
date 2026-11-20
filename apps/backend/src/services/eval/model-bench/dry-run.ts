
import type { BenchModelClient, CompleteRequest } from "./client";
import { FakeBenchClient } from "./client";
import { buildFixtures, runBench, type BenchReport, type RowCache } from "./bench";
import type { EvidenceRecord, TaskFixture } from "./fixtures";
import { CLAUDE_SDK_KEY, CLAUDE_SHARED_LOOP_KEY, resolveModel, type ManifestEntry } from "./manifest";
import type { TaskSeed } from "./miner";
import type { RunTrialFn } from "./runner";
import { SpendLedger } from "./spend";
import { fleetBenchTenants, pinnedBenchTenants } from "./tenants";
import { prodReferenceFixture } from "./prod-reference";

const DRY_SHA = "0".repeat(40);

function syntheticSeeds(): TaskSeed[] {
  const seeds: TaskSeed[] = [];
  for (const t of fleetBenchTenants()) {
    for (const [unit, cohort, slug] of [
      ["pm", "role", "pm"],
      ["engineer", "role", "engineer"],
      ["seo_organic", "channel", "operator"],
    ] as const) {
      seeds.push({
        task_id: `${t.company}.${unit}.dryrun00`,
        tenant_id: t.id as string,
        company: t.company,
        agent_slug: slug,
        unit,
        cohort,
        source_run_id: `dry-${t.company}-${unit}`,
        input: {
          trigger: cohort === "channel" ? "channel_recipe" : "cron",
          payload: cohort === "channel" ? { channel_slug: unit } : null,
          prompt: { system: `dry-run system for ${unit}`, initial_user: `dry-run ask for ${unit}` },
        },
      });
    }
  }
  return seeds;
}

function fakeClient(): BenchModelClient {
  return new FakeBenchClient((req: CompleteRequest) => {
    const a = (req.user.split("## Answer A")[1]?.split("## Answer B")[0] ?? "").includes("42");
    const b = (req.user.split("## Answer B")[1] ?? "").includes("42");
    const better = a === b ? "tie" : a ? "A" : "B";
    return JSON.stringify({ better, reason: "dry run" });
  }, 0.001);
}

function fakeRunTrial(model: ManifestEntry): RunTrialFn {
  return async ({ fixture, trial }) => {
    const miss = model.key !== CLAUDE_SHARED_LOOP_KEY && model.key !== CLAUDE_SDK_KEY && (fixture.unit.length + trial) % 3 === 0;
    return {
      value: {
        output_text: miss ? "I could not find the metric." : "The metric is 42.",
        parse_ok: true,
        tool_calls: [{ name: "memory__search", code: "replayed", status: "ok" }],
        route_verdict: model.route === "claude_sdk" ? "sdk" : "ok",
      },
      billedUsd: 0.002,
    };
  };
}

function memoryCache(): RowCache {
  const m = new Map<string, ReturnType<RowCache["get"]>>();
  const k = (model: ManifestEntry, f: TaskFixture) => `${model.key}|${f.task_id}@${f.fixture_version}`;
  return {
    get: (model, f) => m.get(k(model, f)) ?? null,
    put: (model, f, rows) => void m.set(k(model, f), rows),
  };
}

export async function dryRunProdReference(candidateKey: string, trials = 3): Promise<{ fixtures: TaskFixture[]; report: BenchReport }> {
  const candidate = resolveModel(candidateKey);
  const tenant = pinnedBenchTenants().find((t) => t.fleet === false) ?? pinnedBenchTenants()[0];
  const fixtures = (["scaffold", "build"] as const).map((stage, i) =>
    prodReferenceFixture(
      {
        task_id: `${tenant.company}.engineer-${stage}.dryrun0${i}`,
        tenant_id: tenant.id as string,
        company: tenant.company,
        agent_slug: "engineer",
        unit: "engineer",
        cohort: "role",
        source_run_id: `dry-${stage}`,
        input: {
          trigger: "a2a",
          payload: { stage, idea: "a landing page with a countdown" },
          prompt: { system: `dry-run system for ${stage}`, initial_user: `dry-run ${stage} ask` },
        },
      },
      {
        run_id: `dry-${stage}`,
        model_used: "claude-opus-4-7",
        date: "2026-09-25T00:00:00Z",
        repo: "owner/dry-run",
        start_sha: "1".repeat(40),
        head_sha: "2".repeat(40),
        source: "shipped_commit",
        summary: "Built the countdown. The metric is 42.",
        diff: "diff --git a/app/page.tsx b/app/page.tsx\n+export const launch = 42;",
        typecheck_ok: true,
        tests_failed: 0,
      },
    ),
  );
  const report = await runBench({
    fixtures,
    candidate,
    trials,
    concurrency: 1,
    sandboxConcurrency: 1,
    ledger: new SpendLedger(300),
    runTrialFor: (model) => async ({ fixture, trial }) => ({
      value: {
        output_text: (fixture.unit.length + trial) % 3 === 0 ? "Could not finish." : "Built it. The metric is 42.",
        parse_ok: true,
        tool_calls: [{ name: "sandbox__run_bash", status: "ok" }],
        route_verdict: model.route === "claude_sdk" ? "sdk" : "ok",
        code_diff: "diff --git a/app/page.tsx b/app/page.tsx\n+export const launch = 42;",
        engineer_checks: { typecheck_ok: true, typecheck_verified: true, tests_failed: 0 },
      },
      billedUsd: 0.002,
    }),
    beforeModel: () => {},
    client: fakeClient(),
    cache: memoryCache(),
    date: new Date().toISOString().slice(0, 10),
    harness_sha: "dry-run",
    dry_run: true,
    sleep: async () => {},
    scope: { companies: [tenant.company], units: ["engineer"] },
    reference: "prod",
  });
  return { fixtures, report };
}

export async function dryRunBench(candidateKey: string, trials = 3): Promise<{ fixtures: TaskFixture[]; report: BenchReport }> {
  const candidate = resolveModel(candidateKey);
  const ledger = new SpendLedger(300);
  const client = fakeClient();
  const fillModels = [candidate, resolveModel(CLAUDE_SHARED_LOOP_KEY), resolveModel(CLAUDE_SDK_KEY)];
  const fixtures = await buildFixtures({
    seeds: syntheticSeeds(),
    fillModels,
    fillTrial: async (f, m, capture) => {
      const rec: EvidenceRecord = {
        tenant_id: f.tenant_id,
        tool_name: "memory__search",
        input: { q: f.unit },
        content: `dry-run evidence for ${f.unit}: metric=42 (filled by ${m.key})`,
        is_error: false,
      };
      capture(rec);
      return { billedUsd: 0.002 };
    },
    resolvePinnedSha: async () => DRY_SHA,
    existing: [],
    ledger,
  });
  const report = await runBench({
    fixtures,
    candidate,
    trials,
    concurrency: 3,
    sandboxConcurrency: 2,
    ledger,
    runTrialFor: fakeRunTrial,
    beforeModel: () => {},
    client,
    cache: memoryCache(),
    date: new Date().toISOString().slice(0, 10),
    harness_sha: "dry-run",
    dry_run: true,
    sleep: async () => {},
  });
  return { fixtures, report };
}
