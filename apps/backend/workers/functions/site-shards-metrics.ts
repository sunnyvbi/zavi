
import { inngest } from "../client";
import { runShardMetricsSweep } from "@/services/site-shards/metrics";

export const SITE_SHARDS_METRICS_REQUESTED = "site-shards/metrics.requested" as const;

type SendSweep = (event: { id: string; name: typeof SITE_SHARDS_METRICS_REQUESTED; data: { env: string; reason: string } }) => Promise<unknown>;

export async function requestShardMetricsSweep(
  input: { env: string; reason: "boot" | "readiness_stale" | "publish_waiting" },
  send: SendSweep = (event) => inngest.send(event),
  now: () => number = Date.now,
): Promise<void> {
  await send({
    id: `site-shards-metrics:${input.env}:${Math.floor(now() / 60_000)}`,
    name: SITE_SHARDS_METRICS_REQUESTED,
    data: { env: input.env, reason: input.reason },
  });
}

export const siteShardsMetricsFn = inngest.createFunction(
  { id: "site-shards-metrics", concurrency: { limit: 1, key: '"global"' } },
  [{ cron: "*/10 * * * *" }, { event: SITE_SHARDS_METRICS_REQUESTED }],
  async ({ event, logger }) => {
    const asked = (event?.data as { env?: unknown } | undefined)?.env;
    if (event?.name === SITE_SHARDS_METRICS_REQUESTED) {
      const { shardEnv } = await import("@/services/site-shards/registry");
      if (asked !== shardEnv()) {
        logger.warn(`site-shards-metrics: request for env ${String(asked).slice(0, 20)} ignored (this backend sweeps ${shardEnv()})`);
        return { skipped: "other_env" as const };
      }
    }
    const r = await runShardMetricsSweep();
    logger.info(
      `site-shards-metrics: ${r.env} measured=${r.measured} failed=${r.failed} sources=${JSON.stringify(r.sources)} stale=${r.stale.length} over=${r.over.length}`,
    );
    return r;
  },
);
