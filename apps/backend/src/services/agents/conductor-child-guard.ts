
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";

const STOPPED_CONDUCTOR_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "halted"]);

export type ConductorChildGuardClient = { from: (table: string) => unknown };

export function conductorRunIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[BUILD_CONDUCTOR_RUN_ID_KEY];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export async function stoppedConductorReason(
  sb: ConductorChildGuardClient,
  claim: { tenant_id: string; payload: unknown },
): Promise<string | null> {
  const conductorRunId = conductorRunIdOf(claim.payload);
  if (!conductorRunId || !claim.tenant_id) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = (await (sb.from("conductor_runs") as any)
      .select("status")
      .eq("id", conductorRunId)
      .eq("tenant_id", claim.tenant_id)
      .maybeSingle()) as { data: { status?: string | null } | null; error: { message: string } | null };
    if (error || !data) return null;
    const status = typeof data.status === "string" ? data.status : "";
    return STOPPED_CONDUCTOR_STATUSES.has(status)
      ? `conductor_stopped: the build this run belongs to is ${status}, so the run was not started`
      : null;
  } catch {
    return null;
  }
}
