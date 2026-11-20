
import { DEFAULT_RAW_TTL_DAYS } from "@/services/agents/raw-transcript-ttl";
import { randomUUID } from "node:crypto";
import { HarnessFailure, withBenchSandbox, isPinnedSha } from "@/services/eval/shadow-harness";
import { takeOpenRouterRecorder } from "@/services/llm/openrouter";
import { takeToolSearchRecord } from "@/services/agents/engine/tool-search";
import type { ToolCallTrace } from "@/services/tools/types";
import { fixtureToShadowMap, type EvidenceRecord, type TaskFixture } from "./fixtures";
import type { ManifestEntry } from "./manifest";
import { runBenchTrial } from "./modes";
import type { TrialRaw } from "./runner";
import type { AttemptResult, BilledError } from "./spend";
import { assertBenchTenant, pinnedBenchTenants } from "./tenants";
import type { ProdReference } from "./fixtures";
import {
  DIFF_STORE_CHARS,
  assertSourceRuns,
  capDiff,
  diffFromGithubFiles,
  engineerChecksFromParsed,
  referenceLocator,
  type GithubFile,
  type SourceRunFullRow,
} from "./prod-reference";
import { UNIT_SCAN_LIMIT, measurableUnits, onlyTrivialRuns, validRowsForUnit, type SourceRunRow } from "./miner";
import { codeFromSdkToolError } from "./modes";

export function selectSharedLoopModel(model: ManifestEntry): void {
  if (model.route !== "shared_loop") return;
  if (!model.upstream) throw new HarnessFailure(`${model.key}: no pinned upstream`);
  process.env.PRAXIS_SHADOW_PROVIDER = "openrouter";
  process.env.PRAXIS_SHADOW_OPENROUTER_MODEL = model.model_id;
  process.env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM = model.upstream;
}

export async function readSourceRuns(
  tenantId: string,
  perUnit = 1,
  onlyUnits?: ReadonlySet<string> | null,
): Promise<{ rows: SourceRunRow[]; noSubstantive: string[] }> {
  const tenant = assertBenchTenant(tenantId);
  const { tenantClient, asTenantId } = await import("@/services/tenant-client");
  const since = new Date(Date.now() - DEFAULT_RAW_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const tc = tenantClient(asTenantId(tenant.id as string));
  const out: SourceRunRow[] = [];
  const noSubstantive: string[] = [];
  for (const { unit, cohort } of measurableUnits()) {
    if (onlyUnits && onlyUnits.size > 0 && !onlyUnits.has(unit)) continue;
    let q = tc
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, trigger, payload, prompt_snapshot, enqueued_at")
      .eq("status", "success")
      .not("prompt_snapshot", "is", null)
      .gte("enqueued_at", since);
    q =
      cohort === "channel"
        ? q.eq("trigger", "channel_recipe").eq("payload->>channel_slug", unit)
        : q.eq("agent_slug", unit).neq("trigger", "channel_recipe");
    const { data, error } = await q.order("enqueued_at", { ascending: false }).limit(UNIT_SCAN_LIMIT);
    if (error) throw new HarnessFailure(`source select failed (${unit}): ${error.message}`);
    const rows = (data ?? []) as SourceRunRow[];
    out.push(...validRowsForUnit(rows, perUnit));
    if (onlyTrivialRuns(rows)) noSubstantive.push(unit);
  }
  return { rows: out, noSubstantive };
}

export async function readSourceRunsByIds(ids: ReadonlyArray<string>): Promise<SourceRunFullRow[]> {
  if (!ids.every((id) => /^[0-9a-f-]{36}$/.test(id))) {
    throw new HarnessFailure(`--source-runs: every id must be a full agent_runs uuid`);
  }
  const { tenantClient, asTenantId } = await import("@/services/tenant-client");
  const rows: SourceRunFullRow[] = [];
  for (const t of pinnedBenchTenants()) {
    const tc = tenantClient(asTenantId(assertBenchTenant(t.id).id as string));
    const { data, error } = await tc
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, trigger, status, payload, prompt_snapshot, enqueued_at, model_used, output_text, parsed")
      .in("id", [...ids]);
    if (error) throw new HarnessFailure(`source-runs select failed (${t.company}): ${error.message}`);
    rows.push(...((data ?? []) as SourceRunFullRow[]));
  }
  assertSourceRuns(ids, rows);
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

export async function fetchProdReference(row: SourceRunFullRow): Promise<ProdReference> {
  assertBenchTenant(row.tenant_id);
  const loc = referenceLocator(row.parsed);
  const { resolveRepoCredsForRun } = await import("@/services/sandbox/repo-creds");
  const creds = await resolveRepoCredsForRun(row.tenant_id, row.payload);
  if (creds.kind !== "resolved") throw new HarnessFailure(`prod reference ${row.id}: repo creds did not resolve (${creds.kind})`);
  if (creds.repo_full_name.toLowerCase() !== loc.repo.toLowerCase()) {
    throw new HarnessFailure(`prod reference ${row.id}: run shipped to ${loc.repo} but the sandbox would clone ${creds.repo_full_name}`);
  }
  const gh = async <T>(path: string): Promise<T> => {
    const r = await fetch(`https://api.github.com/repos/${loc.repo}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.installation_token}`, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new HarnessFailure(`prod reference ${row.id}: GitHub GET ${path} -> ${r.status}`);
    return (await r.json()) as T;
  };
  let start: string;
  let head: string;
  if (loc.kind === "shipped_commit") {
    head = loc.head_sha;
    const c = await gh<{ parents: Array<{ sha: string }> }>(`/commits/${head}`);
    if (c.parents.length !== 1) {
      throw new HarnessFailure(`prod reference ${row.id}: shipped commit ${head} has ${c.parents.length} parents (want 1)`);
    }
    start = c.parents[0].sha;
  } else {
    const cmp = await gh<{ merge_base_commit: { sha: string }; commits: Array<{ sha: string }> }>(
      `/compare/${encodeURIComponent(loc.base_branch)}...${encodeURIComponent(loc.head_branch)}`,
    );
    start = cmp.merge_base_commit.sha;
    head = cmp.commits[cmp.commits.length - 1]?.sha ?? "";
  }
  const cmp = await gh<{ files?: GithubFile[] }>(`/compare/${start}...${head}`);
  const checks = engineerChecksFromParsed(row.parsed);
  const parsedMd = (row.parsed as { rendered_markdown?: unknown } | null)?.rendered_markdown;
  return {
    run_id: row.id,
    model_used: row.model_used ?? "unknown",
    date: row.enqueued_at,
    repo: loc.repo,
    start_sha: start,
    head_sha: head,
    source: loc.kind === "shipped_commit" ? "shipped_commit" : "branch_merge_base",
    summary: row.output_text?.trim() || (typeof parsedMd === "string" ? parsedMd : ""),
    diff: diffFromGithubFiles(cmp.files ?? []),
    typecheck_ok: checks.typecheck_ok,
    tests_failed: checks.tests_failed,
  };
}

export async function captureSandboxChange(
  exec: (id: string, cmd: string, timeoutMs?: number) => Promise<{ exit_code: number; stdout: string; stderr: string }>,
  sandboxId: string,
  pinnedSha: string,
): Promise<{ code_diff: string; typecheck_verified: boolean | null }> {
  if (!isPinnedSha(pinnedSha)) throw new HarnessFailure(`capture: bad pinned sha ${JSON.stringify(pinnedSha)}`);
  const skip = `':(exclude)node_modules' ':(exclude).next'`;
  const d = await exec(
    sandboxId,
    `cd /home/user/repo || { echo "capture: no /home/user/repo" >&2; exit 2; }; ` +
      `git add -A -- . >/dev/null || { echo "capture: git add failed" >&2; exit 3; }; ` +
      `git rm -r -q --cached --ignore-unmatch -- node_modules .next >/dev/null || { echo "capture: git rm --cached failed" >&2; exit 3; }; ` +
      `git diff --cached --stat ${pinnedSha} || { echo "capture: git diff --stat failed" >&2; exit 4; }; echo; ` +
      `git diff --cached ${pinnedSha} -- . ':(exclude)package-lock.json' ${skip} | head -c 200000`,
    120_000,
  );
  if (d.exit_code !== 0) {
    throw new HarnessFailure(
      `capture: git diff failed (exit ${d.exit_code}): ${(d.stderr.trim() || d.stdout.trim()).slice(-600)}`,
    );
  }
  const tc = await exec(
    sandboxId,
    `cd /home/user/repo && if [ ! -f tsconfig.json ]; then echo PRAXIS_TSC=skip; exit 0; fi; ` +
      `if ( [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1 ); then ` +
      `tsc_ec=0; timeout 300 npx --no-install tsc --noEmit -p . >/dev/null 2>&1 || tsc_ec=$?; echo PRAXIS_TSC=$tsc_ec; ` +
      `else echo PRAXIS_TSC=install_failed; fi`,
    600_000,
  );
  const typecheck_verified = typecheckFromMarker(tc.stdout);
  return { code_diff: capDiff(d.stdout.trim(), DIFF_STORE_CHARS), typecheck_verified };
}

export function typecheckFromMarker(stdout: string): boolean | null {
  const code = /PRAXIS_TSC=(\w+)/.exec(stdout)?.[1];
  if (!code || code === "skip" || code === "install_failed" || code === "124" || code === "127") return null;
  return code === "0";
}

export function assertSharedLoopEnv(model: ManifestEntry, env: NodeJS.ProcessEnv = process.env): void {
  if (model.route !== "shared_loop") return;
  if (
    env.PRAXIS_SHADOW_PROVIDER !== "openrouter" ||
    env.PRAXIS_SHADOW_OPENROUTER_MODEL !== model.model_id ||
    env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM !== model.upstream
  ) {
    throw new HarnessFailure(
      `bench routing mismatch for ${model.key}: env routes to ` +
        `${env.PRAXIS_SHADOW_PROVIDER}/${env.PRAXIS_SHADOW_OPENROUTER_MODEL}@${env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM}, ` +
        `manifest says openrouter/${model.model_id}@${model.upstream}`,
    );
  }
}

async function sandboxDeps() {
  const lifecycle = await import("@/services/sandbox/shadow-lifecycle");
  const e2b = await import("@/services/sandbox/e2b-client");
  return {
    createShadowSandboxForRun: lifecycle.createShadowSandboxForRun,
    destroyShadowSandbox: lifecycle.destroyShadowSandbox,
    execCommand: e2b.execCommand,
    revokeSandboxGithubToken: (id: string) => e2b.revokeSandboxGithubToken(id),
  };
}

export async function resolveHeadSha(tenantId: string, payload: unknown): Promise<string> {
  const d = await sandboxDeps();
  let id: string | undefined;
  try {
    const h = await d.createShadowSandboxForRun({ run_id: randomUUID(), tenant_id: tenantId, payload });
    id = h.sandbox_id;
    const r = await d.execCommand(h.sandbox_id, "cd /home/user/repo && git rev-parse HEAD", 30_000);
    const sha = r.stdout.trim();
    if (!isPinnedSha(sha)) throw new HarnessFailure(`could not read HEAD sha: ${r.stderr.slice(0, 200)}`);
    return sha;
  } finally {
    await d.destroyShadowSandbox(id);
  }
}

export function traceToToolCalls(traces: ReadonlyArray<ToolCallTrace>): TrialRaw["tool_calls"] {
  return traces.map((t) => ({
    name: t.name,
    code: t.code ?? (t.status === "tool_error" ? codeFromSdkToolError(t.output_preview) : undefined),
    status: t.status,
  }));
}

export function summarizeToolCalls(calls: TrialRaw["tool_calls"]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const k = c.code && c.code !== "ok" ? `${c.name} (${c.code})` : c.name;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} x${n}`);
  return `${calls.length} tool call(s)${parts.length ? ": " + parts.join(", ") : ""}`;
}

export type LiveTrialArgs = {
  fixture: TaskFixture;
  model: ManifestEntry;
  mode: "build" | "score";
  capture?: (r: EvidenceRecord) => void;
};

export async function liveTrial(a: LiveTrialArgs): Promise<AttemptResult<TrialRaw>> {
  const f = a.fixture;
  assertBenchTenant(f.tenant_id);
  assertSharedLoopEnv(a.model);
  const { buildContext } = await import("@/services/agents/runner");
  const { runGeneric } = await import("@/services/agents/generic-dispatcher");
  const trialRunId = randomUUID();
  const ctx = await buildContext(
    {
      id: f.source_run_id,
      tenant_id: f.tenant_id,
      agent_slug: f.agent_slug,
      trigger: f.input.trigger as never,
      payload: f.input.payload ?? null,
    },
    f.source_run_id,
  );
  if (ctx.tenant_id !== f.tenant_id) {
    throw new HarnessFailure(`buildContext tenant ${ctx.tenant_id} != task tenant ${f.tenant_id}`);
  }
  ctx.runId = trialRunId;
  ctx.shadow_mode = true;
  ctx.emitDecision = async () => "shadow_noop";
  ctx.emitProgress = async () => {};
  ctx.shadow_prompt_override = f.input.prompt;
  ctx.bench_mode = a.mode;
  ctx.bench_engine = a.model.route;
  ctx.bench_task_tenant = f.tenant_id;
  if (a.mode === "score") ctx.shadow_tool_results = fixtureToShadowMap(f, ctx.tenant_id);
  if (a.mode === "build" && a.capture) {
    const sink = a.capture;
    ctx.bench_capture = (r) =>
      sink({ tenant_id: r.tenant_id, tool_name: r.tool_name, input: r.input, content: r.content, is_error: r.is_error });
  }

  const runOnce = async () => {
    const r = await runBenchTrial(ctx, (c) => runGeneric(c, f.input.payload ?? null));
    const traced = traceToToolCalls((r.tool_calls ?? []) as ToolCallTrace[]);
    console.log(`[model-bench] ${f.task_id} ${a.model.key}: ${summarizeToolCalls(traced)}`);
    return r;
  };
  const billedSoFar = async () => {
    const rec = takeOpenRouterRecorder(trialRunId);
    if (!rec) return { usd: 0, verdict: "no_calls" as const };
    await rec.settle();
    return { usd: rec.totalCostUsd(), verdict: rec.verdict() };
  };

  let result;
  let change: Awaited<ReturnType<typeof captureSandboxChange>> | undefined;
  try {
    if (f.agent_slug === "engineer") {
      const pinned = f.pinned_sha;
      if (!pinned) throw new HarnessFailure(`engineer task ${f.task_id} has no pinned_sha`);
      const deps = await sandboxDeps();
      result = await withBenchSandbox(
        deps,
        { run_id: trialRunId, tenant_id: f.tenant_id, payload: f.input.payload, pinned_sha: pinned },
        async (h) => {
          ctx.shadow_sandbox_id = h.sandbox_id;
          const r = await runOnce();
          if (f.prod_reference) change = await captureSandboxChange(deps.execCommand, h.sandbox_id, pinned);
          return r;
        },
      );
    } else {
      result = await runOnce();
    }
  } catch (e) {
    takeToolSearchRecord(trialRunId);
    if (a.model.route === "shared_loop") {
      const b = await billedSoFar();
      if (b.verdict === "ok") (e as BilledError).billedUsd = b.usd;
    }
    throw e;
  }

  const searchRecord = takeToolSearchRecord(trialRunId);
  if ((result.parsed as { envelope_kind?: string } | null)?.envelope_kind === "setup_required") {
    throw new Error("setup_short_circuit: the model was never called (not a real trial)");
  }
  const calls = traceToToolCalls((result.tool_calls ?? []) as ToolCallTrace[]);
  const codeFields = change
    ? {
        code_diff: change.code_diff,
        engineer_checks: { ...engineerChecksFromParsed(result.parsed), typecheck_verified: change.typecheck_verified },
      }
    : {};
  if (a.model.route === "shared_loop") {
    const b = await billedSoFar();
    return {
      value: {
        output_text: result.output_text ?? null,
        parse_ok: result.parse_ok,
        tool_calls: calls,
        route_verdict: b.verdict,
        ...(searchRecord ? { surfaced_tools: [...searchRecord.surfaced].sort() } : {}),
        ...codeFields,
      },
      billedUsd: b.verdict === "ok" ? b.usd : undefined,
    };
  }
  const cost = result.usage?.cost_usd;
  return {
    value: {
      output_text: result.output_text ?? null,
      parse_ok: result.parse_ok,
      tool_calls: calls,
      route_verdict: typeof cost === "number" ? "sdk" : "no_usage_cost",
    },
    billedUsd: typeof cost === "number" ? cost : undefined,
  };
}
