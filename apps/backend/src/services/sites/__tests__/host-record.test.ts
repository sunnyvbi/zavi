import { describe, expect, it } from "vitest";
import { projectHostRecord, renderHostRecord, syncHostRecord, type GatewayBindingRow, type HostSyncDeps, type KvStore } from "../host-record";
import type { SiteRow } from "../contract";
import { siteRow, T1 } from "./fake-site-store";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const BINDING: GatewayBindingRow = { shard_id: "abcdefghijklmnopqrst", shard_url: "https://abcdefghijklmnopqrst.supabase.co", status: "active", manifest_hash: "m1" };
const DEPLOY = "d000000001-0000000a";

function db(row: SiteRow) {
  let cur: SiteRow = { ...row, host_version: 0 };
  return {
    row: () => cur,
    mutate: (p: Partial<SiteRow>) => void (cur = { ...cur, ...p }),
    bump: (async (_t: string, _s: string, binding?: GatewayBindingRow | null) => {
      if (binding !== undefined && cur.gateway_binding?.status === "tombstoned" && binding?.status !== "tombstoned") {
        throw new Error("tombstoned");
      }
      cur = { ...cur, host_version: (cur.host_version ?? 0) + 1, ...(binding !== undefined ? { gateway_binding: binding } : {}) };
      return { ...cur };
    }) as HostSyncDeps["bump"],
    get: (async () => ({ ...cur })) as HostSyncDeps["get"],
  };
}

function kv() {
  const m = new Map<string, string>();
  return {
    m,
    view(hold?: () => Promise<void>): KvStore {
      return {
        get: async (k) => m.get(k) ?? null,
        put: async (k, v) => {
          if (hold) await hold();
          m.set(k, v);
        },
      };
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("host record derived from the DB row", () => {
  it("renders both writers' fields and the version; deploy fields vanish once the site is deleting", () => {
    const r = renderHostRecord({ ...siteRow({ id: ID }), live_deploy_id: DEPLOY, live_sha: "abc1234", gateway_binding: BINDING, host_version: 4 })!;
    expect(r.value).toMatchObject({ deploy_id: DEPLOY, spa: true, v: 1, site_id: ID, ...BINDING, binding_version: 4, rv: 4 });
    const t = renderHostRecord({ ...siteRow({ id: ID }), status: "deleting", live_deploy_id: DEPLOY, live_sha: "abc1234", gateway_binding: { ...BINDING, status: "tombstoned" }, host_version: 5 })!;
    expect(t.value).not.toHaveProperty("deploy_id");
    expect(t.value.status).toBe("tombstoned");
    expect(t.ttl).toBeGreaterThan(0);
    expect(renderHostRecord(siteRow({ id: ID }))).toBeNull();
  });

  it("INTERLEAVING: a stale publish written AFTER a newer binding is repaired by the stale writer itself", async () => {
    const d = db(siteRow({ id: ID }));
    const k = kv();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    d.mutate({ live_deploy_id: DEPLOY, live_sha: "abc1234" });
    const p = syncHostRecord({ kv: k.view(async () => { if (!held) { held = true; await gate; } }), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID });
    await tick();
    await syncHostRecord({ kv: k.view(), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID, binding: BINDING });
    release();
    await p;
    const rec = JSON.parse(k.m.get(`host:${d.row().hostname}`) as string);
    expect(rec).toMatchObject({ deploy_id: DEPLOY, ...BINDING, rv: 2, binding_version: 2 });
  });

  it("FUZZ: 200 random interleavings of 4 writers always end at the newest full rendering", async () => {
    for (let trial = 0; trial < 200; trial++) {
      const d = db(siteRow({ id: ID }));
      const k = kv();
      const rnd = (n: number) => Math.floor(Math.random() * n);
      const delay = async () => {
        for (let i = rnd(4); i > 0; i--) await tick();
      };
      const writers = [
        async () => {
          await delay();
          d.mutate({ live_deploy_id: DEPLOY, live_sha: "abc1234" });
          await syncHostRecord({ kv: k.view(delay), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID });
        },
        async () => {
          await delay();
          await syncHostRecord({ kv: k.view(delay), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID, binding: BINDING });
        },
        async () => {
          await delay();
          await syncHostRecord({ kv: k.view(delay), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID, binding: { ...BINDING, manifest_hash: "m2" } });
        },
        async () => {
          await delay();
          d.mutate({ live_deploy_id: "d000000002-0000000b", live_sha: "def5678" });
          await syncHostRecord({ kv: k.view(delay), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID });
        },
      ];
      await Promise.all(writers.map((w) => w()));
      const want = renderHostRecord(d.row())!.value;
      expect(JSON.parse(k.m.get(`host:${d.row().hostname}`) as string)).toEqual(want);
      expect(want.rv).toBe(4);
      expect(want).toHaveProperty("deploy_id");
      expect(want).toHaveProperty("shard_id");
    }
  });

  it("a tombstoned binding is never revived (quarantine lives in the row)", async () => {
    const d = db(siteRow({ id: ID }));
    const k = kv();
    await syncHostRecord({ kv: k.view(), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID, binding: { ...BINDING, status: "tombstoned" } });
    await expect(syncHostRecord({ kv: k.view(), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID, binding: BINDING })).rejects.toThrow(/tombstoned/);
    expect(JSON.parse(k.m.get(`host:${d.row().hostname}`) as string).status).toBe("tombstoned");
  });

  it("refuses a row of another tenant", async () => {
    const d = db(siteRow({ id: ID, tenant_id: "22222222-2222-4222-8222-222222222222" }));
    await expect(syncHostRecord({ kv: kv().view(), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID })).rejects.toThrow(/tenant/);
  });
});

describe("host record: the public gateway config (staff per-site settings)", () => {
  it("renders turnstile / turnstile_site_key exactly as the gateway reads them; absent = the gateway's platform default", () => {
    const base = { ...siteRow({ id: ID }), gateway_binding: BINDING, host_version: 2 };
    const def = renderHostRecord(base)!.value;
    expect(def).not.toHaveProperty("turnstile");
    expect(def).not.toHaveProperty("turnstile_site_key");
    const off = renderHostRecord({ ...base, gateway_config: { turnstile: { enabled: false, site_key: "0x4AAAAAAAsitekey" } } })!.value;
    expect(off).toMatchObject({ turnstile: false, turnstile_site_key: "0x4AAAAAAAsitekey" });
    expect(renderHostRecord({ ...base, gateway_config: { turnstile: { enabled: true, site_key: null } } })!.value).toMatchObject({ turnstile: true });
    expect(renderHostRecord({ ...siteRow({ id: ID }), live_deploy_id: DEPLOY, live_sha: "abc1234", gateway_config: { turnstile: { enabled: false, site_key: null } } })!.value).not.toHaveProperty("turnstile");
  });
});

describe("host record: one projection rules", () => {
  it("a deleting / deleted / fell-back site never serves its backend: an active binding renders tombstoned, with the quarantine TTL", () => {
    for (const status of ["deleting", "deleted", "fell_back_old"] as const) {
      const r = renderHostRecord({ ...siteRow({ id: ID }), status, live_deploy_id: DEPLOY, live_sha: "abc1234", gateway_binding: BINDING, host_version: 9 })!;
      expect(r.value).toMatchObject({ site_id: ID, status: "tombstoned", rv: 9 });
      expect(r.value).not.toHaveProperty("deploy_id");
      expect(r.ttl).toBeGreaterThan(0);
    }
  });

  it("syncHostRecord asks the serialized reconciler to verify the version it converged on", async () => {
    const d = db(siteRow({ id: ID }));
    const asked: Array<[string, string, number]> = [];
    const v = await syncHostRecord(
      { kv: kv().view(), bump: d.bump, get: d.get, requestVerify: async (t, s, n) => void asked.push([t, s, n]) },
      { tenant_id: T1, site_id: ID, binding: BINDING },
    );
    expect(asked).toEqual([[T1, ID, v]]);
  });

  it("a stale KV value AHEAD of the snapshot is never overwritten with the older rendering", async () => {
    const d = db(siteRow({ id: ID }));
    const k = kv();
    await syncHostRecord({ kv: k.view(), bump: d.bump, get: d.get }, { tenant_id: T1, site_id: ID, binding: BINDING });
    const key = `host:${d.row().hostname}`;
    k.m.set(key, JSON.stringify({ v: 1, site_id: ID, rv: 50 }));
    await expect(projectHostRecord({ kv: k.view(), get: d.get }, { tenant_id: T1, site_id: ID })).rejects.toThrow(/ahead of the database/);
    expect(JSON.parse(k.m.get(key) as string).rv).toBe(50);
  });
});
