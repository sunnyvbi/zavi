import { describe, expect, it, vi } from "vitest";
import {
  BROKER_ROLE_TIMEOUT_SQL,
  brokerDbUrl,
  isDirectShardDbUrl,
  isPooledBrokerDbUrl,
  pooledFromStored,
  repairBrokerDbUrls,
  repairShardBrokerDbUrl,
} from "../broker-db-url";
import { createShardMgmt } from "../shard-mgmt";
import { registryAuthConfigResolver } from "../auth-config";
import type { ShardRow } from "../contract";

const REF = "abcdefghijklmnopqrst";
const HOST = "aws-0-us-west-1.pooler.supabase.com";
const DIRECT = `postgresql://zsite_broker:p%40ss@db.${REF}.supabase.co:5432/postgres?sslmode=require`;
const POOLED = `postgresql://zsite_broker.${REF}:p%40ss@${HOST}:6543/postgres?sslmode=require`;

function store(initial: Record<string, string | null>) {
  const v = new Map(Object.entries(initial));
  return {
    v,
    getSecret: vi.fn(async (id: string, _n: string) => v.get(id) ?? null),
    setSecret: vi.fn(async (id: string, _n: string, val: string) => void v.set(id, val)),
  };
}
const shard = (id: string, ref: string | null = REF, state: ShardRow["state"] = "open") =>
  ({ id, name: `zavi-shard-dev-${id}`, project_ref: ref, state }) as Pick<ShardRow, "id" | "name" | "project_ref" | "state">;

describe("broker db url shape", () => {
  it("builds the pooled transaction-mode URL", () => {
    expect(brokerDbUrl(REF, "p@ss", HOST)).toBe(POOLED);
    expect(() => brokerDbUrl(REF, "pw", `db.${REF}.supabase.co`)).toThrow(/pooler host/);
    expect(() => brokerDbUrl(REF, "", HOST)).toThrow(/empty/);
  });

  it("classifies direct vs pooled", () => {
    expect(isDirectShardDbUrl(DIRECT)).toBe(true);
    expect(isDirectShardDbUrl(POOLED)).toBe(false);
    expect(isPooledBrokerDbUrl(POOLED, REF)).toBe(true);
    expect(isPooledBrokerDbUrl(DIRECT, REF)).toBe(false);
    expect(isPooledBrokerDbUrl(POOLED.replace(`zsite_broker.${REF}`, "zsite_broker.zzzzzzzzzzzzzzzzzzzz"), REF)).toBe(false);
    expect(isPooledBrokerDbUrl(POOLED.replace(":6543", ":5432"), REF)).toBe(false);
    expect(isPooledBrokerDbUrl(`${POOLED}&host=evil`, REF)).toBe(false);
    expect(isPooledBrokerDbUrl("not a url", REF)).toBe(false);
  });

  it("rewrites keeping the password, refuses another project's or role's URL", () => {
    expect(pooledFromStored(DIRECT, REF, HOST)).toBe(POOLED);
    expect(pooledFromStored(POOLED.replace(":6543", ":5432"), REF, HOST)).toBe(POOLED);
    expect(() => pooledFromStored(DIRECT.replace(`db.${REF}`, "db.zzzzzzzzzzzzzzzzzzzz"), REF, HOST)).toThrow(/not this project/);
    expect(() => pooledFromStored(DIRECT.replace("zsite_broker:", "postgres:"), REF, HOST)).toThrow(/not this project/);
  });
});

describe("repair of existing shards", () => {
  it("rewrites a direct URL once, sets the role timeout first, then is a no-op", async () => {
    const s = store({ a: DIRECT });
    const calls: string[] = [];
    const mgmt = { poolerHost: vi.fn(async () => HOST), query: vi.fn(async (_r: string, q: string) => (calls.push(`sql:${q}`), [])) };
    s.setSecret.mockImplementation(async (id, _n, val) => void (calls.push("set"), s.v.set(id, val)));
    expect(await repairShardBrokerDbUrl({ secrets: s, mgmt }, shard("a"))).toBe("repaired");
    expect(s.v.get("a")).toBe(POOLED);
    expect(calls).toEqual([`sql:${BROKER_ROLE_TIMEOUT_SQL}`, "set"]);
    expect(await repairShardBrokerDbUrl({ secrets: s, mgmt }, shard("a"))).toBe("ok");
    expect(mgmt.poolerHost).toHaveBeenCalledTimes(1);
  });

  it("sweeps every shard; skips retired / unprovisioned; one failure does not stop the rest", async () => {
    const s = store({ a: DIRECT, b: POOLED, c: null, d: DIRECT.replace(REF, "bbbbbbbbbbbbbbbbbbbb").replace(REF, "bbbbbbbbbbbbbbbbbbbb"), e: DIRECT, g: DIRECT });
    const mgmt = {
      poolerHost: vi.fn(async (ref: string) => {
        if (ref === "bbbbbbbbbbbbbbbbbbbb") throw new Error("pooler config (no primary pooler)");
        return HOST;
      }),
      query: vi.fn(async () => []),
    };
    const r = await repairBrokerDbUrls({
      secrets: s,
      mgmt,
      listShards: async () => [
        shard("a"), shard("b"), shard("c"), shard("d", "bbbbbbbbbbbbbbbbbbbb"), shard("e", REF, "retired"), shard("f", null),
        shard("g", REF, "provisioning"),
      ],
    });
    expect(r).toEqual({ repaired: 1, ok: 1, missing: 1, failed: 1, failed_names: ["zavi-shard-dev-d"] });
    expect(s.v.get("a")).toBe(POOLED);
    expect(s.v.get("e")).toBe(DIRECT);
    expect(s.v.get("g")).toBe(DIRECT);
    expect(mgmt.query).toHaveBeenCalledWith(REF, BROKER_ROLE_TIMEOUT_SQL);
  });
});

describe("shard mgmt poolerHost (fake Management API)", () => {
  const ENV = { SUPABASE_MGMT_TOKEN: "t", SUPABASE_ORG_ID: "org-sites", SUPABASE_URL: "https://ownprojectrefaaaaaaa.supabase.co" };
  const mgmtWith = (body: unknown, status = 200) => {
    const fetchFn = vi.fn(async (_url: string) => ({ status, text: async () => JSON.stringify(body) }));
    return { m: createShardMgmt({ fetchFn, env: ENV }), fetchFn };
  };

  it("reads the PRIMARY entry's host from /config/database/pooler (never guessing the region)", async () => {
    const { m, fetchFn } = mgmtWith([
      { database_type: "READ_REPLICA", db_host: "aws-0-eu-west-1.pooler.supabase.com" },
      { database_type: "PRIMARY", db_host: "aws-1-us-west-1.pooler.supabase.com", db_port: 6543 },
    ]);
    expect(await m.poolerHost(REF)).toBe("aws-1-us-west-1.pooler.supabase.com");
    expect(String(fetchFn.mock.calls[0][0])).toContain(`/v1/projects/${REF}/config/database/pooler`);
  });

  it("refuses a non-pooler host, an empty answer, an HTTP error, and Zavi's own project", async () => {
    await expect(mgmtWith([{ database_type: "PRIMARY", db_host: `db.${REF}.supabase.co` }]).m.poolerHost(REF)).rejects.toThrow(/not a shared pooler host/);
    await expect(mgmtWith([]).m.poolerHost(REF)).rejects.toThrow(/no primary pooler/);
    await expect(
      mgmtWith([{ database_type: "READ_REPLICA", db_host: "aws-0-us-west-1.pooler.supabase.com" }]).m.poolerHost(REF),
    ).rejects.toThrow(/no primary pooler/);
    await expect(mgmtWith({}, 500).m.poolerHost(REF)).rejects.toThrow();
    const { m, fetchFn } = mgmtWith([]);
    await expect(m.poolerHost("ownprojectrefaaaaaaa")).rejects.toThrow(/Zavi's own/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("auth config resolver self-heal", () => {
  const row = { id: "s1", name: "zavi-shard-dev-1", project_ref: REF, url: `https://${REF}.supabase.co`, state: "open" } as ShardRow;
  const secrets = (db: string) => ({ anon_key: "anon", service_key: "svc", broker_db_url: db, hook_secret: "hook" }) as Record<string, string>;

  it("repairs a direct URL on resolve (single-flight) and returns the pooled one", async () => {
    let db = DIRECT;
    const repair = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      db = POOLED;
      return db;
    });
    const reg = { get: async () => row, getSecret: async (_id: string, n: string) => (n === "broker_db_url" ? db : secrets(db)[n]) };
    const res = registryAuthConfigResolver(reg as never, { repairBrokerUrl: repair });
    const [a, b] = await Promise.all([res.resolve("s1"), res.resolve("s1")]);
    expect(a?.dbUrl).toBe(POOLED);
    expect(b?.dbUrl).toBe(POOLED);
    expect(repair).toHaveBeenCalledTimes(1);
    expect((await res.resolve("s1"))?.dbUrl).toBe(POOLED);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("hourly maintenance runs the repair first, reports it, and keeps going when it throws", async () => {
    const { shardMaintenance } = await import("../maintenance");
    const registry = { list: async () => [] } as never;
    const sweepMetrics = vi.fn(async () => ({ measured: 0, failed: 0 }) as never);
    const ok = await shardMaintenance({
      registry, sql: { query: async () => [] }, env: "dev", resumeDeletions: null, sweepMetrics,
      repairBrokerUrls: async () => ({ repaired: 2, failed: 0, failed_names: [] }),
    });
    expect(ok.broker_urls).toEqual({ repaired: 2, failed: 0 });
    const log = vi.fn();
    const bad = await shardMaintenance({
      registry, sql: { query: async () => [] }, env: "dev", resumeDeletions: null, sweepMetrics, log,
      repairBrokerUrls: async () => {
        throw new Error("mgmt down");
      },
    });
    expect(bad.broker_urls).toBeNull();
    expect(log.mock.calls.some((c) => /broker_db_url repair: mgmt down/.test(String(c[0])))).toBe(true);
  });

  it("a failed repair resolves to null (never a cached unreachable handle), logs a stable code, and backs off", async () => {
    const log = vi.fn();
    let t = 1_000_000;
    const repair = vi.fn(async (): Promise<string | null> => {
      throw new Error("boom");
    });
    const reg = { get: async () => row, getSecret: async (_id: string, n: string) => secrets(DIRECT)[n] };
    const res = registryAuthConfigResolver(reg as never, { repairBrokerUrl: repair, log, now: () => t });
    expect(await res.resolve("s1")).toBeNull();
    expect(log.mock.calls[0][0]).toMatch(/sites\.broker_db_url\.repair_failed/);
    expect(await res.resolve("s1")).toBeNull();
    expect(repair).toHaveBeenCalledTimes(1);
    t += 31_000;
    repair.mockResolvedValueOnce(POOLED);
    expect((await res.resolve("s1"))?.dbUrl).toBe(POOLED);
    expect(repair).toHaveBeenCalledTimes(2);
  });
});
