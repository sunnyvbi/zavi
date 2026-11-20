import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERT_EVERY_S, autoRolloutShardSchema, processThrottle, shardFilesFingerprint, type AutoRolloutDeps } from "../auto-rollout";
import type { ShardRow, ShardSql } from "../contract";
import type { ShardMigrationFile } from "../migrations";

const shard = (n: number, over: Partial<ShardRow> = {}): ShardRow => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  env: "dev",
  name: `zavi-shard-dev-${n}`,
  project_ref: `refrefref${n}`,
  url: `https://refrefref${n}.supabase.co`,
  region: "us-west-1",
  state: "open",
  is_canary: false,
  schema_version: null,
  provision_step: "done",
  max_sites: 2000,
  site_count: 0,
  created_at: `2026-10-0${n}T00:00:00Z`,
  ...over,
});

const files: ShardMigrationFile[] = [
  { version: "0010_release_on_delete", sql: "-- 0010", sha256: "a" },
  { version: "0011_site_publish_fence", sql: "-- 0011", sha256: "b" },
];

function world(ledgers: Record<string, string[]>, opts: { failOn?: string; claim?: boolean; alertClaim?: boolean } = {}) {
  const writes: string[] = [];
  const alerts: Array<[string, string]> = [];
  const pauses = new Map<string, string | null>();
  const sql: ShardSql = {
    async query(ref, q) {
      if (q.includes("to_regclass")) return [{ present: true }];
      if (q === "select 1 as ok") return [{ ok: 1 }];
      if (q.startsWith("select version")) return (ledgers[ref] ?? []).map((version) => ({ version }));
      if (q.includes("to_regprocedure")) return [{ ok: false }];
      if (opts.failOn && q.includes(opts.failOn)) throw new Error("lock timeout");
      writes.push(`${ref}:${q.slice(0, 30)}`);
      const m = /values \('([^']+)'\)/.exec(q);
      if (m) (ledgers[ref] ??= []).push(m[1]);
      return [];
    },
  };
  const shards = Object.keys(ledgers).map((_, i) => shard(i + 1));
  const deps: AutoRolloutDeps = {
    env: "dev",
    allowed: () => ({ ok: true }),
    sql,
    files,
    canarySoakMs: 0,
    alert: async (code, msg) => void alerts.push([code, msg]),
    registry: {
      list: async () => shards,
      get: async (id) => ({ ...(shards.find((s) => s.id === id) as ShardRow), placement_paused_until: pauses.get(id) ? "infinity" : null, placement_paused_reason: pauses.get(id) ?? null } as ShardRow),
      update: async (id) => shards.find((s) => s.id === id) as ShardRow,
      record: async (_id, _v, sha) => sha,
      pausePlacement: async (id, reason) => (pauses.set(id, reason), shards.find((s) => s.id === id) as ShardRow),
      resumePlacement: async (id, expect) => {
        if (expect === undefined || pauses.get(id) === expect) pauses.set(id, null);
        return { ...(shards.find((s) => s.id === id) as ShardRow), placement_paused_reason: pauses.get(id) ?? null } as ShardRow;
      },
      rolloutClaim: async () => opts.claim ?? true,
      rolloutRelease: async () => undefined,
      alertClaim: async () => opts.alertClaim ?? true,
    },
  };
  return { deps, writes, alerts, pauses, ledgers };
}

describe("automatic shard schema rollout", () => {
  it("THE INCIDENT: a shard provisioned before 0011 gets 0011 recorded in its ledger, and reopens", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete"], refrefref2: ["0010_release_on_delete", "0011_site_publish_fence"] });
    const r = await autoRolloutShardSchema(w.deps);
    expect(r).toEqual({ action: "rolled_out", shards: [{ shard: "zavi-shard-dev-1", applied: ["0011_site_publish_fence"] }] });
    expect(w.ledgers.refrefref1).toContain("0011_site_publish_fence");
    expect([...w.pauses.values()].every((p) => !p)).toBe(true);
    expect(w.alerts).toEqual([]);
  });

  it("nothing pending: reads ledgers only (no lock, no pause, no write)", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete", "0011_site_publish_fence"] });
    w.deps.registry.rolloutClaim = async () => {
      throw new Error("must not lock");
    };
    expect(await autoRolloutShardSchema(w.deps)).toEqual({ action: "up_to_date", shards: 1 });
    expect(w.writes).toEqual([]);
    expect(w.pauses.size).toBe(0);
  });

  it("not the deployed backend (probe / laptop): skipped, nothing read", async () => {
    const w = world({ refrefref1: [] });
    w.deps.allowed = () => ({ ok: false, reason: "probe_container" });
    w.deps.registry.list = async () => {
      throw new Error("must not read");
    };
    expect(await autoRolloutShardSchema(w.deps)).toEqual({ action: "skipped", reason: "probe_container" });
  });

  it("another rollout holds the env lock: busy, nothing touched, no alert", async () => {
    const w = world({ refrefref1: [] }, { claim: false });
    expect(await autoRolloutShardSchema(w.deps)).toEqual({ action: "busy" });
    expect(w.writes).toEqual([]);
    expect(w.alerts).toEqual([]);
  });

  it("a failing file: failed, the shard stays paused, ONE de-duplicated alert", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete"], refrefref2: ["0010_release_on_delete"] }, { failOn: "-- 0011" });
    const r = await autoRolloutShardSchema(w.deps);
    expect(r.action).toBe("failed");
    expect(w.pauses.get(shard(1).id)).toMatch(/^schema rollout stopped/);
    expect(w.pauses.get(shard(2).id)).toMatch(/^schema rollout in progress/);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0][0]).toBe("sites.shards.rollout_failed");
    expect(w.alerts[0][1]).toMatch(/STOPPED: zavi-shard-dev-1: 0011_site_publish_fence: lock timeout.*Also paused \(lacking schema files\): zavi-shard-dev-2/);

    const again = world({ refrefref1: ["0010_release_on_delete"] }, { failOn: "-- 0011", alertClaim: false });
    expect((await autoRolloutShardSchema(again.deps)).action).toBe("failed");
    expect(again.alerts).toEqual([]);
  });

  it("the next run after the cause is fixed repairs the stopped shard and reopens it", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete"] }, { failOn: "-- 0011" });
    await autoRolloutShardSchema(w.deps);
    expect(w.pauses.get(shard(1).id)).toMatch(/^schema rollout stopped/);
    const fixed = { ...w.deps, sql: { query: (ref: string, q: string) => (q.includes("-- 0011") ? Promise.resolve([]) : w.deps.sql.query(ref, q)) } };
    const r = await autoRolloutShardSchema(fixed);
    expect(r.action).toBe("rolled_out");
    expect(w.pauses.get(shard(1).id)).toBeNull();
  });

  it("a migrated shard an earlier rollout left paused (died before resuming) is checked and reopened", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete", "0011_site_publish_fence"] });
    w.pauses.set(shard(1).id, "schema rollout in progress (rollout:dead)");
    w.deps.registry.list = async () => [{ ...shard(1), placement_paused_until: "infinity", placement_paused_reason: "schema rollout in progress (rollout:dead)" } as ShardRow];
    const r = await autoRolloutShardSchema(w.deps);
    expect(r).toEqual({ action: "rolled_out", shards: [] });
    expect(w.pauses.get(shard(1).id)).toBeNull();
    expect(w.writes.filter((x) => x.includes(":-- "))).toEqual([]);
  });

  it("a staff pause on an up-to-date shard is not work: nothing touched", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete", "0011_site_publish_fence"] });
    w.deps.registry.list = async () => [{ ...shard(1), placement_paused_until: "infinity", placement_paused_reason: "staff hold" } as ShardRow];
    expect(await autoRolloutShardSchema(w.deps)).toEqual({ action: "up_to_date", shards: 1 });
  });

  it("quarantine fails closed: an unreadable ledger is paused; a pause that cannot be taken stops before any file runs", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete"], refrefref2: ["0010_release_on_delete"] });
    const inner = w.deps.sql.query;
    let reads = 0;
    w.deps.sql.query = async (ref, q) => {
      if (ref === "refrefref2" && q.startsWith("select version") && ++reads === 2) throw new Error("timeout");
      return inner(ref, q);
    };
    const paused: string[] = [];
    const pause = w.deps.registry.pausePlacement;
    w.deps.registry.pausePlacement = async (id, reason, s) => (paused.push(`${id.slice(7, 8)}:${reason.slice(0, 26)}`), pause(id, reason, s));
    await autoRolloutShardSchema(w.deps);
    expect(paused.slice(0, 2)).toEqual(["1:schema rollout in progress", "2:schema rollout in progress"]);

    const f = world({ refrefref1: ["0010_release_on_delete"], refrefref2: ["0010_release_on_delete"] });
    let n = 0;
    const p2 = f.deps.registry.pausePlacement;
    f.deps.registry.pausePlacement = async (id, reason, s) => {
      if (++n === 2) throw new Error("rpc 503");
      return p2(id, reason, s);
    };
    const r = await autoRolloutShardSchema(f.deps);
    expect(r.action).toBe("failed");
    expect(f.writes.filter((x) => x.includes("-- 0011"))).toEqual([]);
    expect(f.alerts[0][1]).toMatch(/could not pause placement \(quarantine\): rpc 503/);
    expect(f.alerts[0][1]).toMatch(/Also paused \(lacking schema files\): zavi-shard-dev-1\./);
    expect(f.pauses.get(shard(1).id)).toMatch(/^schema rollout in progress/);
  });

  it("a stranded pause is still found when the fresh read fails (falls back to the listed row)", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete", "0011_site_publish_fence"] });
    w.pauses.set(shard(1).id, "schema rollout stopped: earlier");
    w.deps.registry.list = async () => [{ ...shard(1), placement_paused_until: "infinity", placement_paused_reason: "schema rollout stopped: earlier" } as ShardRow];
    let gets = 0;
    const get = w.deps.registry.get!;
    w.deps.registry.get = async (id) => {
      if (++gets === 1) throw new Error("site_shard_get 503");
      return get(id);
    };
    expect((await autoRolloutShardSchema(w.deps)).action).toBe("rolled_out");
    expect(w.pauses.get(shard(1).id)).toBeNull();
  });

  it("process throttle: once per window per key", () => {
    expect(processThrottle("t-key", 0)).toBe(true);
    expect(processThrottle("t-key", 1000)).toBe(false);
    expect(processThrottle("t-other", 1000)).toBe(true);
    expect(processThrottle("t-key", ALERT_EVERY_S * 1000 + 1)).toBe(true);
  });

  it("uses the registry's atomic pause-unless-held when it has one", async () => {
    const w = world({ refrefref1: ["0010_release_on_delete"] });
    const calls: string[] = [];
    w.deps.registry.pausePlacementUnlessHeld = async (id, reason, adopt) => {
      calls.push(`${reason.slice(0, 26)}|${adopt.join(",")}`);
      w.pauses.set(id, reason);
      return { taken: true, held_reason: null };
    };
    w.deps.registry.pausePlacement = async () => {
      throw new Error("the non-atomic pause must not be used");
    };
    expect((await autoRolloutShardSchema(w.deps)).action).toBe("rolled_out");
    expect(calls[0]).toBe("schema rollout in progress|schema rollout in progress,schema rollout stopped");
    expect(w.pauses.get(shard(1).id)).toBeNull();
  });

  it("an unexpected throw never escapes: failed + alert", async () => {
    const w = world({ refrefref1: [] });
    w.deps.registry.list = async () => {
      throw new Error("registry down");
    };
    expect(await autoRolloutShardSchema(w.deps)).toEqual({ action: "failed", error: "registry down" });
    expect(w.alerts[0][0]).toBe("sites.shards.auto_rollout_failed");
  });

  it("the fingerprint changes with a new file or an edited checksum, not otherwise", () => {
    const a = shardFilesFingerprint(files);
    expect(shardFilesFingerprint([...files])).toBe(a);
    expect(shardFilesFingerprint([...files, { version: "0013_x", sql: "", sha256: "c" }])).not.toBe(a);
    expect(shardFilesFingerprint([files[0], { ...files[1], sha256: "z" }])).not.toBe(a);
  });

  it("wiring: hourly maintenance runs it first, a deploy's boot and a missing-schema publish request it", () => {
    const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
    const maint = read("../../../../workers/functions/site-shards-maintenance.ts");
    expect(maint.indexOf("requestHourlySchemaRollout()")).toBeGreaterThan(0);
    expect(maint.indexOf("requestHourlySchemaRollout()")).toBeLessThan(maint.indexOf("runShardMaintenance()"));
    const fn = read("../../../../workers/functions/site-shards-schema-rollout.ts");
    expect(fn).toContain("{ event: SCHEMA_ROLLOUT_EVENT }");
    expect(fn).toContain("runAutoSchemaRollout()");
    expect(fn).not.toMatch(/\{ cron:/);
    expect(read("../../../../workers/functions/index.ts")).toContain("siteShardsSchemaRolloutFn,");
    expect(read("../../../../server.ts")).toContain("requestSchemaRolloutOnBoot()");
    expect(read("../facade.ts")).toContain("onShardSchemaMissing: (ref, version) => requestSchemaRepair(ref, version)");
  });
});
