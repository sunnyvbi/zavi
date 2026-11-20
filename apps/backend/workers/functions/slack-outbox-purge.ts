
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

const RETENTION_DAYS = 30;
const BATCH = 2000;
const MAX_PASSES = 25;

async function purgeOnce(): Promise<{ purged: number }> {
  const svc = serviceClient();
  let purged = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { data, error } = await svc.rpc("purge_old_slack_outbox", {
      p_older_days: RETENTION_DAYS,
      p_limit: BATCH,
    });
    if (error) {
      await logEvent({ level: "warn", source: "slack.outbox", code: "purge_failed" });
      break;
    }
    const n = typeof data === "number" ? data : 0;
    purged += n;
    if (n < BATCH) break;
  }
  if (purged > 0) {
    await logEvent({
      level: "info",
      source: "slack.outbox",
      code: "purged",
      meta: { count: String(purged), retention_days: String(RETENTION_DAYS) },
    });
  }
  return { purged };
}

export const slackOutboxPurgeFn = inngest.createFunction(
  { id: "slack-outbox-purge", concurrency: 1 },
  { cron: "23 4 * * *" },
  async ({ step, logger }) => {
    const res = await step.run("purge", () => purgeOnce());
    logger.info(`slack-outbox-purge: ${JSON.stringify(res)}`);
    return res;
  },
);
