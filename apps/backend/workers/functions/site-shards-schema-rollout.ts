
import { inngest } from "../client";
import { SCHEMA_ROLLOUT_EVENT, runAutoSchemaRollout } from "@/services/site-shards/auto-rollout";

export const siteShardsSchemaRolloutFn = inngest.createFunction(
  { id: "site-shards-schema-rollout", retries: 0, concurrency: { limit: 1, key: '"global"' } },
  { event: SCHEMA_ROLLOUT_EVENT },
  async ({ event, logger }) => {
    const r = await runAutoSchemaRollout();
    logger.info(`site-shards-schema-rollout (${String((event.data as { reason?: unknown })?.reason ?? "")}): ${JSON.stringify(r).slice(0, 1000)}`);
    return r;
  },
);
