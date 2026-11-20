
import { createHash } from "node:crypto";
import { extractRoutableSequence, isFaithfulnessClean, type DistillRunRow } from "@/services/routines/distill-routine-candidate";

export type { DistillRunRow };

export const SKILL_DISTILL_SETTING_KEY = "memory_skill_distill_enabled" as const;

export const LOOKBACK_DAYS = 30;
export const SCAN_PAGE_SIZE = 2000;
export const MIN_OCCURRENCES = 3;
export const MIN_SEQUENCE_STEPS = 2;
export const MAX_SEQUENCE_STEPS = 32;
export const MAX_PROVENANCE_RUN_IDS = 20;
export const MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS = 25;

export interface SkillCluster {
  tenant_id: string;
  agent_slugs: string[];
  sequence: string[];
  signature: string;
  run_ids: string[];
  occurrences: number;
}

export interface SkillNoteWrite {
  tenant_id: string;
  title: string;
  body_markdown: string;
  source_ref: string;
  metadata: Record<string, unknown>;
}

export interface DistillSkillDeps {
  enabledTenantIds: () => Promise<string[]>;
  readSuccessfulRuns: (sinceIso: string, limit: number, tenantIds: string[]) => Promise<DistillRunRow[]>;
  skillSourceRefExists: (tenant_id: string, source_ref: string) => Promise<boolean>;
  synthesizeProse?: (cluster: SkillCluster) => Promise<{ title: string; body_markdown: string }>;
  writeSkillNote: (note: SkillNoteWrite) => Promise<void>;
  now?: () => Date;
  logger?: { warn: (m: string) => void; info?: (m: string) => void };
}

export interface DistillSkillStats {
  enabled_tenants: number;
  runs_scanned: number;
  faithfulness_clean_runs: number;
  clusters_considered: number;
  synth_write_attempts: number;
  skills_written: number;
  skipped_existing: number;
  write_failures: number;
}

export function signatureForSequence(sequence: string[]): string {
  return createHash("sha256").update(sequence.join("|"), "utf8").digest("hex");
}

export function deterministicSkillProse(cluster: SkillCluster): { title: string; body_markdown: string } {
  const seqDisplay = cluster.sequence.join(" → ");
  const agents = cluster.agent_slugs.join(", ");
  const title = `How we do: ${cluster.sequence.join(" → ")}`.slice(0, 200);
  const body_markdown =
    `# Recurring procedure\n\n` +
    `The fleet has repeated this tool sequence ${cluster.occurrences} times ` +
    `(${cluster.run_ids.length} runs) across these agents: ${agents}.\n\n` +
    `**Steps:** ${seqDisplay}\n\n` +
    `When a similar task comes up, this is the path that has worked here. ` +
    `Auto-distilled from successful runs — an operator can edit, promote, or delete this skill.`;
  return { title, body_markdown };
}

export async function distillSkillCandidates(
  deps: DistillSkillDeps,
): Promise<DistillSkillStats> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? { warn: () => {} };
  const stats: DistillSkillStats = {
    enabled_tenants: 0,
    runs_scanned: 0,
    faithfulness_clean_runs: 0,
    clusters_considered: 0,
    synth_write_attempts: 0,
    skills_written: 0,
    skipped_existing: 0,
    write_failures: 0,
  };

  let enabledTenantIds: string[];
  try {
    enabledTenantIds = await deps.enabledTenantIds();
  } catch (e) {
    logger.warn(`[distill-skill] enabled-tenant resolve failed: ${(e as Error).message}`);
    return stats;
  }
  const enabledSet = new Set(enabledTenantIds.filter((t) => typeof t === "string" && t));
  stats.enabled_tenants = enabledSet.size;
  if (enabledSet.size === 0) return stats;

  let runs: DistillRunRow[];
  try {
    const sinceIso = new Date(now().getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
    runs = await deps.readSuccessfulRuns(sinceIso, SCAN_PAGE_SIZE, Array.from(enabledSet));
  } catch (e) {
    logger.warn(`[distill-skill] run scan failed: ${(e as Error).message}`);
    return stats;
  }
  stats.runs_scanned = runs.length;

  interface Acc {
    tenant_id: string;
    sequence: string[];
    signature: string;
    run_ids: string[];
    agent_slugs: Set<string>;
    occurrences: number;
  }
  const clusters = new Map<string, Acc>();
  for (const run of runs) {
    if (run.status !== "success") continue;
    if (!enabledSet.has(run.tenant_id)) continue;
    if (!isFaithfulnessClean(run.grounding_flags)) continue;
    stats.faithfulness_clean_runs += 1;

    const sequence = extractRoutableSequence(run.tool_calls);
    if (sequence.length < MIN_SEQUENCE_STEPS) continue;
    if (sequence.length > MAX_SEQUENCE_STEPS) continue;

    const signature = signatureForSequence(sequence);
    const key = `${run.tenant_id}::${signature}`;
    const existing = clusters.get(key);
    if (existing) {
      if (existing.run_ids.length < MAX_PROVENANCE_RUN_IDS) existing.run_ids.push(run.id);
      existing.agent_slugs.add(run.agent_slug);
      existing.occurrences += 1;
    } else {
      clusters.set(key, {
        tenant_id: run.tenant_id,
        sequence,
        signature,
        run_ids: [run.id],
        agent_slugs: new Set([run.agent_slug]),
        occurrences: 1,
      });
    }
  }

  for (const c of clusters.values()) {
    if (stats.synth_write_attempts >= MAX_SYNTH_WRITE_ATTEMPTS_PER_PASS) break;
    if (c.occurrences < MIN_OCCURRENCES) continue;

    stats.clusters_considered += 1;
    const source_ref = `skill_distill:${c.signature}`;

    let exists: boolean;
    try {
      exists = await deps.skillSourceRefExists(c.tenant_id, source_ref);
    } catch (e) {
      logger.warn(`[distill-skill] existence check failed for ${c.tenant_id}: ${(e as Error).message}`);
      stats.write_failures += 1;
      continue;
    }
    if (exists) {
      stats.skipped_existing += 1;
      continue;
    }

    stats.synth_write_attempts += 1;

    const cluster: SkillCluster = {
      tenant_id: c.tenant_id,
      agent_slugs: Array.from(c.agent_slugs).sort(),
      sequence: c.sequence,
      signature: c.signature,
      run_ids: c.run_ids.slice(0, MAX_PROVENANCE_RUN_IDS),
      occurrences: c.occurrences,
    };

    let prose = deterministicSkillProse(cluster);
    if (deps.synthesizeProse) {
      try {
        const out = await deps.synthesizeProse(cluster);
        if (out && out.title.trim() && out.body_markdown.trim()) prose = out;
      } catch (e) {
        logger.warn(`[distill-skill] prose synth failed for ${c.tenant_id} (using fallback): ${(e as Error).message}`);
      }
    }

    const note: SkillNoteWrite = {
      tenant_id: c.tenant_id,
      title: prose.title.slice(0, 240),
      body_markdown: prose.body_markdown,
      source_ref,
      metadata: {
        kind: "auto_distill_skill",
        distill_signature: c.signature,
        occurrence_count: c.occurrences,
        agent_slugs: cluster.agent_slugs,
        source_run_ids: cluster.run_ids,
        distilled_at: now().toISOString(),
      },
    };

    try {
      await deps.writeSkillNote(note);
      stats.skills_written += 1;
    } catch (e) {
      stats.write_failures += 1;
      logger.warn(`[distill-skill] write failed for ${c.tenant_id}: ${(e as Error).message}`);
    }
  }

  return stats;
}
