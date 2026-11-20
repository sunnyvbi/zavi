
import { inngest } from "../client";
import {
  SHARD_PROVISION_EVENT,
  finishProvision,
  productionJobDeps,
  provisionAttempt,
  type AttemptOutcome,
  type ProvisionEventData,
} from "@/services/site-shards/autoprovision";

export const HEALTH_ROUNDS = 8;

export const siteShardProvisionFn = inngest.createFunction(
  { id: "site-shard-provision", retries: 0, concurrency: { limit: 1, key: "event.data.env" } },
  { event: SHARD_PROVISION_EVENT },
  async ({ event, step, logger }) => {
    const data = event.data as ProvisionEventData;
    let outcome: AttemptOutcome | null = null;
    for (let i = 0; i < HEALTH_ROUNDS; i++) {
      const r = await step.run(`attempt-${i}`, async () => provisionAttempt(await productionJobDeps(), data, 6));
      if (r.status === "refused") {
        logger.warn(`site-shard-provision: refused (${r.reason}); nothing was created`);
        return { refused: r.reason };
      }
      outcome = r as AttemptOutcome;
      if (outcome.status === "blocked" && outcome.step === "healthy" && i < HEALTH_ROUNDS - 1) {
        await step.sleep(`wait-healthy-${i}`, "2m");
        continue;
      }
      break;
    }
    const final = outcome as AttemptOutcome;
    const fin = await step.run("finish", async () => finishProvision(await productionJobDeps(), data, final));
    logger.info(`site-shard-provision: ${data.shard_name} ${final.status}; paused=${fin.paused}`);
    return { shard: data.shard_name, status: final.status, paused: fin.paused, tripped: fin.tripped };
  },
);
