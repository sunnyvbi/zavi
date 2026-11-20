
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

export type ResourceStateRow = {
  resource_kind: string;
  mode: string;
  status: string;
  provider: string | null;
  last_error: string | null;
  updated_at: string;
};

export type ReconcileSummary = {
  total: number;
  byStatus: Record<string, number>;
  pending: Array<{ kind: string; provider: string | null }>;
  failed: Array<{ kind: string; error: string | null }>;
  stuck: Array<{ kind: string; updated_at: string }>;
};

const STUCK_MS = 30 * 60 * 1000;

export function summarizeResourceStates(rows: ResourceStateRow[], now: number = Date.now()): ReconcileSummary {
  const summary: ReconcileSummary = { total: rows.length, byStatus: {}, pending: [], failed: [], stuck: [] };
  for (const r of rows) {
    summary.byStatus[r.status] = (summary.byStatus[r.status] ?? 0) + 1;
    if (r.status === "pending") summary.pending.push({ kind: r.resource_kind, provider: r.provider });
    else if (r.status === "failed") summary.failed.push({ kind: r.resource_kind, error: r.last_error });
    else if (r.status === "provisioning" && now - new Date(r.updated_at).getTime() > STUCK_MS) {
      summary.stuck.push({ kind: r.resource_kind, updated_at: r.updated_at });
    }
  }
  return summary;
}

export const provisioningReconcileFn = inngest.createFunction(
  { id: "provisioning-reconcile", concurrency: 1 },
  { cron: "17 * * * *" },
  async ({ logger }) => {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("resource_kind, mode, status, provider, last_error, updated_at")
      .not("status", "in", "(ready,torn_down)")
      .limit(1000);
    if (error) {
      logger.error(`provisioning-reconcile: select failed: ${error.message}`);
      return { error: error.message };
    }
    const summary = summarizeResourceStates((data ?? []) as ResourceStateRow[]);
    if (summary.total > 0) {
      logger.info(
        `provisioning-reconcile: ${summary.total} unsettled — ` +
          `${summary.pending.length} pending-creds, ${summary.failed.length} failed, ${summary.stuck.length} stuck`,
      );
    }
    return summary;
  },
);
