#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { serviceClient } from "../src/services/supabase";
import {
  isShadowTenantAllowed,
  SHADOW_DOGFOOD_TENANT,
} from "../src/services/eval/shadow-tenant-allowlist";
import { MODELS } from "../src/services/llm/models";
import {
  buildJudgeFamilyLadder,
  parseBlindJudgeReply,
  gradeShadowRowCore,
  gradeShadowRowSwapAveraged,
  normalizeForBlind as normalizeForBlindCore,
  deriveComparisonScore as deriveComparisonScoreCore,
  assignBlindLabels as assignBlindLabelsCore,
  decodeScores as decodeScoresCore,
  type ShadowJudgeFn,
} from "../src/services/eval/engine-parity/engine-parity";
import {
  makeBedrockJudgeFn,
  resolveBedrockJudgeModel,
  assertBedrockJudgeAvailable,
} from "../src/services/eval/engine-parity/bedrock-judge";

const DOGFOOD_TENANT = SHADOW_DOGFOOD_TENANT;

export const normalizeForBlind = normalizeForBlindCore;
export const deriveComparisonScore = deriveComparisonScoreCore;
export const assignBlindLabels = assignBlindLabelsCore;
export const decodeScores = decodeScoresCore;

const JUDGE_LADDER = buildJudgeFamilyLadder({
  excludeOpenAiFamily: true,
  homeDir: homedir(),
  env: process.env,
});

export type ShadowGradeRow = {
  shadow_id: string;
  source_agent_run_id: string;
  agent_slug: string;
  shadow_tenant_id: string;
  source_tenant_id: string;
  input_prompt: string;
  openai_raw: string | null;
  anthropic_raw: string | null;
  shadow_model: string;
};

export type GradeOutcome =
  | { kind: "graded"; agent_slug: string; comparison_score: number; openai_score: number; anthropic_score: number }
  | { kind: "skipped_null"; agent_slug: string; reason: string }
  | { kind: "judge_unavailable"; agent_slug: string }
  | { kind: "already_graded"; agent_slug: string };

export function gradeabilityReason(row: ShadowGradeRow): string | null {
  if (!row.anthropic_raw || !row.anthropic_raw.trim()) return "source rendered output empty";
  if (!row.openai_raw || !row.openai_raw.trim()) return "shadow output_text empty";
  return null;
}

export function buildComparisonNotes(
  isCustomer: boolean,
  v: {
    judge_family: string;
    openai_score: number;
    anthropic_score: number;
    winner: string;
    justification: string;
  },
): string {
  const base = {
    judge_family: v.judge_family,
    openai_score: v.openai_score,
    anthropic_score: v.anthropic_score,
    winner: v.winner,
  };
  return JSON.stringify(
    isCustomer ? base : { ...base, reason: v.justification.slice(0, 280) },
  );
}

export type AgentScore = {
  agent_slug: string;
  n: number;
  mean: number;
  parity_pct: number;
  skipped_null: number;
  judge_unavailable: number;
};

export function aggregateScorecard(outcomes: GradeOutcome[]): AgentScore[] {
  const byAgent = new Map<string, GradeOutcome[]>();
  for (const o of outcomes) {
    const arr = byAgent.get(o.agent_slug) ?? [];
    arr.push(o);
    byAgent.set(o.agent_slug, arr);
  }
  const out: AgentScore[] = [];
  for (const [agent_slug, arr] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const graded = arr.filter((o): o is Extract<GradeOutcome, { kind: "graded" }> => o.kind === "graded");
    const n = graded.length;
    const mean = n ? graded.reduce((s, g) => s + g.comparison_score, 0) / n : 0;
    const parity = n ? graded.filter((g) => g.comparison_score >= 3).length / n : 0;
    out.push({
      agent_slug,
      n,
      mean: Math.round(mean * 100) / 100,
      parity_pct: Math.round(parity * 100),
      skipped_null: arr.filter((o) => o.kind === "skipped_null").length,
      judge_unavailable: arr.filter((o) => o.kind === "judge_unavailable").length,
    });
  }
  return out;
}

function callJudge(wrapperPath: string, system: string, user: string): string | null {
  if (!existsSync(wrapperPath)) return null;
  const dir = mkdtempSync(join(tmpdir(), "shadow-grade-"));
  const pf = join(dir, "judge-prompt.txt");
  try {
    writeFileSync(pf, `${system}\n\n${user}\n`);
    const out = execFileSync("bash", [wrapperPath, "exec", pf], {
      encoding: "utf-8",
      timeout: 360_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out && out.trim() ? out : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cliLadderJudgeFn(taskId: string): ShadowJudgeFn {
  return async ({ system, user }) => {
    for (const { wrapper } of JUDGE_LADDER) {
      const raw = callJudge(wrapper, system, user);
      if (raw === null) continue;
      const verdict = parseBlindJudgeReply(taskId, raw);
      if (!verdict.error) return raw;
    }
    return null;
  };
}

type Args = {
  tenant?: string;
  agent?: string;
  limit: number;
  allowPartial: boolean;
  provider?: "openai" | "bedrock" | "fireworks" | "codex";
};

const GRADEABLE_PROVIDERS = [
  "openai",
  "bedrock",
  "fireworks",
  "codex",
] as const;

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 100, allowPartial: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") out.tenant = argv[++i];
    else if (argv[i] === "--agent") out.agent = argv[++i];
    else if (argv[i] === "--limit") out.limit = Math.max(1, Number(argv[++i]) || 100);
    else if (argv[i] === "--allow-partial") out.allowPartial = true;
    else if (argv[i] === "--provider") {
      const p = argv[++i];
      if (!(GRADEABLE_PROVIDERS as readonly string[]).includes(p)) {
        console.error(
          `--provider "${p}" is not a gradeable provider. Use one of: ` +
            `${GRADEABLE_PROVIDERS.join(", ")}. Refusing to fall back to ` +
            `"no filter" — that would silently mix providers into one mean.`,
        );
        process.exit(1);
      }
      out.provider = p as Args["provider"];
    }
  }
  return out;
}

async function selectUngraded(args: Args): Promise<ShadowGradeRow[]> {
  const sb = serviceClient();
  const tenant = args.tenant ?? "";
  if (!(await isShadowTenantAllowed(tenant))) {
    throw new Error(
      `tenant ${tenant || "(missing)"} is not on the shadow allowlist — refusing to select rows`,
    );
  }
  let q = sb
    .from("agent_shadow_runs")
    .select(
      "id, source_agent_run_id, agent_slug, tenant_id, output_text, model, " +
        "agent_runs!inner(tenant_id, payload, raw_response_text, output_text)",
    )
    .is("comparison_score", null)
    .in("status", ["success", "parse_failed"])
    .not("output_text", "is", null)
    .eq("agent_runs.tenant_id", tenant)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (args.agent) q = q.eq("agent_slug", args.agent);
  if (args.provider) q = q.eq("provider", args.provider);

  const { data, error } = await q;
  if (error) throw new Error(`select failed: ${error.message}`);

  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => {
    const src = (r.agent_runs ?? {}) as { tenant_id?: string; payload?: unknown; raw_response_text?: string | null; output_text?: string | null };
    return {
      shadow_id: String(r.id),
      source_agent_run_id: String(r.source_agent_run_id),
      agent_slug: String(r.agent_slug),
      shadow_tenant_id: String(r.tenant_id),
      source_tenant_id: String(src.tenant_id ?? ""),
      input_prompt: typeof src.payload === "string" ? src.payload : JSON.stringify(src.payload ?? {}),
      openai_raw: (r.output_text as string | null) ?? null,
      anthropic_raw:
        (src.output_text && src.output_text.trim()
          ? src.output_text
          : src.raw_response_text) ?? null,
      shadow_model: typeof r.model === "string" ? (r.model as string) : "",
    };
  });
}

async function gradeOne(row: ShadowGradeRow, isCustomer: boolean): Promise<GradeOutcome> {
  if (row.shadow_tenant_id !== row.source_tenant_id) {
    throw new Error(
      `tenant mismatch on shadow ${row.shadow_id}: stored ${row.shadow_tenant_id} != source ${row.source_tenant_id}`,
    );
  }

  const skip = gradeabilityReason(row);
  if (skip) return { kind: "skipped_null", agent_slug: row.agent_slug, reason: skip };

  const candidateModel = row.shadow_model || MODELS.bedrock.qwen3Next80b;
  const useLegacyCli =
    !isCustomer && process.env.SHADOW_GRADE_LEGACY_CLI_JUDGE === "1";
  const swapAverage =
    !useLegacyCli && process.env.PRAXIS_SHADOW_JUDGE_SWAP_AVERAGE !== "0";
  const coreArgs = {
    row: {
      id: row.shadow_id,
      agent_slug: row.agent_slug,
      input_prompt: row.input_prompt,
      candidate_raw: row.openai_raw!,
      baseline_raw: row.anthropic_raw!,
    },
    judge: useLegacyCli ? cliLadderJudgeFn(row.shadow_id) : getBedrockJudge(),
    judgeModel: useLegacyCli ? "grok-cli-judge" : resolveBedrockJudgeModel(),
    candidateModel,
    baselineModel: MODELS.anthropic.opus,
    judgeFamily: useLegacyCli ? "grok" : "bedrock",
  };

  let openai_score: number;
  let anthropic_score: number;
  let comparison_score: number;
  let judge_family: string;
  let justification: string;
  let winnerForNotes: string;
  if (swapAverage) {
    const avg = await gradeShadowRowSwapAveraged(coreArgs);
    if (avg.kind === "judge_unavailable") {
      return { kind: "judge_unavailable", agent_slug: row.agent_slug };
    }
    openai_score = avg.candidate_score;
    anthropic_score = avg.baseline_score;
    comparison_score = avg.comparison_score;
    judge_family = avg.judge_family;
    justification = avg.justification;
    winnerForNotes = avg.winner;
  } else {
    const coin: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    const single = await gradeShadowRowCore({ ...coreArgs, coin });
    if (single.kind === "judge_unavailable") {
      return { kind: "judge_unavailable", agent_slug: row.agent_slug };
    }
    openai_score = single.candidate_score;
    anthropic_score = single.baseline_score;
    comparison_score = single.comparison_score;
    judge_family = single.judge_family;
    justification = single.justification;
    winnerForNotes = single.winner_label;
  }

  const notes = buildComparisonNotes(isCustomer, {
    judge_family,
    openai_score,
    anthropic_score,
    winner: winnerForNotes,
    justification,
  });

  const sb = serviceClient();
  const { data: wrote, error } = await sb.rpc("grade_shadow_run", {
    p_shadow_run_id: row.shadow_id,
    p_comparison_score: comparison_score,
    p_comparison_notes: notes,
  });
  if (error) throw new Error(`grade_shadow_run ${row.shadow_id}: ${error.message}`);
  if (wrote === false) return { kind: "already_graded", agent_slug: row.agent_slug };
  return { kind: "graded", agent_slug: row.agent_slug, comparison_score, openai_score, anthropic_score };
}

let _bedrockJudge: ReturnType<typeof makeBedrockJudgeFn> | null = null;
function getBedrockJudge(): ReturnType<typeof makeBedrockJudgeFn> {
  if (!_bedrockJudge) _bedrockJudge = makeBedrockJudgeFn();
  return _bedrockJudge;
}

function renderScorecard(scores: AgentScore[]): string {
  const lines: string[] = [];
  lines.push("agent_slug          n    mean   parity%(>=3)   skipped_null   judge_unavail");
  let tN = 0, tSum = 0, tParity = 0, tSkip = 0, tUnavail = 0;
  for (const s of scores) {
    lines.push(
      `${s.agent_slug.padEnd(18)}  ${String(s.n).padStart(3)}  ${s.mean.toFixed(2).padStart(5)}  ${(s.parity_pct + "%").padStart(11)}  ${String(s.skipped_null).padStart(11)}  ${String(s.judge_unavailable).padStart(12)}`,
    );
    tN += s.n; tSum += s.mean * s.n; tParity += Math.round((s.parity_pct / 100) * s.n); tSkip += s.skipped_null; tUnavail += s.judge_unavailable;
  }
  const fleetMean = tN ? (tSum / tN).toFixed(2) : "0.00";
  const fleetParity = tN ? Math.round((tParity / tN) * 100) : 0;
  lines.push("-".repeat(78));
  lines.push(`${"FLEET".padEnd(18)}  ${String(tN).padStart(3)}  ${fleetMean.padStart(5)}  ${(fleetParity + "%").padStart(11)}  ${String(tSkip).padStart(11)}  ${String(tUnavail).padStart(12)}`);
  const totalRows = tN + tSkip + tUnavail;
  const coverage = totalRows ? Math.round((tN / totalRows) * 100) : 0;
  lines.push(`coverage: ${tN}/${totalRows} rows graded (${coverage}%)   ·   forbidden-writes: ledger unavailable (replay path disables tools)`);
  lines.push(`leak-guard: shadow runs carry no run_id in agent_run_events/decisions/messages — 0 rows attributable (architectural, see plan)`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tenant) {
    console.error(
      "--tenant <uuid> is required. Dogfood (73db45ff) is always allowed; a " +
        "customer tenant must be opted into system_config.blob.shadow_customer_tenant_ids.",
    );
    process.exit(1);
  }
  if (!(await isShadowTenantAllowed(args.tenant))) {
    console.error(
      `tenant ${args.tenant} is not on the shadow allowlist — aborting (fail-closed).`,
    );
    process.exit(1);
  }

  const isCustomer = args.tenant !== DOGFOOD_TENANT;

  if (isCustomer) {
    if (args.allowPartial) {
      console.error(
        "--allow-partial is forbidden for a customer tenant — customer grading is " +
          "all-or-nothing (fail-closed). Aborting.",
      );
      process.exit(1);
    }
    try {
      assertBedrockJudgeAvailable();
    } catch (e) {
      console.error(
        `in-VPC Bedrock judge unavailable — refusing to load customer raw text. ` +
          `${(e as Error).message}`,
      );
      process.exit(1);
    }
  }

  const rows = await selectUngraded(args);
  if (rows.length === 0) {
    console.log("no ungraded shadow rows (comparison_score null, allowlisted tenant).");
    return;
  }
  console.log(
    `grading ${rows.length} shadow row(s) for tenant ${args.tenant}` +
      `${isCustomer ? " [customer: fail-closed in-VPC judge, structured-only notes]" : ""}...`,
  );
  const outcomes: GradeOutcome[] = [];
  let failures = 0;
  for (const row of rows) {
    try {
      const o = await gradeOne(row, isCustomer);
      outcomes.push(o);
      console.log(
        o.kind === "graded"
          ? `ok ${row.shadow_id} ${row.agent_slug} → ${o.comparison_score}/4 (oa ${o.openai_score} vs an ${o.anthropic_score})`
          : `${o.kind} ${row.shadow_id} ${row.agent_slug}`,
      );
    } catch (e) {
      failures++;
      console.log(`FAIL ${row.shadow_id}: ${(e as Error).message}`);
    }
  }

  const scores = aggregateScorecard(outcomes);
  const card = renderScorecard(scores);
  console.log("\n" + card);

  const day = new Date().toISOString().slice(0, 10);
  const reportDir = join(process.cwd(), "qa-reports");
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `shadow-grade-${day}.md`), `# Shadow grade — ${day}\n\n\`\`\`\n${card}\n\`\`\`\n`);

  const judgeUnavail = outcomes.filter((o) => o.kind === "judge_unavailable").length;
  if ((judgeUnavail > 0 || failures > 0) && !args.allowPartial) {
    console.error(
      `\npartial/failed coverage — judge_unavailable=${judgeUnavail}, hard_failures=${failures}. ` +
        `Re-run when judge quota resets / fix the failing rows, or pass --allow-partial to accept.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && /shadow-grade\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
