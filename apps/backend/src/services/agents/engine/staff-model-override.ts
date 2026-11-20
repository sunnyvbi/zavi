import { resolveStaffModel, type StaffModel } from "@/services/llm/staff-model-switch";

export function readStaffModelOverride(payload: unknown): StaffModel | null {
  if (!payload || typeof payload !== "object") return null;
  const key = (payload as { staff_model?: { key?: unknown } }).staff_model?.key;
  return typeof key === "string" ? resolveStaffModel(key) : null;
}
