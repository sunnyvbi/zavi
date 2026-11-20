
import { inngest } from "../client";
import { runShardMaintenance } from "@/services/site-shards/maintenance";
import { runCapacityCheck } from "@/services/site-shards/autoprovision";
import { runValidationCapacityCheck } from "@/services/site-shards/validation-capacity";
import { runTestSiteSweep } from "@/services/site-shards/test-site";
import { requestHourlySchemaRollout } from "@/services/site-shards/auto-rollout";

export const siteShardsMaintenanceFn = inngest.createFunction(
  { id: "site-shards-maintenance", concurrency: { limit: 1, key: '"global"' } },
  { cron: "41 * * * *" },
  async ({ logger }) => {
    const schema = await requestHourlySchemaRollout();
    logger.info(`site-shards-maintenance: schema rollout ${JSON.stringify(schema).slice(0, 1000)}`);
    let r: Awaited<ReturnType<typeof runShardMaintenance>> | null = null;
    let failed: unknown = null;
    try {
      r = await runShardMaintenance();
      logger.info(`site-shards-maintenance: shards=${r.shards} resumed=${r.resumed} resume_failed=${r.resume_failed} metrics=${r.metrics.measured}/${r.metrics.measured + r.metrics.failed}`);
    } catch (e) {
      failed = e;
    }
    const capacity = await runCapacityCheck();
    logger.info(`site-shards-maintenance: capacity ${JSON.stringify(capacity)}`);
    const validation = capacity.action === "enqueued" ? { action: "skipped", reason: "pool_enqueued" } : await runValidationCapacityCheck();
    logger.info(`site-shards-maintenance: validation ${JSON.stringify(validation)}`);
    const test_sites = await runTestSiteSweep();
    logger.info(`site-shards-maintenance: test sites ${JSON.stringify(test_sites)}`);
    if (failed) throw failed;
    return { ok: true, ...r, schema, capacity, validation, test_sites };
  },
);
