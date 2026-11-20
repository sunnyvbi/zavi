
import { logEvent } from "@/services/logging/logEvent";
import type { Check, CheckStatus } from "./run";

const STATUS_TO_LEVEL: Record<CheckStatus, "info" | "warn" | "error"> = {
  ok: "info",
  warn: "warn",
  fail: "error",
  skip: "info",
};

export async function logDoctorChecks(
  checks: ReadonlyArray<Check>,
  source: "praxis-doctor.cli" | "praxis-doctor.cron",
): Promise<void> {
  for (const c of checks) {
    await logEvent({
      level: STATUS_TO_LEVEL[c.status],
      source,
      code: `doctor.${c.name}`,
      message: c.detail,
      meta: c.meta,
    });
  }
}
