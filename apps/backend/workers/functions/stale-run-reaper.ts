
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { reapStaleRuns } from "@/services/agents/stale-run-reaper";
import { isCanonicalContainer } from "@/services/agents/boot-role";

export const staleRunReaperFn = inngest.createFunction(
  { id: "stale-run-reaper", concurrency: 1 },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    if (!isCanonicalContainer()) {
      logger.info("stale-run-reaper: skipped (not the prod container)");
      return { skipped: "not_canonical" as const };
    }
    const res = await reapStaleRuns(serviceClient(), inngest);
    if (
      res.blocked_reaped > 0 ||
      res.queued_reaped > 0 ||
      res.conductor_provisioning_reaped > 0 ||
      res.conductor_active_reaped > 0
    ) {
      logger.warn(
        `stale-run-reaper: blocked-reaped=${res.blocked_reaped} queued-reaped=${res.queued_reaped} promoted=${res.promoted} conductor-provisioning-reaped=${res.conductor_provisioning_reaped} conductor-active-reaped=${res.conductor_active_reaped}`,
      );
    }
    return res;
  },
);
