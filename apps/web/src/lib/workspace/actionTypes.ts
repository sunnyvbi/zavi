
import { ACTION_TYPES, type ActionType } from "@zavi/shared";

export { ACTION_TYPES };
export type { ActionType };

export function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}
