
import { alert } from "@/services/logging/alert";

const MAX_LISTED = 5;

export async function alertMoneyJobErrors(
  job: string,
  failedTenantIds: readonly string[],
  total: number,
  send: typeof alert = alert,
): Promise<void> {
  const errors = failedTenantIds.length;
  if (!(errors > 0)) return;
  const listed = failedTenantIds.slice(0, MAX_LISTED).join(", ");
  const more = errors > MAX_LISTED ? ` (+${errors - MAX_LISTED} more)` : "";
  try {
    await send({
      source: job,
      code: `${job.replace(/-/g, "_")}_errors`,
      msg: `${job}: ${errors} of ${total} workspaces hit an error this run. Ad money for those workspaces may not be watched or moved as intended until this is fixed. Workspaces: ${listed}${more}.`,
      email: { dedupeKey: `money-job:${job}:${Math.floor(Date.now() / 3_600_000)}` },
    });
  } catch {
  }
}
