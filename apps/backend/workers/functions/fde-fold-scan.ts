
import { inngest } from "../client";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { proposeFoldCandidates, type FoldSourceEvent } from "@/services/readiness/fold-distill";
import type { TenantIdentity } from "@/services/readiness/fold-guards";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

export async function runFdeFoldScan(logger: {
  info: (m: string) => void;
  warn: (m: string) => void;
}): Promise<{
  unfolded_events: number;
  candidates_written: number;
  rejected_groups: number;
}> {
  const svc = staffCrossTenantClient(
    "P3 training loop: cluster FDE rescues across tenants into proposed fleet lessons",
  );

  const { data: events, error: eErr } = await svc
    .from("fde_training_events")
    .select("id, tenant_id, gap_dimension, action_kind, agent_training_hint, before_score, after_score")
    .eq("folded_into_prompt", false)
    .order("created_at", { ascending: true });
  if (eErr) throw new Error(`fde-fold-scan events read failed: ${eErr.message}`);

  const rows = (events ?? []) as FoldSourceEvent[];
  if (rows.length === 0) {
    logger.info("[fde-fold-scan] no unfolded rescues — nothing to learn this week");
    return { unfolded_events: 0, candidates_written: 0, rejected_groups: 0 };
  }

  const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
  const { data: tenantRows, error: tErr } = await svc
    .from("tenants")
    .select("id, slug, display_name, company_shape, product_url")
    .in("id", tenantIds);
  if (tErr) throw new Error(`fde-fold-scan tenant read failed: ${tErr.message}`);

  const tenants = new Map<string, TenantIdentity>();
  for (const t of (tenantRows ?? []) as Array<{
    id: string;
    slug: string;
    display_name: string | null;
    company_shape: string | null;
    product_url: Record<string, string> | null;
  }>) {
    tenants.set(t.id, {
      tenant_id: t.id,
      slug: t.slug,
      display_name: t.display_name,
      company_shape: t.company_shape,
      product_host: hostOf(t.product_url?.marketing ?? t.product_url?.api ?? null),
    });
  }

  const { candidates, rejections } = proposeFoldCandidates(rows, tenants);

  for (const r of rejections) {
    logger.info(`[fde-fold-scan] not folded (${r.reason}) [${r.gap_dimension}/${r.action_kind}]: ${r.detail}`);
  }

  let written = 0;
  for (const c of candidates) {
    const { data: existing } = await svc
      .from("fde_fold_candidate")
      .select("id")
      .eq("status", "proposed")
      .eq("pattern_summary", c.pattern_summary)
      .maybeSingle();
    if (existing) continue;

    const { error: iErr } = await svc.from("fde_fold_candidate").insert({
      pattern_summary: c.pattern_summary,
      gap_dimension: c.gap_dimension,
      target_agent_slug: c.target_agent_slug,
      source_event_ids: c.source_event_ids,
      source_tenant_count: c.source_tenant_count,
      conflict_of_interest: c.conflict_of_interest,
      conflict_detail: c.conflict_detail,
      tenant_fact_check: c.tenant_fact_check,
      eval_status: "unmeasured",
      status: "proposed",
    });
    if (iErr) {
      logger.warn(`[fde-fold-scan] candidate insert failed: ${iErr.message}`);
      continue;
    }
    written++;
  }

  logger.info(
    `[fde-fold-scan] ${rows.length} unfolded rescue(s) → ${written} new proposal(s), ${rejections.length} group(s) not ready`,
  );

  return {
    unfolded_events: rows.length,
    candidates_written: written,
    rejected_groups: rejections.length,
  };
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const fdeFoldScanFn = inngest.createFunction(
  { id: "fde-fold-scan", concurrency: 1 },
  { cron: "17 7 * * 1" },
  async ({ logger }) => {
    if (isWorkerCronStopped("fde-fold-scan")) {
      logger.info("fde-fold-scan: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    return runFdeFoldScan(logger);
  },
);
