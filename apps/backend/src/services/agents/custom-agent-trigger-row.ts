import { isValidTimeZone, validateCronExpression } from "../../../workers/functions/cron-match";

export const CUSTOM_WATCH_MIN_INTERVAL_MINUTES = 15;

export type CustomTriggerRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  cron: string | null;
  tz: string | null;
  deliver: unknown;
  next_due_at: string | null;
  last_result_summary: string | null;
};

export function triggerScheduleValid(row: { cron: string | null; tz: string | null }): boolean {
  return (
    typeof row.cron === "string" &&
    validateCronExpression(row.cron) === null &&
    typeof row.tz === "string" &&
    row.tz.length > 0 &&
    isValidTimeZone(row.tz)
  );
}
