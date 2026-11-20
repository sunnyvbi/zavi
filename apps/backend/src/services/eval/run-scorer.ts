
import { serviceClient } from "@/services/supabase";
import { callModel } from "@/services/llm/call-model";
import { alert } from "@/services/logging/alert";
import { isFixedTemperatureModel } from "@/services/llm/models";
import {
  detectNegativeExistenceClaims,
  groundNegativeExistence,
  isBackendSubsystemPath,
  type NegativeExistenceEvidence,
} from "@/services/agents/negative-existence-grounding-verifier";
import {
  isResearchSelfAbortOutput,
  RESEARCH_SELF_ABORT_SENTINEL,
} from "@/agents/research/self-abort";
import {
  isOperatorHandoffAck,
  OPERATOR_HANDOFF_ACK_SENTINEL,
} from "@/services/agents/handoff-ack";

const JUDGE_MODEL = process.env.RUN_SCORER_MODEL || "gpt-5.5";
const RECENT_WINDOW_DAYS = 14;

const JUDGE_ERROR_SENTINEL = "skipped:judge-error";

export function isRetryableJudgeError(message: string): boolean {
  const m = (message || "").toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(m)) return true;
  if (m.includes("rate limit") || m.includes("rate_limit")) return true;
  if (m.includes("overloaded") || m.includes("timeout") || m.includes("timed out")) return true;
  if (m.includes("econnreset") || m.includes("econnrefused") || m.includes("etimedout")) return true;
  if (m.includes("socket hang up") || m.includes("fetch failed")) return true;
  return false;
}

const blackoutAlerted = new Set<string>();

export function judgeSamplingOpts(model: string): { temperature?: number } {
  return isFixedTemperatureModel(model) ? {} : { temperature: 0 };
}

export function judgeMaxTokens(model: string): number {
  return isFixedTemperatureModel(model) ? 2000 : 300;
}

const NEG_EXISTENCE_FLAG = "NEG_EXISTENCE_GROUNDING_ENABLED" as const;

export function isNegExistenceGroundingEnabled(): boolean {
  const v = process.env[NEG_EXISTENCE_FLAG];
  return v !== "0" && v !== "false";
}

const MAX_GH_PER_TICK = Number(process.env.NEG_EXISTENCE_MAX_GH_PER_TICK ?? 5);

const NEG_EXISTENCE_RECENT_MS = 120 * 60 * 1000;

const NEG_EXISTENCE_CLAMP_MAX = 49;
const NEG_EXISTENCE_RATIONALE = "false_negative_existence";

const CODE_CLAIMING_AGENTS: ReadonlySet<string> = new Set([
  "engineer",
  "research",
  "pm",
]);

export function isCodeClaimingAgent(agentSlug: string): boolean {
  return CODE_CLAIMING_AGENTS.has(agentSlug);
}

const HARD_CLAMP_HIT_TYPES: ReadonlySet<NegativeExistenceEvidence["hit_type"]> = new Set([
  "route",
  "function",
  "field",
]);

export function canHardClamp(evidence: NegativeExistenceEvidence): boolean {
  if (!evidence) return false;
  if (!HARD_CLAMP_HIT_TYPES.has(evidence.hit_type)) return false;
  if (!isBackendSubsystemPath(evidence.path)) return false;
  return true;
}
const NEG_EXISTENCE_GROUND_TIMEOUT_MS = Number(
  process.env.NEG_EXISTENCE_GROUND_TIMEOUT_MS ?? 15_000,
);
const OUTPUT_TRUNCATE_CHARS = 12_000;
const LONG_ENVELOPE_AGENTS = new Set(["advisor", "research", "pm"]);
const TERMINAL_STATUSES = ["success", "failed", "error", "parse_failed"] as const;

export const SKIP_SENTINEL = "skipped:never-executed";

export type RunQuality = { score: number; rationale: string; model: string };

type ScorableRun = {
  id: string;
  agent_slug: string;
  status: string;
  output_text: string | null;
  error: string | null;
  model_used: string | null;
  cost_usd: number | null;
  tool_calls: unknown[] | number | null;
};

export async function isRunScoringEnabled(): Promise<boolean> {
  try {
    const { data } = await serviceClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.run_scoring_enabled !== false;
  } catch {
    return true;
  }
}

const JUDGE_SYSTEM =
  "You are a strict, fair QA judge for an AI agent's single run. Score how WELL " +
  "the agent did THIS run on a 1-100 scale, where 100 = an expert operator would " +
  "ship it as-is, 50 = usable but clearly flawed, 1 = wrong/empty/unhelpful. " +
  "Judge the OUTPUT quality (correctness, completeness, usefulness, right shape), " +
  "not length. A confident but wrong or empty answer scores LOW. Reply ONLY with " +
  'minified JSON: {"score": <int 1-100>, "rationale": "<=2 sentences on what drove the score, naming the biggest flaw if any"}.';

function buildJudgeUserPrompt(run: ScorableRun): string {
  const cap = LONG_ENVELOPE_AGENTS.has(run.agent_slug)
    ? OUTPUT_TRUNCATE_CHARS
    : Math.min(OUTPUT_TRUNCATE_CHARS, 6_000);
  const out = (run.output_text ?? "").slice(0, cap);
  const lines = [
    `Agent: ${run.agent_slug}`,
    `Run status: ${run.status}`,
    run.error ? `Run error: ${String(run.error).slice(0, 500)}` : null,
    "",
    "Agent output:",
    out.trim().length > 0 ? out : "(empty output)",
  ].filter(Boolean);
  return lines.join("\n");
}

export function parseVerdict(text: string): { score: number; rationale: string } | null {
  const raw = text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const o = obj as { score?: unknown; rationale?: unknown };
  const n = Number(o.score);
  if (!Number.isFinite(n)) return null;
  const score = Math.max(1, Math.min(100, Math.round(n)));
  const rationale = typeof o.rationale === "string" ? o.rationale.slice(0, 1000) : "";
  return { score, rationale };
}

export async function scoreRun(run: ScorableRun): Promise<RunQuality> {
  const res = await callModel({
    provider: "openai",
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: buildJudgeUserPrompt(run) }],
    max_tokens: judgeMaxTokens(JUDGE_MODEL),
    ...judgeSamplingOpts(JUDGE_MODEL),
    tags: { feature: "run-scorer" } as never,
  });
  const verdict = parseVerdict(res.text);
  if (!verdict) {
    throw new Error(`run-scorer: unparseable judge reply for run ${run.id}`);
  }
  return { ...verdict, model: JUDGE_MODEL };
}

export type ScorerLogger = {
  info: (s: string) => void;
  warn: (s: string) => void;
};

export type GroundOutcome =
  | {
      outcome: "processed";
      quality?: RunQuality;
      evidence?: NegativeExistenceEvidence;
    }
  | {
      outcome: "skip";
      reason: "latch_off" | "budget" | "github_unavailable" | "rederive_failed";
    };

export async function maybeGroundNegativeExistence(
  run: ScorableRun,
  baseQuality: RunQuality,
  budget: { remaining: number },
  logger: ScorerLogger,
): Promise<GroundOutcome> {
  if (!isNegExistenceGroundingEnabled()) return { outcome: "skip", reason: "latch_off" };
  if (!isCodeClaimingAgent(run.agent_slug)) return { outcome: "processed" };
  const text = run.output_text ?? "";
  if (text.trim().length === 0) return { outcome: "processed" };

  const claims = detectNegativeExistenceClaims(text);
  if (claims.length === 0) return { outcome: "processed" };

  if (budget.remaining <= 0) {
    logger.info(`run-scorer: neg-existence budget exhausted — skip run ${run.id}`);
    return { outcome: "skip", reason: "budget" };
  }

  const sb = serviceClient();
  const { data: meta, error: metaErr } = await sb
    .from("agent_runs")
    .select("tenant_id, finished_at")
    .eq("id", run.id)
    .maybeSingle();
  if (metaErr) {
    logger.warn(`run-scorer: neg-existence tenant re-derive failed run ${run.id}: ${metaErr.message}`);
    return { outcome: "skip", reason: "rederive_failed" };
  }
  if (!meta) return { outcome: "processed" };
  const tenant_id = (meta as { tenant_id?: string }).tenant_id ?? "";
  if (!tenant_id) return { outcome: "processed" };
  const finishedAt = (meta as { finished_at?: string | null }).finished_at ?? null;

  budget.remaining -= 1;

  let grounded;
  try {
    grounded = await Promise.race([
      groundNegativeExistence(tenant_id, claims),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("neg-existence grounding timed out")),
          NEG_EXISTENCE_GROUND_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (e) {
    logger.warn(`run-scorer: neg-existence grounding failed/timed-out run ${run.id}: ${(e as Error).message}`);
    return { outcome: "skip", reason: "github_unavailable" };
  }

  const wrong = grounded.find((g) => g.exists === true && g.evidence);
  if (!wrong || !wrong.evidence) return { outcome: "processed" };

  const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
  const isRecent = Number.isFinite(finishedMs) && Date.now() - finishedMs <= NEG_EXISTENCE_RECENT_MS;
  const shaPinned = wrong.evidence.checked_ref !== "HEAD" && wrong.evidence.checked_ref.length >= 7;

  if (!isRecent && !shaPinned) {
    logger.info(
      `run-scorer: neg-existence proven-wrong but run ${run.id} is stale (unbounded ref) — recording evidence, NOT clamping`,
    );
    return {
      outcome: "processed",
      evidence: { ...wrong.evidence, checked_ref: `${wrong.evidence.checked_ref}, unbounded` },
    };
  }

  if (!canHardClamp(wrong.evidence)) {
    logger.info(
      `run-scorer: neg-existence proven-wrong run ${run.id} but evidence not hard-clampable ` +
        `(hit_type=${wrong.evidence.hit_type}, path=${wrong.evidence.path}) — recording evidence, NOT clamping`,
    );
    return { outcome: "processed", evidence: wrong.evidence };
  }

  const clampedScore = Math.min(baseQuality.score, NEG_EXISTENCE_CLAMP_MAX);
  return {
    outcome: "processed",
    quality: {
      score: clampedScore,
      rationale: NEG_EXISTENCE_RATIONALE,
      model: baseQuality.model,
    },
    evidence: wrong.evidence,
  };
}

export function isNeverExecuted(run: ScorableRun): boolean {
  if (run.model_used === null || run.model_used === undefined) return true;
  if (run.error && /reap/i.test(run.error)) return true;
  const toolCallCount = Array.isArray(run.tool_calls)
    ? run.tool_calls.length
    : (run.tool_calls ?? 0);
  const zeroActivity =
    (run.cost_usd === null || run.cost_usd === 0) && toolCallCount === 0;
  const emptyOutput = !run.output_text || run.output_text.trim().length === 0;
  if (zeroActivity && emptyOutput) return true;
  return false;
}

export async function scoreRecentUnscoredRuns(
  logger: ScorerLogger,
  batch = 20,
): Promise<{ enabled: boolean; scored: number; skipped: number; neverExecuted: number; candidates: number }> {
  if (!(await isRunScoringEnabled())) {
    logger.info("run-scorer: disabled via run_scoring_enabled=false — skip");
    return { enabled: false, scored: 0, skipped: 0, neverExecuted: 0, candidates: 0 };
  }

  const sinceIso = new Date(Date.now() - RECENT_WINDOW_DAYS * 86400_000).toISOString();
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id, agent_slug, status, output_text, error, model_used, cost_usd, tool_calls")
    .is("quality_scored_at", null)
    .in("status", TERMINAL_STATUSES as unknown as string[])
    .gte("finished_at", sinceIso)
    .order("finished_at", { ascending: false })
    .limit(batch);
  if (error) {
    logger.warn(`run-scorer: candidate query failed: ${error.message}`);
    return { enabled: true, scored: 0, skipped: 0, neverExecuted: 0, candidates: 0 };
  }
  const runs = (data ?? []) as ScorableRun[];
  let scored = 0;
  let skipped = 0;
  let neverExecuted = 0;
  let judgeAttempted = 0;
  let judgeHardFailed = 0;
  let firstJudgeError: string | null = null;
  for (const run of runs) {
    if (isNeverExecuted(run)) {
      await persistSkipped(run.id);
      neverExecuted++;
      continue;
    }
    if (isResearchSelfAbortOutput(run.agent_slug, run.output_text)) {
      await persistSkipped(run.id, RESEARCH_SELF_ABORT_SENTINEL);
      skipped++;
      continue;
    }
    if (isOperatorHandoffAck(run.agent_slug, run.tool_calls, run.output_text)) {
      await persistSkipped(run.id, OPERATOR_HANDOFF_ACK_SENTINEL);
      skipped++;
      continue;
    }
    if (!run.output_text || run.output_text.trim().length === 0) {
      await persist(run.id, { score: 1, rationale: "Empty output — nothing produced.", model: "heuristic" });
      scored++;
      continue;
    }
    judgeAttempted++;
    try {
      const q = await scoreRun(run);
      await persist(run.id, q);
      scored++;
    } catch (e) {
      skipped++;
      const msg = (e as Error).message ?? "unknown";
      if (!firstJudgeError) firstJudgeError = msg;
      logger.warn(`run-scorer: skip run ${run.id}: ${msg}`);
      if (!isRetryableJudgeError(msg)) {
        judgeHardFailed++;
        try {
          await persistSkipped(run.id, JUDGE_ERROR_SENTINEL);
        } catch (pe) {
          logger.warn(`run-scorer: release ${run.id} failed: ${(pe as Error).message}`);
        }
      }
    }
  }
  logger.info(
    `run-scorer: candidates=${runs.length} scored=${scored} neverExecuted=${neverExecuted} skipped=${skipped}`,
  );
  if (judgeAttempted > 0 && scored === 0) {
    const reason = firstJudgeError ?? "unknown";
    const key = reason.slice(0, 120);
    if (!blackoutAlerted.has(key)) {
      blackoutAlerted.add(key);
      await alert({
        source: "eval.run-scorer",
        code: "run_scorer_judge_blackout",
        msg:
          `judge scored 0 of ${judgeAttempted} attempted candidates ` +
          `(${judgeHardFailed} released as ${JUDGE_ERROR_SENTINEL}). ` +
          `Eval coverage is ZERO while this holds. First error: ${reason}`,
        email: {
          dedupeKey: `run_scorer_judge_blackout:${key}`,
          detail:
            `<p>The run-scorer's LLM judge attempted ${judgeAttempted} candidate(s) ` +
            `this tick and scored <b>0</b>. ${judgeHardFailed} were released as ` +
            `<code>${JUDGE_ERROR_SENTINEL}</code>.</p>` +
            `<p><b>Eval coverage (L4 bar #1) is zero while this holds.</b></p>` +
            `<p>Check, in order: (1) is the judge provider credential valid — ` +
            `a 401 here reads as a judge bug but is usually an expired key; ` +
            `(2) <code>RUN_SCORER_MODEL</code> still a live model id; ` +
            `(3) <code>quality_model</code> on recent <code>agent_runs</code> — ` +
            `<code>skipped:judge-error</code> means the judge threw, not that ` +
            `scoring was skipped.</p>`,
          subjectDetail: `0 of ${judgeAttempted} scored — eval coverage ZERO`,
        },
      }).catch(() => {});
    }
  }
  return { enabled: true, scored, skipped, neverExecuted, candidates: runs.length };
}

type GroundableRun = {
  id: string;
  agent_slug: string;
  status: string;
  output_text: string | null;
  quality_score: number | null;
  quality_rationale: string | null;
  quality_model: string | null;
};

export async function groundRecentScoredRuns(
  logger: ScorerLogger,
  batch = Number(process.env.NEG_EXISTENCE_GROUND_BATCH ?? 20),
): Promise<{
  enabled: boolean;
  candidates: number;
  grounded: number;
  clamped: number;
  skipped: number;
}> {
  if (!isNegExistenceGroundingEnabled()) {
    logger.info("neg-existence-ground: disabled via latch — skip");
    return { enabled: false, candidates: 0, grounded: 0, clamped: 0, skipped: 0 };
  }

  const sinceIso = new Date(Date.now() - NEG_EXISTENCE_RECENT_MS).toISOString();
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id, agent_slug, status, output_text, quality_score, quality_rationale, quality_model")
    .not("quality_score", "is", null)
    .is("quality_grounded_at", null)
    .in("status", TERMINAL_STATUSES as unknown as string[])
    .gte("finished_at", sinceIso)
    .order("finished_at", { ascending: false })
    .limit(batch);
  if (error) {
    logger.warn(`neg-existence-ground: candidate query failed: ${error.message}`);
    return { enabled: true, candidates: 0, grounded: 0, clamped: 0, skipped: 0 };
  }

  const runs = (data ?? []) as GroundableRun[];
  let grounded = 0;
  let clamped = 0;
  let skipped = 0;
  const ghBudget = { remaining: MAX_GH_PER_TICK };

  for (const run of runs) {
    const scorable: ScorableRun = {
      id: run.id,
      agent_slug: run.agent_slug,
      status: run.status,
      output_text: run.output_text,
      error: null,
      model_used: null,
      cost_usd: null,
      tool_calls: null,
    };
    const baseQuality: RunQuality = {
      score: run.quality_score ?? 100,
      rationale: run.quality_rationale ?? "",
      model: run.quality_model ?? JUDGE_MODEL,
    };

    let outcome: GroundOutcome;
    try {
      outcome = await maybeGroundNegativeExistence(scorable, baseQuality, ghBudget, logger);
    } catch (e) {
      skipped++;
      logger.warn(`neg-existence-ground: run ${run.id} threw: ${(e as Error).message}`);
      continue;
    }

    if (outcome.outcome === "skip") {
      skipped++;
      continue;
    }

    try {
      await persistGrounded(run.id, outcome.quality, outcome.evidence);
      grounded++;
      if (outcome.quality) clamped++;
    } catch (e) {
      skipped++;
      logger.warn(`neg-existence-ground: persist run ${run.id} failed: ${(e as Error).message}`);
    }
  }

  logger.info(
    `neg-existence-ground: candidates=${runs.length} grounded=${grounded} clamped=${clamped} skipped=${skipped}`,
  );
  return { enabled: true, candidates: runs.length, grounded, clamped, skipped };
}

async function persistGrounded(
  runId: string,
  quality?: RunQuality,
  evidence?: NegativeExistenceEvidence,
): Promise<void> {
  const update: Record<string, unknown> = {
    quality_grounded_at: new Date().toISOString(),
  };
  if (quality) {
    update.quality_score = quality.score;
    update.quality_rationale = quality.rationale;
    update.quality_model = quality.model;
  }
  if (evidence) update.quality_evidence = evidence;
  const { error } = await serviceClient()
    .from("agent_runs")
    .update(update)
    .eq("id", runId)
    .is("quality_grounded_at", null);
  if (error) throw new Error(`persistGrounded ${runId}: ${error.message}`);
}

async function persist(
  runId: string,
  q: RunQuality,
  evidence?: NegativeExistenceEvidence,
): Promise<void> {
  const update: Record<string, unknown> = {
    quality_score: q.score,
    quality_rationale: q.rationale,
    quality_model: q.model,
    quality_scored_at: new Date().toISOString(),
  };
  if (evidence) update.quality_evidence = evidence;
  const { error } = await serviceClient()
    .from("agent_runs")
    .update(update)
    .eq("id", runId);
  if (error) throw new Error(`persist score ${runId}: ${error.message}`);
}

async function persistSkipped(
  runId: string,
  sentinel: string = SKIP_SENTINEL,
): Promise<void> {
  const { error } = await serviceClient()
    .from("agent_runs")
    .update({
      quality_score: null,
      quality_rationale: null,
      quality_model: sentinel,
      quality_scored_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(`persistSkipped ${runId}: ${error.message}`);
}
