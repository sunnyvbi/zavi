
import { hashRoutineSpecMaybe } from "./routine-spec-hash";

export interface RoutinePinRow {
  id: string;
  status: string;
  routine_spec: unknown;
  approved_spec_hash: string | null;
}

export type RoutinePinDecision =
  | { action: "pin"; hash: string }
  | { action: "skip"; reason: "not_approved" | "already_pinned" }
  | { action: "leave_null"; reason: "spec_does_not_validate" };

export function decideRoutinePin(row: RoutinePinRow): RoutinePinDecision {
  if (row.status !== "approved") return { action: "skip", reason: "not_approved" };
  if (row.approved_spec_hash) return { action: "skip", reason: "already_pinned" };

  const hash = hashRoutineSpecMaybe(row.routine_spec);
  if (hash === null) return { action: "leave_null", reason: "spec_does_not_validate" };
  return { action: "pin", hash };
}
