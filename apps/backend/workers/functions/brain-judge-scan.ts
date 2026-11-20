
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { computeReadiness } from "@/services/readiness/compute";
import { promoteDiscoveryDraft, isCanonicalSlug } from "@/services/readiness/promote-draft";
import { judgeDraft, type CitedSource, type DraftToJudge, type JudgeVerdict } from "@/services/readiness/judge-draft";
import { PRIVATE_NOTE_TYPES_PGREST_IN } from "@/services/memory";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

const MAX_DRAFTS_PER_SCAN = 40;

export interface DraftRow {
  tenant_id: string;
  slug: string;
  body_markdown: string | null;
  metadata: Record<string, unknown> | null;
}

function citedSourcesOf(metadata: Record<string, unknown> | null): CitedSource[] {
  const disc = (metadata?.discovery ?? {}) as Record<string, unknown>;
  const raw = disc.cited_sources;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({ url: String(s.url ?? ""), note: typeof s.note === "string" ? s.note : null }))
    .filter((s) => s.url.length > 0);
}

export function gateFor(
  blob: Record<string, unknown>,
): { enabled: boolean; allowlist: string[] } {
  if (blob.brain_judge_autopromote_enabled === false) return { enabled: false, allowlist: [] };
  const allow = blob.brain_judge_autopromote_tenants;
  const allowlist = Array.isArray(allow) ? allow.filter((x): x is string => typeof x === "string") : [];
  return { enabled: true, allowlist };
}

export interface BrainJudgeDeps {
  judge: (d: DraftToJudge) => Promise<JudgeVerdict>;
  promote: typeof promoteDiscoveryDraft;
  recompute: (tenant_id: string) => Promise<unknown>;
  log: typeof logEvent;
}

export interface ScanResult {
  judged: number;
  promoted: number;
  held: number;
  skipped_noncanonical: number;
  errors: number;
  tenants_touched: string[];
}

export async function runBrainJudgeScan(drafts: DraftRow[], deps: BrainJudgeDeps): Promise<ScanResult> {
  const res: ScanResult = { judged: 0, promoted: 0, held: 0, skipped_noncanonical: 0, errors: 0, tenants_touched: [] };
  const touched = new Set<string>();

  for (const row of drafts) {
    const canonicalSlug = row.slug.replace(/__inferred$/, "");
    if (!isCanonicalSlug(canonicalSlug)) {
      res.skipped_noncanonical++;
      continue;
    }

    try {
      const draft: DraftToJudge = {
        slug: canonicalSlug,
        body_markdown: row.body_markdown ?? "",
        cited_sources: citedSourcesOf(row.metadata),
      };

      const verdict = await deps.judge(draft);
      res.judged++;

      if (verdict.verdict !== "promote") {
        res.held++;
        await deps.log({
          level: "info",
          source: "brain-judge-scan",
          code: "brain_judge.hold",
          tenant_id: row.tenant_id,
          meta: { slug: canonicalSlug, reason: verdict.reason },
        });
        continue;
      }

      const result = await deps.promote({
        tenant_id: row.tenant_id,
        slug: canonicalSlug,
        via: "judge",
        judge_reason: verdict.reason,
      });

      if (result.ok) {
        res.promoted++;
        touched.add(row.tenant_id);
        await deps.log({
          level: "info",
          source: "brain-judge-scan",
          code: "brain_judge.promote",
          tenant_id: row.tenant_id,
          meta: { slug: canonicalSlug, reason: verdict.reason },
        });
      } else if (result.code === "render_failed") {
        res.errors++;
        await deps.log({
          level: "warn",
          source: "brain-judge-scan",
          code: "brain_judge.promote_render_failed",
          tenant_id: row.tenant_id,
          meta: { slug: canonicalSlug, code: result.code },
        });
      } else {
        res.held++;
        await deps.log({
          level: "info",
          source: "brain-judge-scan",
          code: "brain_judge.promote_refused",
          tenant_id: row.tenant_id,
          meta: { slug: canonicalSlug, code: result.code },
        });
      }
    } catch (e) {
      res.errors++;
      try {
        await deps.log({
          level: "warn",
          source: "brain-judge-scan",
          code: "brain_judge.draft_error",
          tenant_id: row.tenant_id,
          error: e,
          meta: { slug: canonicalSlug },
        });
      } catch {
      }
    }
  }

  for (const tenant_id of touched) {
    try {
      await deps.recompute(tenant_id);
    } catch (e) {
      await deps.log({
        level: "warn",
        source: "brain-judge-scan",
        code: "brain_judge.recompute_failed",
        tenant_id,
        error: e,
      });
    }
  }
  res.tenants_touched = [...touched];
  return res;
}

export const brainJudgeScanFn = inngest.createFunction(
  { id: "brain-judge-scan", concurrency: 1 },
  { cron: "30 7 * * *" },
  async ({ logger }) => {
    if (isWorkerCronStopped("brain-judge-scan")) {
      logger.info("brain-judge-scan: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const svc = serviceClient();

    const { data: cfg, error: cfgErr } = await svc
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (cfgErr) {
      logger.error(`brain-judge-scan: system_config read failed, disabling this run: ${cfgErr.message}`);
      return { disabled: true, reason: "config_read_failed" };
    }
    const gate = gateFor((cfg?.blob ?? {}) as Record<string, unknown>);
    if (!gate.enabled) {
      logger.info("brain-judge-scan: disabled by kill switch");
      return { disabled: true };
    }

    let q = svc
      .from("memory_note")
      .select("tenant_id, slug, body_markdown, metadata")
      .eq("source", "agent_discovery_inferred")
      .not("note_type", "in", PRIVATE_NOTE_TYPES_PGREST_IN)
      .is("superseded_by", null)
      .limit(MAX_DRAFTS_PER_SCAN);
    if (gate.allowlist.length > 0) q = q.in("tenant_id", gate.allowlist);

    const { data: drafts, error } = await q;
    if (error) throw new Error(`brain-judge-scan draft read failed: ${error.message}`);

    const result = await runBrainJudgeScan((drafts ?? []) as DraftRow[], {
      judge: judgeDraft,
      promote: promoteDiscoveryDraft,
      recompute: computeReadiness,
      log: logEvent,
    });

    logger.info(
      `brain-judge-scan: judged ${result.judged}, promoted ${result.promoted}, held ${result.held}, ` +
        `skipped ${result.skipped_noncanonical}, tenants ${result.tenants_touched.length}`,
    );
    return result;
  },
);
