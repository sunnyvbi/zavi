import type { OperatorDbType } from "@/services/tools/operator-db/types";
import type { WriteCapable } from "./discovery/privilege";

export type ReadOnlyCheck = "verified" | "can_write" | "unknown";

export function readOnlyCheckOf(type: OperatorDbType, write: WriteCapable): ReadOnlyCheck {
  if (type !== "postgres" && type !== "mysql") return "unknown";
  return write === "false" ? "verified" : write === "true" ? "can_write" : "unknown";
}

