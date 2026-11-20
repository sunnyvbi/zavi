import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localBins, missingBins, startLocalShard, type LocalShard } from "./local-stack";
import { startBrokerServer, startEdge, type BrokerServer, type Edge, type SiteSpec } from "./edge";
import { buildWorld, cleanupSites, type World } from "./world";
import { ATTACKS } from "./attacks";
import { assertHostedShardsAreScratch, assertRegisteredAsStagingShards, hostedShards } from "./hosted-stack";
import type { ShardTarget } from "./target";

const ON = process.env.ZSI === "1";
const HOSTED = process.env.ZSI_TARGET === "hosted";
const REPO = resolve(__dirname, "../../../../../../..");
const SHARD_SQL = process.env.SITE_SHARD_SQL_DIR ?? join(REPO, "infra/site-shard");

describe.skipIf(!ON)(`cross-site isolation gate (${HOSTED ? "hosted staging shard" : "hermetic"})`, () => {
  let broker: BrokerServer | null = null;
  const local: LocalShard[] = [];
  let edge: Edge | null = null;
  let world: World | null = null;
  let siteSpecs: SiteSpec[] = [];

  beforeAll(async () => {
    broker = await startBrokerServer();
    let pooled: ShardTarget;
    let kernel: ShardTarget;
    if (HOSTED) {
      ({ pooled, kernel } = hostedShards(process.env));
      await assertRegisteredAsStagingShards([pooled, kernel], process.env);
      await assertHostedShardsAreScratch([pooled, kernel]);
    } else {
      const bins = localBins();
      const missing = missingBins(bins);
      if (missing.length) throw new Error(`ZSI=1 needs ${missing.join(", ")} (scripts/ci/site-isolation-deps.sh)`);
      const log = process.env.ZSI_DEBUG ? (m: string) => console.log(m) : undefined;
      const started = await Promise.allSettled([
        startLocalShard({ ref: "zsipooledshard000001", kind: "pooled", bins, hookBase: broker.hookBase, shardSqlDir: SHARD_SQL, log }),
        startLocalShard({ ref: "zsikernelshard000001", kind: "kernel", bins, hookBase: broker.hookBase, shardSqlDir: SHARD_SQL, log }),
      ]);
      for (const r of started) if (r.status === "fulfilled") local.push(r.value);
      const failed = started.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      [pooled, kernel] = local;
    }
    const tag = randomUUID().slice(0, 6);
    const site = (key: string, shard: ShardTarget, mode: SiteSpec["mode"]): SiteSpec => ({
      key, siteId: randomUUID(), hostname: `zsi-${key.toLowerCase()}-${tag}.sites-gate.test`, label: `Gate site ${key}`, shard, mode,
    });
    const specs = { A: site("A", pooled, "pooled"), B: site("B", pooled, "pooled"), C: site("C", kernel, "dedicated") };
    siteSpecs = [specs.A, specs.B, specs.C];
    edge = await startEdge({ broker, sites: siteSpecs });
    if (HOSTED) {
      await assertRegisteredAsStagingShards([pooled, kernel], process.env);
      await assertHostedShardsAreScratch([pooled, kernel]);
    }
    world = await buildWorld(edge, specs);
  }, 300_000);

  afterAll(async () => {
    try {
      if (edge && siteSpecs.length) {
        await world?.close();
        const left = await cleanupSites(edge, siteSpecs);
        if (left.length) throw new Error(`cleanup left: ${left.join("; ")}`);
      }
    } finally {
      await edge?.close().catch(() => undefined);
      await broker?.close().catch(() => undefined);
      for (const s of local) await s.stop().catch(() => undefined);
    }
  }, 120_000);

  for (const a of ATTACKS) {
    it.skipIf(HOSTED && !!a.hermeticOnly)(`${a.id}: ${a.title}`, async () => {
      expect(world, "world was not built").toBeTruthy();
      await a.run(world!);
    }, 120_000);
  }
});
