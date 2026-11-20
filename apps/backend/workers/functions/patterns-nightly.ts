
import { inngest } from "../client";
import {
  assertTenantOptedIn,
  listPatternsEnabledTenantIds,
} from "@/services/memory/patterns-flag";
import { runPatternsForTenant } from "@/services/memory/patterns-job";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

export const patternsNightlyScannerFn = inngest.createFunction(
  { id: "patterns-nightly-scanner", concurrency: 1 },
  { cron: "0 11 * * *" },
  async ({ logger, step }) => {
    if (isWorkerCronStopped("patterns-nightly")) {
      logger.info("patterns-nightly: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const tenants = await step.run("list-opted-in-tenants", async () =>
      listPatternsEnabledTenantIds(),
    );

    let queued = 0;
    for (const tenant_id of tenants) {
      try {
        await step.sendEvent("patterns-tenant-requested", {
          name: "patterns.tenant.requested",
          data: { tenant_id, dispatched_at: new Date().toISOString() },
        });
        queued += 1;
      } catch (err: unknown) {
        logger.warn(
          `patterns-nightly-scanner: failed to enqueue tenant ${tenant_id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    logger.info(
      `patterns-nightly-scanner: scanned=${tenants.length} queued=${queued}`,
    );
    return { scanned: tenants.length, queued };
  },
);

export const patternsNightlyHandlerFn = inngest.createFunction(
  {
    id: "patterns-nightly-handler",
    concurrency: 5,
  },
  { event: "patterns.tenant.requested" },
  async ({ event, logger }) => {
    const tenant_id = (event.data as { tenant_id?: string })?.tenant_id;
    if (!tenant_id || typeof tenant_id !== "string") {
      logger.warn("patterns-nightly-handler: missing tenant_id in event data");
      return { status: "skip", reason: "missing_tenant_id" };
    }

    const optedIn = await assertTenantOptedIn(tenant_id);
    if (!optedIn) {
      logger.warn(
        `patterns-nightly-handler: tenant ${tenant_id} not opted-in or does not exist; skipping`,
      );
      return { status: "skip", reason: "not_opted_in_or_missing" };
    }

    const result = await runPatternsForTenant(tenant_id);
    logger.info(
      `patterns-nightly-handler: tenant=${tenant_id} status=${result.status} ` +
        `runs=${result.runs_considered} emitted=${result.artifacts_emitted} ` +
        `dup=${result.artifacts_skipped_dup} cost=${result.cost_usd}`,
    );
    return result;
  },
);
