import { resolveStaffModel } from "@/services/llm/staff-model-switch";
import type { CapResult } from "@/services/auth/staff-model-access";

export class StaffModelCapError extends Error {
  readonly code = "staff_model_cap";
  constructor(public spent: number, public cap: number) {
    super("staff_model_cap");
    this.name = "StaffModelCapError";
  }
}

export const STAFF_MODEL_CAP_MESSAGE =
  "Daily ?model= test cap reached. This handoff was not started; do not retry today.";

export async function inheritStaffModel(
  input: { payload: Record<string, unknown> | null | undefined; parent_run_id: string | null | undefined; tenant_id: string },
  deps: { readParentPayload: (runId: string, tenantId: string) => Promise<unknown>; checkCap: () => Promise<CapResult> },
): Promise<{ payload: Record<string, unknown> | null | undefined }> {
  if (!input.parent_run_id) return { payload: input.payload };
  let parent: unknown;
  try {
    parent = await deps.readParentPayload(input.parent_run_id, input.tenant_id);
  } catch (e) {
    console.warn(`[staff-model] parent payload read failed, child stays default: ${(e as Error).message}`);
    return { payload: input.payload };
  }
  const sm = (parent as { staff_model?: { key?: unknown; by?: unknown } } | null)?.staff_model;
  const key = sm?.key;
  if (typeof key !== "string" || !resolveStaffModel(key)) return { payload: input.payload };
  const cap = await deps.checkCap();
  if (!cap.ok) throw new StaffModelCapError(cap.spent, cap.cap);
  const by = typeof sm?.by === "string" ? sm.by : undefined;
  return { payload: { ...(input.payload ?? {}), staff_model: by ? { key, by } : { key } } };
}
