
import type { ShardEnv, ShardSql } from "./contract";
import { sweepShardMetrics, type SweepResult } from "./metrics";
import type { ShardRegistry } from "./registry";
import { pendingReindexes, reindexCollection } from "./shard-ops";

export type MaintenanceDeps = {
  registry: ShardRegistry;
  sql: ShardSql;
  env: ShardEnv;
  resumeDeletions: ((project_ref: string) => Promise<number>) | null;
  graduationTriggers?: ((env: ShardEnv) => Promise<{ over: number; requested: number; failed: number }>) | null;
  resumeGraduations?: (() => Promise<Record<string, number>>) | null;
  sweepMetrics?: (() => Promise<SweepResult>) | null;
  repairBrokerUrls?: (() => Promise<{ repaired: number; failed: number; failed_names: string[] }>) | null;
  log?: (l: string) => void;
};

export async function shardMaintenance(deps: MaintenanceDeps) {
  let broker_urls: { repaired: number; failed: number } | null = null;
  if (deps.repairBrokerUrls) {
    try {
      const r = await deps.repairBrokerUrls();
      broker_urls = { repaired: r.repaired, failed: r.failed };
    } catch (e) {
      deps.log?.(`[site-shards] broker_db_url repair: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  const shards = (await deps.registry.list(deps.env)).filter((s) => s.project_ref && s.state !== "retired" && s.state !== "provisioning");
  let resumed = 0;
  let resume_failed = 0;
  if (deps.resumeDeletions) {
    for (const s of shards) {
      try {
        resumed += await deps.resumeDeletions(s.project_ref as string);
      } catch (e) {
        resume_failed++;
        deps.log?.(`[site-shards] resumeDeletions ${s.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
  }
  let reindexed = 0;
  for (const s of shards) {
    try {
      for (const p of await pendingReindexes(deps.sql, s.project_ref as string)) {
        if (await reindexCollection(deps.sql, s.project_ref as string, p.site_id, p.name, 200)) reindexed++;
      }
    } catch (e) {
      deps.log?.(`[site-shards] reindex ${s.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  let metrics: { measured: number; failed: number; stale?: string[]; over?: string[] } = { measured: 0, failed: 0 };
  if (shards.length) {
    try {
      metrics = deps.sweepMetrics ? await deps.sweepMetrics() : await sweepShardMetrics({ registry: deps.registry, sql: deps.sql, log: deps.log }, deps.env);
    } catch (e) {
      deps.log?.(`[site-shards] metrics sweep: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  let triggers: { over: number; requested: number; failed: number } | null = null;
  if (deps.graduationTriggers && shards.length) {
    triggers = await deps.graduationTriggers(deps.env).catch((e: unknown) => {
      deps.log?.(`[site-shards] graduation triggers: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return null;
    });
  }
  let graduations: Record<string, number> | null = null;
  if (deps.resumeGraduations) {
    graduations = await deps.resumeGraduations().catch((e: unknown) => {
      deps.log?.(`[site-shards] graduations: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return null;
    });
  }
  return { shards: shards.length, resumed, resume_failed, reindexed, metrics, triggers, graduations, broker_urls };
}

export async function runShardMaintenance() {
  const [{ shardRegistry, shardEnv }, { pooledSeams, runGraduations }, { createShardMgmt }, triggersMod, graduationMod, metricsMod] = await Promise.all([
    import("./registry"),
    import("./facade"),
    import("./shard-mgmt"),
    import("./graduation-triggers"),
    import("./graduation"),
    import("./metrics"),
  ]);
  const registry = shardRegistry();
  let mgmt: ReturnType<typeof createShardMgmt> | null = null;
  return shardMaintenance({
    registry,
    sql: { query: (ref, q) => (mgmt ??= createShardMgmt()).query(ref, q) },
    env: shardEnv(),
    resumeDeletions: pooledSeams().resumeDeletions,
    graduationTriggers: (env) =>
      triggersMod.graduationTriggerSweep(
        {
          registry,
          sql: { query: (ref, q) => (mgmt ??= createShardMgmt()).query(ref, q) },
          store: graduationMod.createGraduationStore(),
          thresholds: triggersMod.thresholdsFromSettings,
          alert: async (msg) => (await import("@/services/logging/alert")).alert({ msg, source: "site-graduation", code: "sites.graduation.threshold" }),
          log: (l) => console.warn(l),
        },
        env,
      ),
    resumeGraduations: () => runGraduations(),
    sweepMetrics: () => metricsMod.runShardMetricsSweep(),
    repairBrokerUrls: async () => {
      const { repairBrokerDbUrls } = await import("./broker-db-url");
      const env = shardEnv();
      const r = await repairBrokerDbUrls({
        listShards: () => registry.list(env),
        secrets: registry,
        mgmt: (mgmt ??= createShardMgmt()),
        log: (l) => console.warn(l),
      });
      if (r.failed) {
        await (await import("@/services/logging/alert"))
          .alert({ msg: `site shards: broker_db_url could not be moved to the pooler for ${r.failed_names.join(", ")}`, source: "site-shards", code: "sites.broker_db_url.repair_failed" })
          .catch(() => undefined);
      }
      return r;
    },
    log: (l) => console.warn(l),
  });
}
