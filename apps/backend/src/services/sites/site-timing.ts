import { logEvent } from "@/services/logging/logEvent";
import { getBoolSetting } from "@/services/settings";
import type { SiteDeployTimingRow } from "./site-deploy";

async function timingOn(tenant_id: string): Promise<boolean> {
  try {
    return (await getBoolSetting("site_edit_timing_log", tenant_id)) === true;
  } catch {
    return false;
  }
}

export async function logSiteDeployTiming(row: SiteDeployTimingRow): Promise<void> {
  if (!(await timingOn(row.tenant_id))) return;
  const migrations = row.migrations_ms === null ? "skipped" : `${row.migrations_ms}ms`;
  await logEvent({
    level: "info",
    source: "sites.deploy",
    code: "site_deploy_timing",
    tenant_id: row.tenant_id,
    run_id: row.conductor_run_id,
    message: `site=${row.site_id} migrations=${migrations} stage=${row.stage_ms}ms gate=${row.gate}:${row.gate_ms}ms activate=${row.activate_ms}ms total=${row.total_ms}ms`,
    meta: { ms: row.total_ms, build_stage: "site_deploy", gate_verdict: row.gate },
  });
}

export async function logSiteEditTiming(input: {
  tenant_id: string;
  site_id: string;
  conductor_run_id: string;
  refine_requested_at: string;
  now?: () => number;
}): Promise<void> {
  const requested = Date.parse(input.refine_requested_at);
  if (!Number.isFinite(requested)) return;
  if (!(await timingOn(input.tenant_id))) return;
  const ms = Math.max(0, (input.now ?? Date.now)() - requested);
  await logEvent({
    level: "info",
    source: "sites.deploy",
    code: "site_edit_timing",
    tenant_id: input.tenant_id,
    run_id: input.conductor_run_id,
    message: `site=${input.site_id} request_to_live=${ms}ms`,
    meta: { ms, build_stage: "site_edit" },
  });
}
