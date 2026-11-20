
import { isRoutableRoutineStepTool } from "./tool-name";
import { ROUTINE_SPEC_CURRENT_VERSION } from "./routine-spec";
import { createHash } from "node:crypto";

export const DISTILL_ROUTINE_ENV_FLAG = "PRAXIS_DISTILL_ROUTINE_CANDIDATE_ENABLED";

export function distillRoutineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISTILL_ROUTINE_ENV_FLAG] !== "0";
}

export const LOOKBACK_DAYS = 30;
export const SCAN_PAGE_SIZE = 2000;
export const MIN_OCCURRENCES = 3;
export const MIN_SEQUENCE_STEPS = 2;
export const MAX_SEQUENCE_STEPS = 32;
export const MAX_PROVENANCE_RUN_IDS = 20;
export const MAX_CANDIDATES_PER_PASS = 25;

type ToolCallLite = { name?: unknown; status?: unknown };

export interface DistillRunRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  grounding_flags: Array<{ severity?: string }> | null;
  tool_calls: ToolCallLite[] | null;
}

export interface CandidateInsert {
  tenant_id: string;
  agent_slug: string;
  routine_name: string;
  routine_spec: { type: "tool_sequence"; steps: Array<{ tool: string; args: Record<string, unknown> }> };
  spec_version: number;
  granted_tool_names: string[];
  provenance: Record<string, unknown>;
  source_note_id: null;
  source_note_ids: string[];
  status: "candidate";
  founder_blessed: false;
  faithfulness_clean: true;
}

export interface DistillRoutineDeps {
  readSuccessfulRuns: (sinceIso: string, limit: number) => Promise<DistillRunRow[]>;
  signatureExists: (tenant_id: string, agent_slug: string, signature: string) => Promise<boolean>;
  insertCandidate: (row: CandidateInsert) => Promise<void>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  logger?: { warn: (m: string) => void; info?: (m: string) => void };
}

export interface DistillRoutineStats {
  enabled: boolean;
  runs_scanned: number;
  faithfulness_clean_runs: number;
  groups_considered: number;
  candidates_staged: number;
  skipped_existing: number;
  insert_failures: number;
}

export function isFaithfulnessClean(grounding_flags: DistillRunRow["grounding_flags"]): boolean {
  if (!grounding_flags || grounding_flags.length === 0) return true;
  return !grounding_flags.some((f) => f?.severity === "hard");
}

export function extractRoutableSequence(tool_calls: DistillRunRow["tool_calls"]): string[] {
  if (!Array.isArray(tool_calls)) return [];
  const out: string[] = [];
  for (const tc of tool_calls) {
    if (!tc || tc.status !== "ok") continue;
    const name = typeof tc.name === "string" ? tc.name : "";
    if (!name) continue;
    if (!isRoutableRoutineStepTool(name)) continue;
    out.push(name);
  }
  return out;
}

export function signatureForSequence(sequence: string[]): string {
  const canonical = sequence.join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

interface GroupAccumulator {
  tenant_id: string;
  agent_slug: string;
  sequence: string[];
  signature: string;
  run_ids: string[];
}

export async function distillRoutineCandidates(
  deps: DistillRoutineDeps,
): Promise<DistillRoutineStats> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? { warn: () => {} };
  const stats: DistillRoutineStats = {
    enabled: false,
    runs_scanned: 0,
    faithfulness_clean_runs: 0,
    groups_considered: 0,
    candidates_staged: 0,
    skipped_existing: 0,
    insert_failures: 0,
  };

  if (!distillRoutineEnabled(env)) {
    return stats;
  }
  stats.enabled = true;

  let runs: DistillRunRow[];
  try {
    const sinceIso = new Date(now().getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
    runs = await deps.readSuccessfulRuns(sinceIso, SCAN_PAGE_SIZE);
  } catch (e) {
    logger.warn(`[distill-routine] run scan failed: ${(e as Error).message}`);
    return stats;
  }
  stats.runs_scanned = runs.length;

  const groups = new Map<string, GroupAccumulator>();
  for (const run of runs) {
    if (run.status !== "success") continue;
    if (!isFaithfulnessClean(run.grounding_flags)) continue;
    stats.faithfulness_clean_runs += 1;

    const sequence = extractRoutableSequence(run.tool_calls);
    if (sequence.length < MIN_SEQUENCE_STEPS) continue;
    if (sequence.length > MAX_SEQUENCE_STEPS) continue;

    const signature = signatureForSequence(sequence);
    const key = `${run.tenant_id}::${run.agent_slug}::${signature}`;
    const existing = groups.get(key);
    if (existing) {
      existing.run_ids.push(run.id);
    } else {
      groups.set(key, {
        tenant_id: run.tenant_id,
        agent_slug: run.agent_slug,
        sequence,
        signature,
        run_ids: [run.id],
      });
    }
  }

  for (const g of groups.values()) {
    if (stats.candidates_staged >= MAX_CANDIDATES_PER_PASS) break;
    if (g.run_ids.length < MIN_OCCURRENCES) continue;
    stats.groups_considered += 1;

    let already: boolean;
    try {
      already = await deps.signatureExists(g.tenant_id, g.agent_slug, g.signature);
    } catch (e) {
      logger.warn(`[distill-routine] signatureExists failed for ${g.tenant_id}/${g.agent_slug}: ${(e as Error).message}`);
      stats.insert_failures += 1;
      continue;
    }
    if (already) {
      stats.skipped_existing += 1;
      continue;
    }

    const occurrences = g.run_ids.length;
    const grantedToolNames = Array.from(new Set(g.sequence));
    const seqDisplay = g.sequence.join(" → ").slice(0, 160);
    const row: CandidateInsert = {
      tenant_id: g.tenant_id,
      agent_slug: g.agent_slug,
      routine_name: `${g.agent_slug}: ${seqDisplay} (${occurrences} successful runs)`.slice(0, 240),
      routine_spec: {
        type: "tool_sequence",
        steps: g.sequence.map((tool) => ({ tool, args: {} })),
      },
      spec_version: ROUTINE_SPEC_CURRENT_VERSION,
      granted_tool_names: grantedToolNames,
      provenance: {
        kind: "auto_distill_trajectory",
        distill_signature: g.signature,
        occurrence_count: occurrences,
        source_run_ids: g.run_ids.slice(0, MAX_PROVENANCE_RUN_IDS),
        distilled_at: now().toISOString(),
      },
      source_note_id: null,
      source_note_ids: [],
      status: "candidate",
      founder_blessed: false,
      faithfulness_clean: true,
    };

    try {
      await deps.insertCandidate(row);
      stats.candidates_staged += 1;
    } catch (e) {
      stats.insert_failures += 1;
      logger.warn(`[distill-routine] insert failed for ${g.tenant_id}/${g.agent_slug}: ${(e as Error).message}`);
    }
  }

  return stats;
}
