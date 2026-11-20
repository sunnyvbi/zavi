import { describe, expect, it } from "vitest";
import { rolloutOrder, rolloutShardSchema } from "../rollout";
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
  { version: "0001_core", sql: "-- core", sha256: "a" },
  { version: "0002_api", sql: "-- api", sha256: "b" },
];

function fakeSql(ledgers: Record<string, string[]>, failOn?: { ref: string; marker: string }) {
  const calls: string[] = [];
  const sql: ShardSql = {
    async query(ref, q) {
      calls.push(`${ref}:${q.slice(0, 40)}`);
      if (q.includes("to_regclass")) return [{ present: true }];
      if (q === "select 1 as ok") return [{ ok: 1 }];
      if (q.startsWith("select version")) return (ledgers[ref] ?? []).map((version) => ({ version }));
      if (failOn && ref === failOn.ref && q.includes(failOn.marker)) throw new Error("boom");
      const m = /values \('([^']+)'\)/.exec(q);
      if (m) (ledgers[ref] ??= []).push(m[1]);
      return [];
    },
  };
  return { sql, calls };
}

function registry(shards: ShardRow[], onRecord: Record<string, string> = {}) {
  const updates: Array<[string, unknown]> = [];
  const recorded = new Map<string, string>(Object.entries(onRecord));
  return {
    updates,
    record: async (shard_id: string, version: string, sha: string) => {
      const k = `${shard_id}:${version}`;
      if (!recorded.has(k)) recorded.set(k, sha);
      return recorded.get(k) as string;
    },
    list: async () => shards,
    update: async (id: string, patch: unknown) => {
      updates.push([id, patch]);
      return shards.find((s) => s.id === id) as ShardRow;
    },
    pausePlacement: async (id: string) => shards.find((s) => s.id === id) as ShardRow,
    resumePlacement: async (id: string) => shards.find((s) => s.id === id) as ShardRow,
    rolloutClaim: async () => true,
    rolloutRelease: async () => undefined,
  };
}

describe("shard schema rollout", () => {
  it("orders canary first, skips retired / provisioning shards", () => {
    const order = rolloutOrder([shard(1), shard(2, { is_canary: true }), shard(3, { state: "retired" }), shard(4, { state: "provisioning" })]);
    expect(order.map((o) => [o.shard.name, o.canary])).toEqual([["zavi-shard-dev-2", true], ["zavi-shard-dev-1", false]]);
    expect(rolloutOrder([shard(2), shard(1)])[0]).toMatchObject({ canary: true, shard: { name: "zavi-shard-dev-1" } });
  });

  it("applies pending files, one shard at a time, ledger-driven, and records schema_version", async () => {
    const { sql, calls } = fakeSql({ refrefref1: ["0001_core"], refrefref2: [] });
    const reg = registry([shard(1), shard(2)]);
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
    expect(r.ok).toBe(true);
    expect(r.shards.map((s) => [s.shard, s.applied])).toEqual([
      ["zavi-shard-dev-1", ["0002_api"]],
      ["zavi-shard-dev-2", ["0001_core", "0002_api"]],
    ]);
    const first2 = calls.findIndex((c) => c.startsWith("refrefref2"));
    expect(calls.slice(first2).some((c) => c.startsWith("refrefref1"))).toBe(false);
    expect(reg.updates).toEqual([[shard(1).id, { schema_version: "0002_api" }], [shard(2).id, { schema_version: "0002_api" }]]);
  });

  it("STOPS on the first failure: later shards are skipped, never touched", async () => {
    const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [], refrefref3: [] }, { ref: "refrefref2", marker: "-- api" });
    const r = await rolloutShardSchema({ registry: registry([shard(1), shard(2), shard(3)]), sql, files }, { env: "dev" });
    expect(r.ok).toBe(false);
    expect(r.shards.map((s) => s.status)).toEqual(["applied", "failed", "skipped"]);
    expect(r.shards[1].error).toMatch(/^0002_api/);
    expect(calls.some((c) => c.startsWith("refrefref3"))).toBe(false);
  });

  it("an unhealthy canary stops the rollout before any other shard", async () => {
    const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [] });
    const r = await rolloutShardSchema(
      { registry: registry([shard(1), shard(2)]), sql, files, verifyCanary: async () => false },
      { env: "dev" },
    );
    expect(r.shards.map((s) => s.status)).toEqual(["canary_unhealthy", "skipped"]);
    expect(calls.some((c) => c.startsWith("refrefref2"))).toBe(false);
  });

  it("a file edited in place after it ran (checksum mismatch) stops the rollout", async () => {
    const { sql } = fakeSql({ refrefref1: ["0001_core"], refrefref2: [] });
    const reg = registry([shard(1), shard(2)], { [`${shard(1).id}:0001_core`]: "an-older-checksum" });
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
    expect(r.ok).toBe(false);
    expect(r.shards.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(r.shards[0].error).toMatch(/checksum mismatch/);
  });

  it("the SHARD's own checksum refusal (zsite.record_migration) is a hard stop", async () => {
    const { sql } = fakeSql({ refrefref1: ["0001_core"], refrefref2: [] });
    const inner = sql.query;
    sql.query = async (ref, q) => {
      if (q.includes("to_regprocedure('zsite.record_migration")) return [{ ok: true }];
      if (q.startsWith("select zsite.record_migration('0001_core'") && ref === "refrefref1") throw new Error("checksum_mismatch: 0001_core was applied with abc");
      return inner(ref, q);
    };
    const r = await rolloutShardSchema({ registry: registry([shard(1), shard(2)]), sql, files }, { env: "dev" });
    expect(r.shards.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(r.shards[0].error).toMatch(/checksum_mismatch/);
  });

  it("records each applied file's checksum through zsite.record_migration once 0005 exists", async () => {
    const { sql } = fakeSql({ refrefref1: [] });
    const inner = sql.query;
    const recorded: string[] = [];
    sql.query = async (ref, q) => {
      if (q.includes("to_regprocedure('zsite.record_migration")) return [{ ok: true }];
      if (q.startsWith("select zsite.record_migration(")) recorded.push(q);
      return inner(ref, q);
    };
    await rolloutShardSchema({ registry: registry([shard(1)]), sql, files }, { env: "dev" });
    expect(recorded).toEqual([
      "select zsite.record_migration('0001_core', 'a')",
      "select zsite.record_migration('0002_api', 'b')",
    ]);
  });

  it("dry run reports pending files and writes nothing", async () => {
    const { sql, calls } = fakeSql({ refrefref1: ["0001_core"] });
    const reg = registry([shard(1)]);
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev", dryRun: true });
    expect(r.shards[0]).toMatchObject({ status: "dry_run", pending: ["0002_api"], applied: [] });
    expect(calls.every((c) => /to_regclass|select version/.test(c))).toBe(true);
    expect(reg.updates).toEqual([]);
  });

  describe("placement pause + alerts (S7)", () => {
    function pausing(shards: ShardRow[]) {
      const base = registry(shards);
      const events: string[] = [];
      const reasons = new Map<string, string | null>();
      return {
        ...base,
        events,
        reasons,
        pausePlacement: async (id: string, reason: string, seconds: number | null) => {
          events.push(`pause:${shards.find((s) => s.id === id)?.name}:${seconds === null ? "indefinite" : seconds}:${reason.replace(/ \(rollout:[0-9a-f-]+\)$/, "")}`);
          reasons.set(id, reason);
          return shards.find((s) => s.id === id) as ShardRow;
        },
        resumePlacement: async (id: string, expect?: string) => {
          if (expect === undefined || reasons.get(id) === expect) {
            events.push(`resume:${shards.find((s) => s.id === id)?.name}`);
            reasons.set(id, null);
          }
          return { ...(shards.find((s) => s.id === id) as ShardRow), placement_paused_reason: reasons.get(id) ?? null } as ShardRow;
        },
      };
    }

    it("pauses placement on each shard BEFORE its first file and resumes it after (canary after its health check)", async () => {
      const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [] });
      const reg = pausing([shard(1), shard(2)]);
      const order: string[] = [];
      const wrapped = { query: async (ref: string, q: string) => (q.startsWith("-- ") && order.push(`apply:${ref}`), sql.query(ref, q)) };
      const r = await rolloutShardSchema({ registry: reg, sql: wrapped, files, verifyCanary: async () => (order.push("canary-check"), true) }, { env: "dev" });
      expect(r.ok).toBe(true);
      expect(reg.events).toEqual([
        "pause:zavi-shard-dev-1:indefinite:schema rollout in progress",
        "resume:zavi-shard-dev-1",
        "pause:zavi-shard-dev-2:indefinite:schema rollout in progress",
        "resume:zavi-shard-dev-2",
      ]);
      expect(r.shards.every((s) => s.paused === false)).toBe(true);
      expect(order.indexOf("canary-check")).toBeLessThan(order.indexOf("apply:refrefref2"));
      expect(calls.length).toBeGreaterThan(0);
    });

    it("an up-to-date shard is not paused", async () => {
      const { sql } = fakeSql({ refrefref1: ["0001_core", "0002_api"] });
      const reg = pausing([shard(1)]);
      await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
      expect(reg.events).toEqual([]);
    });

    it("a failed file STOPS the rollout, leaves that shard paused indefinitely, and alerts", async () => {
      const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [], refrefref3: [] }, { ref: "refrefref2", marker: "-- api" });
      const reg = pausing([shard(1), shard(2), shard(3)]);
      const alerts: Array<[string, string]> = [];
      const r = await rolloutShardSchema({ registry: reg, sql, files, alert: async (c, m) => void alerts.push([c, m]) }, { env: "dev" });
      expect(r.shards.map((s) => s.status)).toEqual(["applied", "failed", "skipped"]);
      expect(r.shards[1].paused).toBe(true);
      expect(reg.events.slice(-1)[0]).toMatch(/^pause:zavi-shard-dev-2:indefinite:schema rollout stopped: 0002_api failed/);
      expect(reg.events).not.toContain("resume:zavi-shard-dev-2");
      expect(alerts).toHaveLength(1);
      expect(alerts[0][0]).toBe("sites.shards.rollout_failed");
      expect(alerts[0][1]).toMatch(/STOPPED at zavi-shard-dev-2.*PAUSED.*1 later shard/);
      expect(calls.some((c) => c.startsWith("refrefref3"))).toBe(false);
    });

    it("an unhealthy canary stays paused and alerts; nothing else is touched", async () => {
      const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [] });
      const reg = pausing([shard(1), shard(2)]);
      const alerts: string[] = [];
      const r = await rolloutShardSchema({ registry: reg, sql, files, verifyCanary: async () => false, alert: async (c) => void alerts.push(c) }, { env: "dev" });
      expect(r.shards.map((s) => [s.status, s.paused])).toEqual([["canary_unhealthy", true], ["skipped", undefined]]);
      expect(alerts).toEqual(["sites.shards.rollout_failed"]);
      expect(calls.some((c) => c.startsWith("refrefref2"))).toBe(false);
    });

    it("the default canary check reads the ledger: a canary missing a file is unhealthy", async () => {
      const { sql } = fakeSql({ refrefref1: [], refrefref2: [] });
      const inner = sql.query;
      sql.query = async (ref, q) => (ref === "refrefref1" && q.includes("values ('0002_api')") ? [] : inner(ref, q));
      const r = await rolloutShardSchema({ registry: registry([shard(1), shard(2)]), sql, files }, { env: "dev" });
      expect(r.shards.map((s) => s.status)).toEqual(["canary_unhealthy", "skipped"]);
    });

    it("waits the canary soak before checking it", async () => {
      const { sql } = fakeSql({ refrefref1: [] });
      const slept: number[] = [];
      await rolloutShardSchema({ registry: registry([shard(1)]), sql, files, canarySoakMs: 60_000, sleep: async (ms) => void slept.push(ms) }, { env: "dev" });
      expect(slept).toEqual([60_000]);
    });

    it("a pause that cannot be taken stops the rollout before any file runs", async () => {
      const { sql, calls } = fakeSql({ refrefref1: [] });
      const reg = { ...registry([shard(1)]), pausePlacement: async () => { throw new Error("db down"); } };
      const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
      expect(r.shards[0]).toMatchObject({ status: "failed" });
      expect(r.shards[0].error).toMatch(/could not pause placement/);
      expect(calls.some((c) => c.includes("-- core"))).toBe(false);
    });

    it("EXPAND/CONTRACT: a contract file pending with its own expand file is refused (same release)", async () => {
      const ec: ShardMigrationFile[] = [
        ...files,
        { version: "0003_add_x", sql: "-- expand", sha256: "c" },
        { version: "0004_drop_y", sql: "-- zavi:contract-after 0003_add_x\n-- contract", sha256: "d" },
      ];
      const fresh = fakeSql({ refrefref1: ["0001_core", "0002_api"] });
      const r = await rolloutShardSchema({ registry: registry([shard(1)]), sql: fresh.sql, files: ec }, { env: "dev" });
      expect(r.shards[0].status).toBe("failed");
      expect(r.shards[0].error).toMatch(/0004_drop_y \(contract\) with its expand file 0003_add_x/);
      expect(fresh.calls.some((c) => c.includes("-- expand"))).toBe(false);
      const later = fakeSql({ refrefref1: ["0001_core", "0002_api", "0003_add_x"] });
      const ok = await rolloutShardSchema({ registry: registry([shard(1)]), sql: later.sql, files: ec }, { env: "dev" });
      expect(ok.shards[0]).toMatchObject({ status: "applied", applied: ["0004_drop_y"] });
    });

    it("a failure AFTER the files ran (registry update, resume) still stops, keeps the shard paused and alerts", async () => {
      const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [] });
      const reg = { ...pausing([shard(1), shard(2)]), update: async () => { throw new Error("rpc 503"); } };
      const alerts: string[] = [];
      const r = await rolloutShardSchema({ registry: reg, sql, files, alert: async (_c, m) => void alerts.push(m) }, { env: "dev" });
      expect(r.ok).toBe(false);
      expect(r.shards.map((s) => [s.status, s.paused])).toEqual([["failed", true], ["skipped", undefined]]);
      expect(r.shards[0].error).toMatch(/rpc 503/);
      expect(reg.events).not.toContain("resume:zavi-shard-dev-1");
      expect(alerts[0]).toMatch(/STOPPED at zavi-shard-dev-1: after its files ran: rpc 503/);
      expect(calls.some((c) => c.startsWith("refrefref2"))).toBe(false);

      const { sql: sql2 } = fakeSql({ refrefref1: [] });
      const reg2 = { ...pausing([shard(1)]), resumePlacement: async () => { throw new Error("db down"); } };
      const r2 = await rolloutShardSchema({ registry: reg2, sql: sql2, files }, { env: "dev" });
      expect(r2.shards[0]).toMatchObject({ status: "failed", paused: true });
    });

    it("ONE rollout per env: a held lock touches nothing; the lock is released at the end, even on failure", async () => {
      const { sql, calls } = fakeSql({ refrefref1: [] });
      const held = { ...pausing([shard(1)]), rolloutClaim: async () => false };
      const r = await rolloutShardSchema({ registry: held, sql, files }, { env: "dev" });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/another schema rollout/) });
      expect(r.shards.map((s) => s.status)).toEqual(["skipped"]);
      expect(calls).toEqual([]);
      expect(held.events).toEqual([]);

      const lock: string[] = [];
      const f2 = fakeSql({ refrefref1: [] }, { ref: "refrefref1", marker: "-- api" });
      const reg = { ...pausing([shard(1)]), rolloutClaim: async (_e: string, h: string) => (lock.push(`claim:${h.slice(0, 8)}`), true), rolloutRelease: async (_e: string, h: string) => void lock.push(`release:${h.slice(0, 8)}`) };
      await rolloutShardSchema({ registry: reg, sql: f2.sql, files }, { env: "dev" });
      expect(lock[0]).toBe("claim:rollout:");
      expect(lock[lock.length - 1]).toBe("release:rollout:");
    });

    it("compare-and-clear: a pause someone else set meanwhile is NOT cleared; the shard stays paused and it alerts", async () => {
      const { sql } = fakeSql({ refrefref1: [] });
      const reg = pausing([shard(1)]);
      const inner = sql.query;
      sql.query = async (ref, q) => {
        if (q.startsWith("-- api")) reg.reasons.set(shard(1).id, "schema rollout in progress (rollout:other)");
        return inner(ref, q);
      };
      const alerts: string[] = [];
      const r = await rolloutShardSchema({ registry: reg, sql, files, alert: async (_c, m) => void alerts.push(m) }, { env: "dev" });
      expect(r.shards[0]).toMatchObject({ status: "failed", paused: true });
      expect(reg.events).not.toContain("resume:zavi-shard-dev-1");
      expect(alerts[0]).toMatch(/re-paused by someone else/);
    });

    it("dry run never pauses", async () => {
      const { sql } = fakeSql({ refrefref1: [] });
      const reg = pausing([shard(1)]);
      await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev", dryRun: true });
      expect(reg.events).toEqual([]);
    });
  });
});

describe("pauses a rollout does not own, and quarantine (auto rollout)", () => {
  function stateful(shards: ShardRow[], initial: Record<string, string> = {}) {
    const base = registry(shards);
    const rows = new Map(shards.map((s) => [s.id, { ...s, placement_paused_until: null as string | null, placement_paused_reason: null as string | null }]));
    for (const [id, reason] of Object.entries(initial)) Object.assign(rows.get(id)!, { placement_paused_until: "infinity", placement_paused_reason: reason });
    const events: string[] = [];
    const name = (id: string) => rows.get(id)!.name;
    return {
      ...base,
      rows,
      events,
      list: async () => [...rows.values()] as ShardRow[],
      get: async (id: string) => (rows.get(id) as ShardRow | undefined) ?? null,
      pausePlacement: async (id: string, reason: string) => {
        events.push(`pause:${name(id)}:${reason.replace(/ \(rollout:[0-9a-f-]+\)$/, "").slice(0, 40)}`);
        Object.assign(rows.get(id)!, { placement_paused_until: "infinity", placement_paused_reason: reason });
        return rows.get(id) as ShardRow;
      },
      resumePlacement: async (id: string, expect?: string) => {
        const r = rows.get(id)!;
        if (expect === undefined || r.placement_paused_reason === expect) {
          events.push(`resume:${name(id)}`);
          Object.assign(r, { placement_paused_until: null, placement_paused_reason: null });
        }
        return r as ShardRow;
      },
    };
  }

  it("a pause someone else set is kept: the shard is migrated under it, never re-paused or resumed", async () => {
    const { sql } = fakeSql({ refrefref1: [] });
    const reg = stateful([shard(1)], { [shard(1).id]: "incident 42: staff hold" });
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
    expect(r.ok).toBe(true);
    expect(r.shards[0]).toMatchObject({ status: "applied", held_pause: "incident 42: staff hold", paused: false });
    expect(reg.events).toEqual([]);
    expect(reg.rows.get(shard(1).id)!.placement_paused_reason).toBe("incident 42: staff hold");
  });

  it("a stop on a shard someone else paused keeps THEIR reason (never overwritten by the stop)", async () => {
    const { sql } = fakeSql({ refrefref1: [] }, { ref: "refrefref1", marker: "-- api" });
    const reg = stateful([shard(1)], { [shard(1).id]: "staff hold" });
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
    expect(r.shards[0]).toMatchObject({ status: "failed", held_pause: "staff hold" });
    expect(reg.events).toEqual([]);
    expect(reg.rows.get(shard(1).id)!.placement_paused_reason).toBe("staff hold");
  });

  it("a pause an EARLIER rollout left (stopped) is adopted and cleared once the shard is migrated: the repair path", async () => {
    const { sql } = fakeSql({ refrefref1: [] });
    const reg = stateful([shard(1)], { [shard(1).id]: "schema rollout stopped: 0002_api failed: boom" });
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev" });
    expect(r.shards[0]).toMatchObject({ status: "applied", paused: false });
    expect(reg.events).toEqual(["pause:zavi-shard-dev-1:schema rollout in progress", "resume:zavi-shard-dev-1"]);
    expect(reg.rows.get(shard(1).id)!.placement_paused_until).toBeNull();
  });

  it("quarantine pauses EVERY shard with a pending file before the canary runs, and reopens each once migrated", async () => {
    const { sql } = fakeSql({ refrefref1: [], refrefref2: ["0001_core", "0002_api"], refrefref3: ["0001_core"] });
    const reg = stateful([shard(1), shard(2), shard(3)]);
    const seen: string[] = [];
    const r = await rolloutShardSchema(
      { registry: reg, sql, files, verifyCanary: async () => (seen.push(reg.events.join("|")), true) },
      { env: "dev", quarantine: true },
    );
    expect(r.ok).toBe(true);
    expect(seen[0]).toContain("pause:zavi-shard-dev-3");
    expect(reg.events.filter((e) => e.startsWith("pause:zavi-shard-dev-2"))).toEqual([]);
    expect(r.shards.map((s) => [s.shard, s.status, s.quarantined ?? false, s.paused ?? false])).toEqual([
      ["zavi-shard-dev-1", "applied", true, false],
      ["zavi-shard-dev-2", "up_to_date", false, false],
      ["zavi-shard-dev-3", "applied", true, false],
    ]);
    for (const s of reg.rows.values()) expect(s.placement_paused_until).toBeNull();
  });

  it("quarantine + a canary failure: the later shards that lack files STAY paused (fail closed) and the alert says so", async () => {
    const { sql, calls } = fakeSql({ refrefref1: [], refrefref2: [] });
    const reg = stateful([shard(1), shard(2)]);
    const alerts: string[] = [];
    const r = await rolloutShardSchema(
      { registry: reg, sql, files, verifyCanary: async () => false, alert: async (_c, m) => void alerts.push(m) },
      { env: "dev", quarantine: true },
    );
    expect(r.shards.map((s) => [s.status, s.quarantined ?? false])).toEqual([["canary_unhealthy", true], ["skipped", true]]);
    expect(reg.rows.get(shard(2).id)!.placement_paused_until).toBe("infinity");
    expect(alerts[0]).toMatch(/1 later shard\(s\) not touched; 1 other shard\(s\) stay paused: they lack schema files/);
    expect(calls.some((c) => c.startsWith("refrefref2:-- "))).toBe(false);
  });

  it("quarantine never takes over someone else's pause", async () => {
    const { sql } = fakeSql({ refrefref1: [], refrefref2: [] });
    const reg = stateful([shard(1), shard(2)], { [shard(2).id]: "staff hold" });
    const r = await rolloutShardSchema({ registry: reg, sql, files }, { env: "dev", quarantine: true });
    expect(r.ok).toBe(true);
    expect(r.shards[1]).toMatchObject({ status: "applied", held_pause: "staff hold" });
    expect(reg.rows.get(shard(2).id)!.placement_paused_reason).toBe("staff hold");
  });
});
