import { isDbToolName } from "@zavi/shared/db-guard";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { rawResultsRetention, type RawResultsRetention } from "./settings";

export function scrubDbPreviews<T extends { name: string; output_preview?: string }>(calls: T[]): T[] {
  return calls.map((tc) => (isDbToolName(tc.name) ? { ...tc, output_preview: "", output_removed: "privacy_setting" } : tc));
}

export type RunEndDeps = {
  retention: (tenant_id: string) => Promise<RawResultsRetention | null>;
  deleteCheckpoints: (tenant_id: string, run_id: string) => Promise<void>;
};

const realDeps: RunEndDeps = {
  retention: rawResultsRetention,
  async deleteCheckpoints(tenant_id, run_id) {
    const { error } = await tenantClient(asTenantId(tenant_id)).from("agent_run_checkpoints").delete().eq("run_id", run_id);
    if (error) throw new Error(error.message);
  },
};

export const RUN_END_STATUSES: ReadonlySet<string> = new Set(["success", "parse_failed", "error", "failed", "cancelled", "dispatch_error"]);

export async function scrubPreviewsForRunEnd<T extends { name: string; output_preview?: string }>(
  tenant_id: string | null | undefined,
  calls: T[],
  deps: Pick<RunEndDeps, "retention"> = realDeps,
): Promise<{ calls: T[]; deleteCheckpoints: boolean }> {
  if (!calls.some((c) => isDbToolName(c.name))) return { calls, deleteCheckpoints: false };
  if (!tenant_id) return { calls: scrubDbPreviews(calls), deleteCheckpoints: false };
  let retention: RawResultsRetention | null;
  try {
    retention = await deps.retention(tenant_id);
  } catch {
    return { calls: scrubDbPreviews(calls), deleteCheckpoints: false };
  }
  if (retention !== "run") return { calls, deleteCheckpoints: false };
  return { calls: scrubDbPreviews(calls), deleteCheckpoints: true };
}

export async function deleteCheckpointsAtRunEnd(
  tenant_id: string | null | undefined,
  run_id: string,
  status: string | null | undefined,
  deps: Pick<RunEndDeps, "deleteCheckpoints"> = realDeps,
): Promise<boolean> {
  if (!tenant_id || !status || !RUN_END_STATUSES.has(status)) return false;
  try {
    await deps.deleteCheckpoints(tenant_id, run_id);
    return true;
  } catch (e) {
    console.warn(`[data-gateway] run-end checkpoint delete failed for run ${run_id}: ${(e as Error).message}`);
    return false;
  }
}
