import type { SupabaseClient } from "@supabase/supabase-js";
import { readStaffModelOverride } from "@/services/agents/engine/staff-model-override";
import { isTenantOwnerOrAdmin, checkStaffModelCap } from "@/services/auth/staff-model-access";

export type StaffModelExecGate = { ok: true } | { ok: false; reason: string };

export async function checkStaffModelAtExecution(
  db: SupabaseClient,
  tenantId: string,
  payload: unknown,
): Promise<StaffModelExecGate> {
  if (!readStaffModelOverride(payload)) return { ok: true };
  const by = (payload as { staff_model?: { by?: unknown } }).staff_model?.by;
  if (typeof by !== "string" || by.length === 0) return { ok: false, reason: "no authorizing user on the run" };
  try {
    if (!(await isTenantOwnerOrAdmin(db, by, tenantId))) return { ok: false, reason: "no longer an owner or admin of this company" };
  } catch (e) {
    return { ok: false, reason: `access check unavailable: ${(e as Error).message}` };
  }
  const cap = await checkStaffModelCap(db);
  if (!cap.ok) return { ok: false, reason: `daily ?model= test cap reached ($${cap.cap})` };
  return { ok: true };
}
