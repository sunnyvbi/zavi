
import { HarnessFailure } from "@/services/eval/shadow-harness";
import type { BenchModelClient } from "./client";
import { mergeFillCaptures, type EvidenceRecord, type NoSubstantiveEntry, type TaskFixture } from "./fixtures";
import {
  CLAUDE_SDK_KEY,
  CLAUDE_SHARED_LOOP_KEY,
  pickJudges,
  resolveModel,
  type JudgePick,
  type ManifestEntry,
  AGENT_DECLARED,
} from "./manifest";
import type { BenchScope } from "./scorecard";
import type { TaskSeed } from "./miner";
import { runTrials, type RunTrialFn, type TrialResult } from "./runner";
import { isExcludedOutcome, judgePair, scoreTrial, type PairJudgement, type ScoredTrial } from "./scorer";
import { computeSearchRecall, renderScorecard } from "./scorecard";
import { reservationFor, withBenchRetries, type SpendLedger } from "./spend";
import { PROD_REFERENCE_KEY, assertProdReferenceFixtures, prodReferenceRow } from "./prod-reference";

export type BuildDeps = {
  seeds: ReadonlyArray<TaskSeed>;
  fillModels: ReadonlyArray<ManifestEntry>;
  fillTrial: (
    f: TaskFixture,
    model: ManifestEntry,
    capture: (r: EvidenceRecord) => void,
  ) => Promise<{ billedUsd: number | undefined }>;
  resolvePinnedSha: (seed: TaskSeed) => Promise<string>;
  existing: ReadonlyArray<TaskFixture>;
  ledger: SpendLedger;
};

export async function buildFixtures(d: BuildDeps): Promise<TaskFixture[]> {
  if (d.fillModels.length === 0) throw new HarnessFailure("build: no fill models");
  const out: TaskFixture[] = [];
  for (const seed of d.seeds) {
    const prev = d.existing.find((e) => e.task_id === seed.task_id && e.tenant_id === seed.tenant_id);
    const base: TaskFixture = {
      fixture_version: (prev?.fixture_version ?? 0) + 1,
      task_id: seed.task_id,
      tenant_id: seed.tenant_id,
      company: seed.company,
      agent_slug: seed.agent_slug,
      unit: seed.unit,
      cohort: seed.cohort,
      source_run_id: seed.source_run_id,
      input: seed.input,
      evidence: [],
      filled_by: d.fillModels.map((m) => m.key),
      ...(seed.agent_slug === "engineer"
        ? { pinned_sha: prev?.pinned_sha ?? (await d.resolvePinnedSha(seed)) }
        : {}),
    };
    const perModel: EvidenceRecord[][] = [];
    for (const m of d.fillModels) {
      const res = d.ledger.tryReserve(reservationFor("run", seed.agent_slug, seed.cohort), `fill:${seed.task_id}:${m.key}`);
      if (!res) throw new HarnessFailure("build: --max-usd reached during the fill pass; no fixtures written");
      const recs: EvidenceRecord[] = [];
      let billed: number | undefined;
      try {
        const r = await d.fillTrial(base, m, (x) => recs.push(x));
        billed = r.billedUsd;
      } finally {
        d.ledger.settle(res, billed);
      }
      perModel.push(recs);
    }
    out.push({ ...base, evidence: mergeFillCaptures(seed.tenant_id, perModel) });
  }
  return out;
}

export type RowCache = {
  get(model: ManifestEntry, f: TaskFixture): TrialResult[] | null;
  put(model: ManifestEntry, f: TaskFixture, rows: TrialResult[]): void;
};

export type RunDeps = {
  fixtures: ReadonlyArray<TaskFixture>;
  candidate: ManifestEntry;
  trials: number;
  concurrency: number;
  sandboxConcurrency: number;
  ledger: SpendLedger;
  runTrialFor: (model: ManifestEntry) => RunTrialFn;
  beforeModel: (model: ManifestEntry) => void;
  resolveAgentModel?: (f: TaskFixture) => Promise<string>;
  scope?: BenchScope | null;
  no_substantive?: ReadonlyArray<NoSubstantiveEntry>;
  client: BenchModelClient;
  cache: RowCache;
  date: string;
  harness_sha: string;
  dry_run: boolean;
  sleep?: (ms: number) => Promise<void>;
  reference?: "prod";
};

export type BenchReport = {
  markdown: string;
  partial: boolean;
  candidate: ScoredTrial[];
  reference_sdk: ScoredTrial[];
  harness_shared: ScoredTrial[];
  raw: Record<string, TrialResult[]>;
};

export function isReusableCache(
  rows: ReadonlyArray<TrialResult> | null,
  want: {
    trials: number;
    harness_sha: string;
    model: ManifestEntry;
    fixture: TaskFixture;
    concrete_model_id?: string | null;
  },
): boolean {
  if (!rows || rows.length !== want.trials) return false;
  const wantModel = want.concrete_model_id === undefined ? want.model.model_id : want.concrete_model_id;
  if (wantModel === null || wantModel === AGENT_DECLARED) return false;
  if (rows.some((r) => r.outcome === "capped")) return false;
  const idx = [...rows].map((r) => r.trial).sort((a, b) => a - b);
  for (let i = 0; i < want.trials; i++) if (idx[i] !== i + 1) return false;
  return rows.every(
    (r) =>
      r.task_id === want.fixture.task_id &&
      r.harness_sha === want.harness_sha &&
      r.model_id === wantModel &&
      (r.upstream ?? null) === (want.model.upstream ?? null) &&
      r.fixture_version === want.fixture.fixture_version,
  );
}

export function assertFixturesFilledFor(
  fixtures: ReadonlyArray<TaskFixture>,
  candidate: ManifestEntry,
): void {
  const need = [candidate.key, CLAUDE_SHARED_LOOP_KEY, CLAUDE_SDK_KEY];
  const stale = fixtures.filter((f) => need.some((k) => !f.filled_by.includes(k)));
  if (stale.length > 0) {
    throw new HarnessFailure(
      `${stale.length} fixture(s) were not filled by ${need.join(" + ")} ` +
        `(e.g. ${stale[0].task_id} filled_by=${stale[0].filled_by.join(",")}). ` +
        `Rebuild: model-bench build --models ${candidate.key}`,
    );
  }
}

async function concreteModelId(d: RunDeps, model: ManifestEntry, f: TaskFixture): Promise<string | null> {
  if (model.model_id !== AGENT_DECLARED) return model.model_id;
  if (!d.resolveAgentModel) return null;
  try {
    return (await d.resolveAgentModel(f)) || null;
  } catch {
    return null;
  }
}

async function rowsFor(d: RunDeps, model: ManifestEntry): Promise<TrialResult[]> {
  const cached: TrialResult[] = [];
  const todo: TaskFixture[] = [];
  const concrete = new Map<string, string | null>();
  for (const f of d.fixtures) concrete.set(f.task_id, await concreteModelId(d, model, f));
  for (const f of d.fixtures) {
    const c = d.cache.get(model, f);
    if (
      isReusableCache(c, {
        trials: d.trials,
        harness_sha: d.harness_sha,
        model,
        fixture: f,
        concrete_model_id: concrete.get(f.task_id) ?? null,
      })
    ) {
      cached.push(...c!);
    } else todo.push(f);
  }
  if (todo.length === 0) return cached;
  d.beforeModel(model);
  const fresh = await runTrials({
    fixtures: todo,
    model,
    trials: d.trials,
    concurrency: d.concurrency,
    sandboxConcurrency: d.sandboxConcurrency,
    ledger: d.ledger,
    runTrial: d.runTrialFor(model),
    provider: model.route === "claude_sdk" ? "anthropic" : "openrouter",
    sleep: d.sleep,
  });
  const byTask = new Map(todo.map((f) => [f.task_id, f]));
  for (const r of fresh) {
    r.harness_sha = d.harness_sha;
    r.model_id = concrete.get(r.task_id) ?? model.model_id;
    r.upstream = model.upstream;
    r.fixture_version = byTask.get(r.task_id)?.fixture_version;
  }
  for (const f of todo) {
    const rows = fresh.filter((r) => r.task_id === f.task_id);
    if (rows.length === d.trials && !rows.some((r) => r.outcome === "capped")) d.cache.put(model, f, rows);
  }
  return [...cached, ...fresh];
}

const key = (r: TrialResult) => `${r.task_id}#${r.trial}`;

function needsJudge(r: TrialResult, ref: TrialResult | undefined): ref is TrialResult {
  if (!ref || isExcludedOutcome(ref.outcome)) return false;
  return r.outcome === "completed" || ref.outcome === "completed";
}

async function judgeRows(
  d: RunDeps,
  rows: ReadonlyArray<TrialResult>,
  refRows: ReadonlyArray<TrialResult>,
  judges: JudgePick,
): Promise<Map<string, PairJudgement | null>> {
  const out = new Map<string, PairJudgement | null>();
  if (judges.status !== "ok") return out;
  const refIdx = new Map(refRows.map((r) => [key(r), r]));
  const byTask = new Map(d.fixtures.map((f) => [f.task_id, f]));
  for (const r of rows) {
    const ref = refIdx.get(key(r));
    const f = byTask.get(r.task_id);
    if (!f || !needsJudge(r, ref)) continue;
    const j = await withBenchRetries(
      async () => ({
        value: await judgePair({ fixture: f, candidate: r, reference: ref, judges: judges.judges, client: d.client, ledger: d.ledger }),
        billedUsd: 0,
      }),
      { provider: "openrouter", sleep: d.sleep },
    );
    out.set(key(r), j.kind === "ok" ? j.value : null);
  }
  return out;
}

async function runBenchProdReference(d: RunDeps): Promise<BenchReport> {
  if (d.candidate.family === "anthropic") {
    throw new HarnessFailure("prod-reference mode never runs Claude: the candidate must be a non-Claude model");
  }
  assertProdReferenceFixtures(d.fixtures);
  const judges = pickJudges([d.candidate.family, "anthropic"]);
  const refRows = d.fixtures.flatMap((f) => Array.from({ length: d.trials }, (_, i) => prodReferenceRow(f, i + 1)));
  const cand = await rowsFor(d, d.candidate);
  const candJudged = await judgeRows(d, cand, refRows, judges);
  const jOk = judges.status === "ok";
  const candidate = cand.map((r) => scoreTrial(r, candJudged.get(key(r)) ?? null, jOk));
  const reference_sdk = refRows.map((r) => scoreTrial(r, null, false));
  const markdown = renderScorecard({
    date: d.date,
    model_key: d.candidate.key,
    model_lineage: d.candidate.lineage,
    harness_sha: d.harness_sha,
    trials: d.trials,
    fixtures: d.fixtures,
    candidate,
    reference_sdk,
    harness_shared: [],
    judges: jOk ? judges.judges.map((j) => j.key) : "judge_unavailable",
    scope: d.scope ?? null,
    no_substantive: d.no_substantive,
    harness_judges: "judge_unavailable",
    prod_reference: d.fixtures.map((f) => ({
      task_id: f.task_id,
      run_id: f.prod_reference!.run_id,
      model_used: f.prod_reference!.model_used,
      date: f.prod_reference!.date,
    })),
    spent_usd: d.ledger.spentUsd,
    max_usd: d.ledger.maxUsd,
    partial: d.ledger.partial,
    dry_run: d.dry_run,
  });
  return {
    markdown,
    partial: d.ledger.partial,
    candidate,
    reference_sdk,
    harness_shared: [],
    raw: { [d.candidate.key]: cand, [PROD_REFERENCE_KEY]: refRows },
  };
}

export async function runBench(d: RunDeps): Promise<BenchReport> {
  if (d.candidate.route !== "shared_loop") {
    throw new HarnessFailure("the candidate must be a shared-loop model (the SDK row is the reference)");
  }
  if (d.reference === "prod") return runBenchProdReference(d);
  const prodRef = d.fixtures.find((f) => f.prod_reference);
  if (prodRef) {
    throw new HarnessFailure(`fixture ${prodRef.task_id} is a prod-reference fixture; run it with --reference prod`);
  }
  assertFixturesFilledFor(d.fixtures, d.candidate);
  const shared = resolveModel(CLAUDE_SHARED_LOOP_KEY);
  const sdk = resolveModel(CLAUDE_SDK_KEY);

  const judges = pickJudges([d.candidate.family, "anthropic"]);
  const harnessJudges = pickJudges(["anthropic"]);

  const refShared = await rowsFor(d, shared);
  const refSdk = await rowsFor(d, sdk);
  const harnessJudged = await judgeRows(d, refShared, refSdk, harnessJudges);
  const expected = d.fixtures.length * d.trials;
  const rowsIncomplete = (rows: TrialResult[]) =>
    rows.length !== expected || rows.some((r) => r.outcome === "capped");
  const sdkIdx = new Map(refSdk.map((r) => [key(r), r]));
  const judgeIncomplete =
    harnessJudges.status === "ok" &&
    refShared.some((r) => needsJudge(r, sdkIdx.get(key(r))) && !harnessJudged.get(key(r)));
  const harnessPartial = rowsIncomplete(refShared) || rowsIncomplete(refSdk) || judgeIncomplete;

  const isShared = d.candidate.key === shared.key;
  const cand = isShared ? refShared : await rowsFor(d, d.candidate);
  const candJudged = isShared ? harnessJudged : await judgeRows(d, cand, refSdk, judges);

  const score = (rows: TrialResult[], judged: Map<string, PairJudgement | null>, required: boolean) =>
    rows.map((r) => scoreTrial(r, judged.get(key(r)) ?? null, required));

  const jOk = judges.status === "ok";
  const hOk = harnessJudges.status === "ok";
  const candidate = score(cand, candJudged, jOk);
  const harness_shared = score(refShared, harnessJudged, hOk);
  const reference_sdk = score(refSdk, new Map(), false);

  const markdown = renderScorecard({
    date: d.date,
    model_key: d.candidate.key,
    model_lineage: d.candidate.lineage,
    harness_sha: d.harness_sha,
    trials: d.trials,
    fixtures: d.fixtures,
    candidate,
    reference_sdk,
    harness_shared,
    judges: jOk ? judges.judges.map((j) => j.key) : "judge_unavailable",
    scope: d.scope ?? null,
    no_substantive: d.no_substantive,
    harness_judges: hOk ? harnessJudges.judges.map((j) => j.key) : "judge_unavailable",
    harness_partial: harnessPartial,
    search_recall: computeSearchRecall(cand, refSdk),
    spent_usd: d.ledger.spentUsd,
    max_usd: d.ledger.maxUsd,
    partial: d.ledger.partial,
    dry_run: d.dry_run,
  });
  return {
    markdown,
    partial: d.ledger.partial,
    candidate,
    reference_sdk,
    harness_shared,
    raw: { [d.candidate.key]: cand, [shared.key]: refShared, [sdk.key]: refSdk },
  };
}
