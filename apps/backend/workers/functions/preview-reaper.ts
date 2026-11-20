
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { pauseSandbox } from "@/services/sandbox/e2b-client";
import {
  decidePreviewIdleReap,
  loadBusyTenants,
  type SandboxReapRow,
  type PreviewReapDecision,
} from "./infra-reaper";
import { engineerPreviewGloballyEnabled } from "@/services/sandbox/engineer-preview";

export function isSandboxGoneError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return (
    /not\s*found/.test(msg) ||
    msg.includes("404") ||
    msg.includes("does not exist") ||
    msg.includes("no longer exists") ||
    msg.includes("already killed") ||
    msg.includes("was not found")
  );
}

export const PREVIEW_HARD_CEILING_MIN = 60;
export const PREVIEW_STARTING_TTL_MIN = 5;
const MAX_PER_RUN = 100;

export function decideEngineerPreviewReap(
  row: SandboxReapRow & {
    preview_run_id?: string | null;
    preview_started_at?: string | null;
  },
  now: number,
): PreviewReapDecision {
  const base = { row_id: row.id, e2b_sandbox_id: row.e2b_sandbox_id };
  if (!row.preview_run_id) {
    return { ...base, reap: false, reason: "not_engineer_preview" };
  }
  if (row.preview_status === "starting") {
    const anchor = row.preview_started_at ?? row.updated_at;
    const ageMs = now - new Date(anchor).getTime();
    if (ageMs > PREVIEW_STARTING_TTL_MIN * 60 * 1000) {
      return { ...base, reap: true, reason: `stuck_starting_${PREVIEW_STARTING_TTL_MIN}min` };
    }
    return { ...base, reap: false, reason: "starting_recent" };
  }
  if (row.preview_status === "live") {
    const idle = decidePreviewIdleReap(row, now);
    if (idle.reap) return idle;
    const ceilAnchor = row.preview_started_at ?? row.updated_at;
    const ageMs = now - new Date(ceilAnchor).getTime();
    if (ageMs > PREVIEW_HARD_CEILING_MIN * 60 * 1000) {
      return { ...base, reap: true, reason: `hard_ceiling_${PREVIEW_HARD_CEILING_MIN}min` };
    }
    return { ...base, reap: false, reason: "live_within_limits" };
  }
  return { ...base, reap: false, reason: `status_${row.preview_status ?? "none"}` };
}

export async function sweepEngineerPreviews(
  dryRun: boolean,
  logger: { info: (m: string) => void },
): Promise<{ candidates: number; reaped: number; errors: number }> {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("tenant_sandbox")
    .select(
      "id, tenant_id, repo_full_name, e2b_sandbox_id, status, updated_at, preview_status, preview_last_viewed_at, preview_started_at, preview_run_id",
    )
    .not("preview_run_id", "is", null)
    .in("preview_status", ["live", "starting"])
    .limit(1000);
  if (error) {
    logger.info(`preview-reaper: select failed: ${error.message}`);
    return { candidates: 0, reaped: 0, errors: 1 };
  }
  const now = Date.now();
  const due = ((rows ?? []) as Array<
    SandboxReapRow & { preview_started_at?: string | null; preview_run_id?: string | null }
  >)
    .map((row) => ({ row, d: decideEngineerPreviewReap(row, now) }))
    .filter(({ d }) => d.reap);
  const busyTenants = await loadBusyTenants(
    sb,
    [...new Set(due.map(({ row }) => row.tenant_id).filter((x): x is string => !!x))],
  );
  const toReap = due
    .filter(({ row }) => !row.tenant_id || !busyTenants.has(row.tenant_id))
    .map(({ d }) => d)
    .slice(0, MAX_PER_RUN);

  let reaped = 0;
  let errors = 0;
  for (const d of toReap) {
    logger.info(
      `preview-reaper: ${dryRun ? "DRY would reap" : "reaping"} engineer preview row=${d.row_id} reason=${d.reason}`,
    );
    if (dryRun) continue;
    try {
      if (d.e2b_sandbox_id) {
        try {
          await pauseSandbox(d.e2b_sandbox_id);
        } catch (pauseErr) {
          if (!isSandboxGoneError(pauseErr)) throw pauseErr;
          logger.info(
            `preview-reaper: sandbox ${d.e2b_sandbox_id} already gone for row ${d.row_id} — expiring anyway (nothing to leak)`,
          );
        }
      }

      await sb.rpc("expire_engineer_sandbox_preview", {
        p_id: d.row_id,
        p_reason: d.reason,
      });
      reaped += 1;
    } catch (e) {
      errors += 1;
      logger.info(`preview-reaper: reap ${d.row_id} failed: ${(e as Error).message}`);
    }
  }
  return { candidates: toReap.length, reaped, errors };
}

export const previewReaperFn = inngest.createFunction(
  { id: "preview-reaper", concurrency: { limit: 1, key: '"global"' } },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const r = await sweepEngineerPreviews(false, logger);
    logger.info(
      `preview-reaper: ${r.reaped}/${r.candidates} engineer previews reaped · errors=${r.errors}`,
    );
    return { ok: true, ...r };
  },
);
