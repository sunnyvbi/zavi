#!/usr/bin/env tsx

import { join, resolve } from "node:path";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  HarnessFailure,
  preflightInstrumentSelfTest,
  resolveHarnessSha,
} from "../src/services/eval/shadow-harness";
import { OPENROUTER_BASE_URL } from "../src/services/llm/openrouter";
import {
  CLAUDE_SDK_KEY,
  CLAUDE_SHARED_LOOP_KEY,
  MODEL_MANIFEST,
  probeModelIds,
  pickJudges,
  resolveModel,
  type ManifestEntry,
} from "../src/services/eval/model-bench/manifest";
import {
  DEFAULT_BENCH_DIR,
  writeFixture,
  clearFixtures,
  ensureBenchDir,
  loadFixtures,
  loadNoSubstantive,
  replaceTenantFixtures,
  saveNoSubstantive,
  type NoSubstantiveEntry,
  type TaskFixture,
} from "../src/services/eval/model-bench/fixtures";
import { assertFixturesFilledFor, buildFixtures, runBench, type RowCache } from "../src/services/eval/model-bench/bench";
import { OpenRouterBenchClient } from "../src/services/eval/model-bench/client";
import { measurableUnits, selectTaskSeeds } from "../src/services/eval/model-bench/miner";
import { SpendLedger, reservationFor } from "../src/services/eval/model-bench/spend";
import { fleetBenchTenants, pinnedBenchTenants } from "../src/services/eval/model-bench/tenants";
import {
  prodReferenceFixture,
  prodReferenceRunReserveUsd,
  seedsFromSourceRuns,
} from "../src/services/eval/model-bench/prod-reference";
import { publishScorecard, type BenchScope } from "../src/services/eval/model-bench/scorecard";
import type { TrialResult } from "../src/services/eval/model-bench/runner";

type Args = {
  cmd: string;
  models: string[];
  model?: string;
  trials: number;
  concurrency: number;
  maxUsd: number;
  perUnit: number;
  dryRun: boolean;
  companies: string[];
  units: string[];
  sourceRuns: string[];
  reference?: "prod";
};

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: argv[0] ?? "",
    models: [],
    trials: 3,
    concurrency: 3,
    maxUsd: 300,
    perUnit: 1,
    dryRun: false,
    companies: [],
    units: [],
    sourceRuns: [],
  };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--models") a.models = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--trials") a.trials = Number(argv[++i]);
    else if (v === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (v === "--max-usd") a.maxUsd = Number(argv[++i]);
    else if (v === "--per-unit") a.perUnit = Number(argv[++i]);
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--source-runs") {
      a.sourceRuns = (argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (a.sourceRuns.length === 0) throw new Error("--source-runs needs a non-empty comma-separated value");
    } else if (v === "--reference") {
      const r = argv[++i];
      if (r !== "prod") throw new Error(`--reference must be "prod" (got ${JSON.stringify(r)})`);
      a.reference = "prod";
    }
    else if (v === "--companies" || v === "--units") {
      const list = (argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (list.length === 0) throw new Error(`${v} needs a non-empty comma-separated value`);
      if (v === "--companies") a.companies = list;
      else a.units = list;
    }
    else throw new Error(`unknown argument ${v}`);
  }
  return a;
}

const REPO_ROOT = resolve(process.cwd(), "../..");
const SCORECARD_DIR = join(REPO_ROOT, "evals", "model-bench");

function requireKey(): string {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new HarnessFailure("OPENROUTER_API_KEY is not set");
  return k;
}

async function selfTest(models: ManifestEntry[], ledger: SpendLedger): Promise<void> {
  const meter = (label: string) => {
    const r = ledger.tryReserve(reservationFor("judge"), label);
    if (!r) throw new HarnessFailure(`--max-usd reached during the instrument self-test (${label})`);
    return (billed: number | undefined) => ledger.settle(r, billed);
  };
  for (const m of [...new Map(models.map((x) => [x.key, x])).values()]) {
    if (m.route !== "shared_loop" || !m.upstream) continue;
    for (const modelId of probeModelIds(m)) {
      await preflightInstrumentSelfTest({
        label: `openrouter:${m.upstream}`,
        baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
        apiKey: requireKey(),
        model: modelId,
        extraBody: {
          provider: { order: [m.upstream], allow_fallbacks: false, require_parameters: true },
          usage: { include: true },
        },
        meter,
      });
      console.log(`instrument self-test passed: ${m.key} (${modelId} via ${m.upstream})`);
    }
  }
}

function fileCache(dir: string): RowCache {
  const p = (m: ManifestEntry, f: TaskFixture) =>
    join(dir, "runs", `cache__${m.key}__${f.task_id.replace(/[^A-Za-z0-9_.-]/g, "_")}@v${f.fixture_version}.json`);
  return {
    get: (m, f) => (existsSync(p(m, f)) ? (JSON.parse(readFileSync(p(m, f), "utf8")) as TrialResult[]) : null),
    put: (m, f, rows) => {
      writeFileSync(p(m, f), JSON.stringify(rows), { mode: 0o600 });
      chmodSync(p(m, f), 0o600);
    },
  };
}

export function scopeSuffix(scope: BenchScope | null): string {
  if (!scope) return "";
  const part = (xs: string[] | undefined) => (xs && xs.length ? [...xs].sort().join("+") : "all");
  const full = `.scoped-${part(scope.companies)}-${part(scope.units)}`.replace(/[^A-Za-z0-9._+-]/g, "_");
  if (full.length <= 60) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 12);
  return `${full.slice(0, 40)}~${hash}`;
}

export function resolveScope(a: Pick<Args, "companies" | "units">): {
  tenants: ReturnType<typeof pinnedBenchTenants>;
  units: Set<string> | null;
  scope: BenchScope | null;
} {
  const all = pinnedBenchTenants();
  for (const c of a.companies) {
    if (!all.some((t) => t.company === c)) {
      throw new Error(`unknown --companies value "${c}". Known: ${all.map((t) => t.company).join(", ")}`);
    }
  }
  const known = new Set(measurableUnits().map((u) => u.unit));
  for (const u of a.units) {
    if (!known.has(u)) throw new Error(`unknown or not-measurable --units value "${u}"`);
  }
  const tenants = a.companies.length ? all.filter((t) => a.companies.includes(t.company)) : fleetBenchTenants();
  const units = a.units.length ? new Set(a.units) : null;
  const scope = a.companies.length || a.units.length ? { companies: a.companies, units: a.units } : null;
  return { tenants, units, scope };
}

async function cmdBuildProdReference(a: Args): Promise<void> {
  if (a.sourceRuns.length === 0) throw new Error("--reference prod needs --source-runs <id,...>");
  const live = await import("../src/services/eval/model-bench/live");
  const rows = await live.readSourceRunsByIds(a.sourceRuns);
  const seeds = seedsFromSourceRuns(rows);
  const existing = loadFixtures(DEFAULT_BENCH_DIR);
  const fixtures: TaskFixture[] = [];
  for (const seed of seeds) {
    const row = rows.find((r) => r.id === seed.source_run_id)!;
    const ref = await live.fetchProdReference(row);
    const prev = existing.find((e) => e.task_id === seed.task_id && e.tenant_id === seed.tenant_id);
    fixtures.push(prodReferenceFixture(seed, ref, prev?.fixture_version ?? 0));
    console.log(
      `${seed.task_id}: reference = prod run ${ref.run_id} (Claude ${ref.model_used}, ${ref.date.slice(0, 10)}); ` +
        `start ${ref.start_sha.slice(0, 10)} -> ${ref.source === "shipped_commit" ? "shipped" : "branch"} ${ref.head_sha.slice(0, 10)}; ` +
        `diff ${ref.diff.length} chars; report ${ref.summary.length} chars; typecheck_ok=${ref.typecheck_ok}`,
    );
  }
  const companies = [...new Set(fixtures.map((f) => f.company))];
  const perModel = prodReferenceRunReserveUsd(fixtures.length, a.trials);
  const sr = a.sourceRuns.join(",");
  const cmd = "TS_NODE_PROJECT=tsconfig.build.json node --env-file=.env -r tsconfig-paths/register dist/scripts/model-bench.js";
  console.log(
    `\nNext (live, spends money): for each candidate model\n` +
      `  ${cmd} run --reference prod --source-runs ${sr} --companies ${companies.join(",")} --model <gpt-6-sol|gpt-5.6-luna> ` +
      `--trials ${a.trials} --concurrency 1 --max-usd ${Math.ceil(perModel) + 5}\n` +
      `Worst-case reservation per model: $${perModel.toFixed(2)} (${fixtures.length} task(s) x ${a.trials} trial(s) x ` +
      `($4 engineer trial + 4 x $0.50 judge calls)), +$5 headroom for the self-test probes; e2b sandboxes are not counted.`,
  );
  if (a.dryRun) {
    console.log(`\nDRY RUN: ${fixtures.length} prod-reference fixture(s) resolved, nothing written.`);
    return;
  }
  for (const f of fixtures) writeFixture(f, ensureBenchDir(DEFAULT_BENCH_DIR));
  console.log(`wrote ${fixtures.length} prod-reference fixture(s) to ${join(DEFAULT_BENCH_DIR, "fixtures")} (owner-only). spent $0.00`);
}

async function cmdBuild(a: Args): Promise<void> {
  if (a.reference === "prod") return cmdBuildProdReference(a);
  const sc = resolveScope(a);
  const models = [
    ...new Set([...a.models, CLAUDE_SHARED_LOOP_KEY, CLAUDE_SDK_KEY]),
  ].map(resolveModel);
  const ledger = new SpendLedger(a.maxUsd);
  requireKey();
  await selfTest(models, ledger);
  const live = await import("../src/services/eval/model-bench/live");
  const seeds = [];
  const noSubstantive: NoSubstantiveEntry[] = [];
  if (a.sourceRuns.length > 0) {
    seeds.push(...seedsFromSourceRuns(await live.readSourceRunsByIds(a.sourceRuns)));
  }
  for (const t of a.sourceRuns.length > 0 ? [] : sc.tenants) {
    const src = await live.readSourceRuns(t.id as string, a.perUnit, sc.units);
    const mined = selectTaskSeeds(src.rows, a.perUnit);
    seeds.push(...(sc.units ? mined.filter((s) => sc.units!.has(s.unit)) : mined));
    for (const unit of src.noSubstantive) {
      noSubstantive.push({ company: t.company, unit });
      console.log(`not covered: no substantive run: ${t.company}/${unit} (every recent run was a trivial request)`);
    }
  }
  console.log(`mined ${seeds.length} task(s) from ${sc.tenants.map((t) => t.company).join(", ")}${sc.units ? ` (units: ${[...sc.units].join(", ")})` : ""}`);
  const dir = ensureBenchDir(DEFAULT_BENCH_DIR);
  const fixtures = await buildFixtures({
    seeds,
    fillModels: models,
    fillTrial: async (f, m, capture) => {
      live.selectSharedLoopModel(m);
      const r = await live.liveTrial({ fixture: f, model: m, mode: "build", capture });
      if (r.value.route_verdict === "unpinned_route" || r.value.route_verdict === "no_usage_cost") {
        throw new HarnessFailure(`fill run for ${m.key}: ${r.value.route_verdict}; no fixtures written`);
      }
      return { billedUsd: r.billedUsd };
    },
    resolvePinnedSha: (s) => live.resolveHeadSha(s.tenant_id, s.input.payload),
    existing: loadFixtures(dir),
    ledger,
  });
  if (a.sourceRuns.length > 0) {
    for (const f of fixtures) writeFixture(f, dir);
    console.log(`wrote ${fixtures.length} fixture(s) from --source-runs. spent $${ledger.spentUsd.toFixed(2)}`);
    return;
  }
  for (const t of sc.tenants) {
    const { keptStale, droppedStale } = replaceTenantFixtures(
      t.id as string,
      fixtures.filter((f) => f.tenant_id === t.id),
      dir,
      models.map((m) => m.key),
      sc.units,
      new Set(noSubstantive.filter((n) => n.company === t.company).map((n) => n.unit)),
    );
    for (const s of keptStale) {
      console.log(`STALE (kept, no replacement this build): ${s.task_id} v${s.fixture_version} filled_by=${s.filled_by.join(",")}`);
    }
    for (const s of droppedStale) {
      console.log(
        `DROPPED ${s.task_id}: no replacement this build and not filled by ${models.map((m) => m.key).join(",")} ` +
          `(filled_by=${s.filled_by.join(",")}); unit will show "not covered: no usable run"`,
      );
    }
  }
  saveNoSubstantive({ companies: sc.tenants.map((t) => t.company), units: sc.units }, noSubstantive, dir);
  console.log(`wrote ${fixtures.length} fixture(s) to ${join(dir, "fixtures")} (owner-only). spent $${ledger.spentUsd.toFixed(2)}`);
}

async function cmdRun(a: Args): Promise<void> {
  if (!a.model) throw new Error("--model <key> is required");
  const candidate = resolveModel(a.model);
  const date = new Date().toISOString().slice(0, 10);

  if (a.dryRun) {
    const { dryRunBench, dryRunProdReference } = await import("../src/services/eval/model-bench/dry-run");
    const { fixtures, report } =
      a.reference === "prod" ? await dryRunProdReference(candidate.key, a.trials) : await dryRunBench(candidate.key, a.trials);
    const out = join(mkdtempSync(join(tmpdir(), "model-bench-dry-")), `${date}-${candidate.key}.md`);
    publishScorecard(out, report.markdown, fixtures);
    console.log(report.markdown);
    console.log(`\nDRY RUN scorecard (not committed): ${out}`);
    return;
  }

  const dir = ensureBenchDir(DEFAULT_BENCH_DIR);
  const sc = resolveScope(a);
  const prodRef = a.reference === "prod";
  const fixtures = loadFixtures(dir).filter(
    (f) =>
      (prodRef && a.sourceRuns.length > 0 && a.companies.length === 0 ? pinnedBenchTenants() : sc.tenants).some((t) => t.id === f.tenant_id) &&
      (!sc.units || sc.units.has(f.unit)) &&
      !!f.prod_reference === prodRef &&
      (a.sourceRuns.length === 0 || a.sourceRuns.includes(f.source_run_id)),
  );
  if (fixtures.length === 0) throw new Error("no fixtures in scope; run `model-bench build` first (with the same --companies/--units/--source-runs/--reference)");
  if (prodRef && a.sourceRuns.length > 0 && fixtures.length !== a.sourceRuns.length) {
    throw new Error(`--source-runs names ${a.sourceRuns.length} run(s) but only ${fixtures.length} prod-reference fixture(s) exist; rebuild`);
  }
  if (!prodRef) assertFixturesFilledFor(fixtures, candidate);
  const judges = pickJudges([candidate.family, "anthropic"]);
  const harnessJudges = pickJudges(["anthropic"]);
  const ledger = new SpendLedger(a.maxUsd);
  const client = new OpenRouterBenchClient(requireKey());
  await selfTest(
    prodRef
      ? [candidate, ...(judges.status === "ok" ? judges.judges : [])]
      : [
          candidate,
          resolveModel(CLAUDE_SHARED_LOOP_KEY),
          ...(judges.status === "ok" ? judges.judges : []),
          ...(harnessJudges.status === "ok" ? harnessJudges.judges : []),
        ],
    ledger,
  );
  const live = await import("../src/services/eval/model-bench/live");
  const report = await runBench({
    resolveAgentModel: async (f) => {
      const { loadAgentDefinition } = await import("../src/services/agents/registry");
      const def = await loadAgentDefinition(f.agent_slug, f.tenant_id);
      const m = def?.metadata_praxis.model;
      if (!m) throw new HarnessFailure(`cannot resolve the model of ${f.agent_slug} for ${f.tenant_id}`);
      return m;
    },
    fixtures,
    candidate,
    trials: a.trials,
    concurrency: a.concurrency,
    sandboxConcurrency: 2,
    ledger,
    beforeModel: (m) => live.selectSharedLoopModel(m),
    runTrialFor: (m) => (req) => live.liveTrial({ fixture: req.fixture, model: m, mode: "score" }),
    client,
    cache: fileCache(dir),
    date,
    harness_sha: resolveHarnessSha(),
    dry_run: false,
    scope: prodRef ? { companies: [...new Set(fixtures.map((f) => f.company))], units: ["engineer"] } : sc.scope,
    no_substantive: loadNoSubstantive(dir),
    ...(prodRef ? { reference: "prod" as const } : {}),
  });
  const suffix = prodRef ? `.prod-reference-${fixtures.map((f) => f.source_run_id.slice(0, 8)).sort().join("+")}` : scopeSuffix(sc.scope);
  const detail = join(dir, "runs", `${date}-${candidate.key}${suffix}.json`);
  writeFileSync(detail, JSON.stringify(report.raw, null, 2), { mode: 0o600 });
  chmodSync(detail, 0o600);
  const card = publishScorecard(join(SCORECARD_DIR, `${date}-${candidate.key}${suffix}.md`), report.markdown, fixtures);
  console.log(`scorecard: ${card}${report.partial ? " (PARTIAL: cap reached)" : ""}\nrun detail (gitignored): ${detail}`);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const scoped = resolveScope(a).scope;
  if (a.dryRun && scoped) console.log("note: --dry-run uses synthetic fixtures; --companies/--units are validated but not applied");
  if (a.cmd === "clear-fixtures") {
    clearFixtures(DEFAULT_BENCH_DIR);
    console.log(`deleted ${DEFAULT_BENCH_DIR}`);
    return;
  }
  if (a.cmd === "build") {
    if (a.dryRun && a.reference === "prod") return cmdBuildProdReference(a);
    if (a.dryRun) {
      const { dryRunBench } = await import("../src/services/eval/model-bench/dry-run");
      const { fixtures } = await dryRunBench(a.models[0] ?? "qwen", a.trials);
      console.log(`DRY RUN build: ${fixtures.length} synthetic fixture(s), nothing written.`);
      return;
    }
    return cmdBuild(a);
  }
  if (a.cmd === "run") return cmdRun(a);
  console.error(
    "usage: model-bench build --models <k1,k2> [--per-unit 1] [--max-usd 300] [--dry-run]\n" +
      "       model-bench build --source-runs <id,...> --reference prod [--dry-run]   (no model runs)\n" +
      "       model-bench run --reference prod --source-runs <id,...> --companies <c> --model <key> [--trials 3]\n" +
      "       model-bench run --model <key> [--trials 3] [--concurrency 3] [--max-usd 300] [--dry-run]\n" +
      "       model-bench clear-fixtures\n" +
      `models: ${[...MODEL_MANIFEST.keys()].join(", ")}`,
  );
  process.exit(1);
}

if (process.argv[1] && /model-bench\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    if (e instanceof HarnessFailure) {
      console.error(`\nHARNESS FAILURE: ${e.message}\nNothing was published.`);
    } else {
      console.error(e);
    }
    process.exit(1);
  });
}
