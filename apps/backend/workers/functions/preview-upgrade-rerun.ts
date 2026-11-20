
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { PREVIEW_RUN_KEY_PREFIX } from "@/services/billing/tiers";
import { PREVIEW_DONE_KEY_PREFIX, rerunPreviewsOnUpgrade } from "@/services/growth/preview-upgrade";

export async function tenantOfPreviewRun(run_id: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id, cron_dedupe_key")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`preview run read failed: ${error.message}`);
  const row = data as { tenant_id: string | null; cron_dedupe_key: string | null } | null;
  if (!row?.tenant_id || !row.cron_dedupe_key) return null;
  const ok =
    row.cron_dedupe_key.startsWith(`${PREVIEW_RUN_KEY_PREFIX}${row.tenant_id}:`) ||
    row.cron_dedupe_key.startsWith(`${PREVIEW_DONE_KEY_PREFIX}${row.tenant_id}:`);
  return ok ? row.tenant_id : null;
}

export const PREVIEW_UPGRADE_RERUN_C8reverified = true;

export const previewUpgradeRerunFn = inngest.createFunction(
  {
    id: "preview-upgrade-rerun",
    retries: 6,
    concurrency: { key: "event.data.tenant_id", limit: 1 },
  },
  { event: "growth.preview_upgrade.requested" },
  async ({ event, step }) => {
    const run_id = event.data.run_id;
    if (!run_id) return { started: [], skipped: "no_run" };
    const tenant_id = await step.run("resolve-tenant", () => tenantOfPreviewRun(run_id));
    if (!tenant_id) return { started: [], skipped: "not_a_preview_run" };
    const started = await step.run("rerun-previews", () => rerunPreviewsOnUpgrade(tenant_id));
    return { started };
  },
);
