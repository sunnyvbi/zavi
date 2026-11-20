
import { DEFAULT_RAW_TTL_DAYS } from "@/services/agents/raw-transcript-ttl";
import { HarnessFailure, isPinnedSha, parsePromptSnapshot } from "@/services/eval/shadow-harness";
import type { ProdReference, TaskFixture } from "./fixtures";
import type { TaskSeed } from "./miner";
import type { TrialRaw, TrialResult } from "./runner";
import { assertBenchTenant } from "./tenants";

export type SourceRunFullRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  status: string;
  payload: unknown;
  prompt_snapshot: string | null;
  enqueued_at: string;
  model_used: string | null;
  output_text: string | null;
  parsed: unknown;
};

export function assertSourceRuns(ids: ReadonlyArray<string>, rows: ReadonlyArray<SourceRunFullRow>): void {
  if (ids.length === 0) throw new HarnessFailure("--source-runs: no run ids given");
  for (const r of rows) assertBenchTenant(r.tenant_id);
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) {
      throw new HarnessFailure(
        `--source-runs: run ${id} was not found in any bench tenant (refused: only allowlisted tenants are read)`,
      );
    }
    if (r.agent_slug !== "engineer") {
      throw new HarnessFailure(`--source-runs: run ${id} is agent ${r.agent_slug}, not engineer`);
    }
    if (r.status !== "success") {
      throw new HarnessFailure(`--source-runs: run ${id} has status ${r.status}, not success`);
    }
    if (!parsePromptSnapshot(r.prompt_snapshot, r.trigger === "chat")) {
      throw new HarnessFailure(
        r.prompt_snapshot == null
          ? `--source-runs: run ${id} has no prompt snapshot: raw transcripts are purged after ${DEFAULT_RAW_TTL_DAYS} days (retention), so pick a run from the last ${DEFAULT_RAW_TTL_DAYS} days`
          : `--source-runs: run ${id} has no parseable prompt snapshot`,
      );
    }
  }
}

export function seedsFromSourceRuns(rows: ReadonlyArray<SourceRunFullRow>): TaskSeed[] {
  return rows.map((r) => {
    const tenant = assertBenchTenant(r.tenant_id);
    const prompt = parsePromptSnapshot(r.prompt_snapshot, r.trigger === "chat");
    if (!prompt) throw new HarnessFailure(`--source-runs: run ${r.id} has no parseable prompt snapshot`);
    const stage = (r.payload as { stage?: unknown } | null)?.stage;
    return {
      task_id: `${tenant.company}.engineer${typeof stage === "string" && stage ? `-${stage}` : ""}.${r.id.slice(0, 8)}`,
      tenant_id: r.tenant_id,
      company: tenant.company,
      agent_slug: r.agent_slug,
      unit: r.agent_slug,
      cohort: "role",
      source_run_id: r.id,
      input: { trigger: r.trigger, payload: r.payload ?? null, prompt },
    };
  });
}

type ParsedEnvelope = {
  repo?: unknown;
  base_branch?: unknown;
  head_branch?: unknown;
  typecheck_ok?: unknown;
  test_results?: { failed?: unknown } | null;
  postdeploy_verify?: { commit_sha?: unknown; repo?: unknown } | null;
};

export function referenceLocator(
  parsed: unknown,
): { repo: string } & ({ kind: "shipped_commit"; head_sha: string } | { kind: "branch"; head_branch: string; base_branch: string }) {
  const p = (parsed ?? {}) as ParsedEnvelope;
  const repo = typeof p.repo === "string" ? p.repo.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new HarnessFailure(`prod reference: the run's envelope names no repo (got ${JSON.stringify(p.repo)})`);
  }
  const shipped = p.postdeploy_verify?.commit_sha;
  if (isPinnedSha(shipped)) return { repo, kind: "shipped_commit", head_sha: shipped };
  const head = typeof p.head_branch === "string" ? p.head_branch.trim() : "";
  const base = typeof p.base_branch === "string" ? p.base_branch.trim() : "";
  if (head && base) return { repo, kind: "branch", head_branch: head, base_branch: base };
  throw new HarnessFailure("prod reference: the run recorded neither a shipped commit nor a head/base branch");
}

export function engineerChecksFromParsed(parsed: unknown): { typecheck_ok: boolean | null; tests_failed: number | null } {
  const p = (parsed ?? {}) as ParsedEnvelope;
  const failed = p.test_results?.failed;
  return {
    typecheck_ok: typeof p.typecheck_ok === "boolean" ? p.typecheck_ok : null,
    tests_failed: typeof failed === "number" && Number.isFinite(failed) ? failed : null,
  };
}

const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;

export const DIFF_STORE_CHARS = 60_000;

export type GithubFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };

export function diffFromGithubFiles(files: ReadonlyArray<GithubFile>): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`diff --git a/${f.filename} b/${f.filename}  (${f.status}, +${f.additions} -${f.deletions})`);
    if (LOCKFILE.test(f.filename)) out.push("(lockfile patch omitted)");
    else if (f.patch) out.push(f.patch);
    else out.push("(no text patch: binary or too large)");
  }
  return capDiff(out.join("\n"), DIFF_STORE_CHARS);
}

export function capDiff(diff: string, max: number): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n[diff truncated: ${diff.length - max} more chars]`;
}

export const PROD_REF_SUMMARY_CHARS = 6_000;
export const PROD_REF_DIFF_CHARS = 24_000;

export function answerWithCode(report: string | null | undefined, diff: string | undefined): string {
  const r = capDiff((report ?? "").trim() || "(no final report)", PROD_REF_SUMMARY_CHARS);
  if (diff === undefined) return r;
  const d = diff.trim() ? capDiff(diff, PROD_REF_DIFF_CHARS) : "(no code change)";
  return `### Final report\n${r}\n\n### Code change (diff from the shared start commit)\n${d}`;
}

export function judgeAnswerText(raw: TrialRaw | null | undefined): string {
  if (!raw) return "";
  return raw.code_diff === undefined ? (raw.output_text ?? "") : answerWithCode(raw.output_text, raw.code_diff);
}

export const PROD_REFERENCE_KEY = "claude-prod-run";

export function prodReferenceRow(f: TaskFixture, trial: number): TrialResult {
  const ref = f.prod_reference;
  if (!ref) throw new HarnessFailure(`fixture ${f.task_id} has no prod reference`);
  return {
    task_id: f.task_id,
    unit: f.unit,
    cohort: f.cohort,
    company: f.company,
    model_key: PROD_REFERENCE_KEY,
    trial,
    outcome: "completed",
    raw: {
      output_text: ref.summary,
      parse_ok: true,
      tool_calls: [],
      route_verdict: "sdk",
      code_diff: ref.diff,
      engineer_checks: { typecheck_ok: ref.typecheck_ok, typecheck_verified: null, tests_failed: ref.tests_failed },
    },
    billedUsd: 0,
    attempts: 0,
    model_id: ref.model_used,
  };
}

export function assertProdReferenceFixtures(fixtures: ReadonlyArray<TaskFixture>): void {
  if (fixtures.length === 0) throw new HarnessFailure("prod-reference run: no prod-reference fixtures");
  for (const f of fixtures) {
    if (!f.prod_reference) {
      throw new HarnessFailure(`prod-reference run: fixture ${f.task_id} has no prod reference (rebuild with --reference prod)`);
    }
    if (f.agent_slug !== "engineer" || f.pinned_sha !== f.prod_reference.start_sha) {
      throw new HarnessFailure(`prod-reference run: fixture ${f.task_id} is not an engineer task pinned to its reference start commit`);
    }
  }
}

export function prodReferenceFixture(seed: TaskSeed, ref: ProdReference, prevVersion = 0): TaskFixture {
  if (seed.agent_slug !== "engineer") throw new HarnessFailure(`prod reference: ${seed.task_id} is not an engineer task`);
  if (seed.source_run_id !== ref.run_id) throw new HarnessFailure(`prod reference for ${ref.run_id} given to task ${seed.task_id}`);
  if (!isPinnedSha(ref.start_sha) || !isPinnedSha(ref.head_sha)) {
    throw new HarnessFailure(`prod reference ${ref.run_id}: start/head must be 40-hex shas`);
  }
  return {
    fixture_version: prevVersion + 1,
    task_id: seed.task_id,
    tenant_id: seed.tenant_id,
    company: seed.company,
    agent_slug: seed.agent_slug,
    unit: seed.unit,
    cohort: seed.cohort,
    source_run_id: seed.source_run_id,
    input: seed.input,
    evidence: [],
    filled_by: [],
    pinned_sha: ref.start_sha,
    prod_reference: ref,
  };
}

export function prodReferenceRunReserveUsd(tasks: number, trials: number): number {
  return tasks * trials * (4 + 4 * 0.5);
}
