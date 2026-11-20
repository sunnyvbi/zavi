import { describe, expect, it } from "vitest";
import type { SiteRow } from "@/services/sites/contract";
import { applySiteBackend, deleteSiteBackend, PooledBackendUnavailable, reserveSitePublish, validateSiteBackend, type PooledSiteDeps } from "../pooled-site";
import type { ShardRow } from "../contract";
import type { KvStore } from "../gateway-kv";

const T = "aaaaaaaa-0000-4000-8000-00000000000a";
const SITE = "11111111-1111-4111-8111-111111111111";
const SHARD_ID = "33333333-3333-4333-8333-333333333333";
const REF = "shardrefabcdefgh";
const ADMIN = "44444444-4444-4444-8444-444444444444";

const site = (over: Partial<SiteRow> = {}): SiteRow =>
  ({
    id: SITE, tenant_id: T, hostname: "shop-ab12.zaviagent.com", owner_email: "founder@example.com",
    backend_mode: "static", shard_id: null, status: "publishing",
    ...over,
  }) as SiteRow;

const shardRow: ShardRow = {
  id: SHARD_ID, env: "dev", name: "zavi-shard-dev-1", project_ref: REF, url: `https://${REF}.supabase.co`,
  region: "us-west-1", state: "open", is_canary: false, schema_version: "0003_storage", provision_step: "done",
  max_sites: 2000, site_count: 1, created_at: "2026-10-01T00:00:00Z",
};

const manifestPkg = {
  validateManifest: (raw: unknown) =>
    (raw as { bad?: boolean })?.bad ? { ok: false as const, issues: [{ path: "collections.x.rules", code: "bad", message: "bad" }] } : { ok: true as const, value: raw, hash: "mh1" },
  diffManifest: () => [],
};

const bookings = { collections: { bookings: { rules: { create: ["anyone"], list: ["admin"], get: ["admin"] }, schema: { type: "object", properties: { name: { type: "string", maxLength: 80 } } } } } };

function world(over: { failAt?: string; shard?: Partial<ShardRow>; ledger?: string[]; adminRow?: boolean; collections?: Array<Record<string, unknown>> } = {}) {
  const steps: string[] = [];
  const step = (name: string) => {
    steps.push(name);
    if (over.failAt === name) throw new Error(`fail at ${name}`);
  };
  const kvMap = new Map<string, string>();
  const kv: KvStore = {
    async get(k) {
      return kvMap.get(k) ?? null;
    },
    async put(k, v) {
      step("kv.put");
      kvMap.set(k, v);
    },
  };
  const sqlLog: string[] = [];
  let row: SiteRow = { ...site(), host_version: 0, gateway_binding: null } as SiteRow;
  const deps: PooledSiteDeps = {
    bumpHost: async (_t, _s, binding) => {
      if (binding !== undefined && row.gateway_binding?.status === "tombstoned" && binding?.status !== "tombstoned") throw new Error("tombstoned");
      row = { ...row, host_version: (row.host_version ?? 0) + 1, ...(binding !== undefined ? { gateway_binding: binding } : {}) };
      return { ...row };
    },
    getSite: async () => ({ ...row }),
    registry: {
      place: async () => (step("place"), { shard: { id: SHARD_ID, project_ref: REF, url: shardRow.url as string }, placed: true }),
      get: async () => ({ ...shardRow, ...over.shard }),
      release: async () => (step("release"), true),
    } as unknown as PooledSiteDeps["registry"],
    sql: {
      async query(_ref, q) {
        sqlLog.push(q);
        if (q.startsWith("select to_regclass")) return [{ present: true }];
        if (q.startsWith("select version")) return (over.ledger ?? ["0001_core", "0002_api", "0003_storage", "0004_membership_slots_perf", "0005_contracts_archive_reindex", "0006_contract_v2", "0007_relational_slots_rls", "0008_relational_api"]).map((version) => ({ version }));
        if (q.includes("insert into zsite.sites")) return step("shard.site"), [{ status: "active" }];
        if (q.includes("insert into zsite.collections")) return step("collections"), [];
        if (q.includes("from zsite.collections")) return over.collections ?? [];
        if (q.includes("from zsite.members")) return step("admin.verify"), over.adminRow === false ? [] : [{ ok: 1 }];
        return [];
      },
    },
    storage: { list: async () => [], remove: async () => undefined },
    kv,
    routes: { ensure: async () => step("route"), remove: async () => step("route.remove") },
    manifest: manifestPkg,
    auth: {
      ensureFounderAdmin: async () => (step("founder.admin"), { user_id: ADMIN }),
      ownerMagicLink: async () => "https://link",
      deleteAuthUser: async () => undefined,
    },
    env: () => "dev",
    deleteGuard: { tick: async () => true, maxPerHour: 5, alert: async () => undefined, error: () => undefined },
  };
  return { deps, steps, kvMap, sqlLog };
}

describe("applySiteBackend: activation ORDER (binding goes active last)", () => {
  it("place -> shard ready -> site row -> collections -> founder admin (verified) -> KV write + read-back", async () => {
    const w = world();
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings });
    expect(out.kind).toBe("active");
    expect(w.steps).toEqual(["place", "shard.site", "collections", "founder.admin", "admin.verify", "route", "kv.put"]);
    const rec = JSON.parse(w.kvMap.get("host:shop-ab12.zaviagent.com") as string);
    expect(rec).toMatchObject({ status: "active", site_id: SITE, shard_id: REF, binding_version: 1, manifest_hash: "mh1", rv: 1 });
  });

  for (const failAt of ["place", "shard.site", "collections", "founder.admin", "route"]) {
    it(`a failure at ${failAt} leaves NO active binding`, async () => {
      const w = world({ failAt });
      await expect(applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings })).rejects.toThrow();
      expect(w.kvMap.size).toBe(0);
    });
  }

  it("an unverified founder admin membership blocks activation", async () => {
    const w = world({ adminRow: false });
    await expect(applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings })).rejects.toBeInstanceOf(PooledBackendUnavailable);
    expect(w.kvMap.size).toBe(0);
  });

  it("a shard that is not fully provisioned (auth hooks / key pending) or lacks the schema blocks activation", async () => {
    for (const w of [world({ shard: { provision_step: "auth_config" } }), world({ shard: { state: "provisioning" } }), world({ ledger: ["0001_core"] })]) {
      await expect(applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings })).rejects.toBeInstanceOf(PooledBackendUnavailable);
      expect(w.steps).not.toContain("shard.site");
      expect(w.kvMap.size).toBe(0);
    }
  });

  it("a form-only site (the starter's public submissions form, nothing else) is pooled like any data site", async () => {
    const { TEMPLATE_FILES } = await import("@/services/provisioning/templates/vite-react-zavi/template-files.generated");
    const starter = JSON.parse(TEMPLATE_FILES["zavi-site.json"]) as { collections: Record<string, { rules: { create: string[] } }> };
    expect(Object.keys(starter.collections)).toEqual(["submissions"]);
    expect(starter.collections.submissions.rules.create).toEqual(["anyone"]);
    const w = world();
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: starter })).kind).toBe("active");
    expect(w.steps).toContain("place");
    expect(w.steps).toContain("collections");
  });

  it("no collections: a static site stays static (no placement, nothing written)", async () => {
    const w = world();
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: { smoke: {} } })).kind).toBe("static");
    expect(w.steps).toEqual([]);
  });

  it("an invalid manifest is returned to the builder, nothing placed", async () => {
    const w = world();
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: { bad: true } });
    expect(out).toEqual({ kind: "invalid", errors: ["collections.x.rules: bad"] });
    expect(w.steps).toEqual([]);
  });

  it("a missing zavi-site.json keeps a static site static and is REFUSED on a pooled site (never archives everything)", async () => {
    const w = world();
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: null })).kind).toBe("static");
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site({ backend_mode: "pooled", shard_id: SHARD_ID }), manifestRaw: null });
    expect(out).toMatchObject({ kind: "invalid" });
    expect(w.steps).toEqual([]);
  });

  it("refuses a dedicated site and a site of another tenant", async () => {
    const w = world();
    await expect(applySiteBackend(w.deps, { tenant_id: T, site: site({ backend_mode: "dedicated" }), manifestRaw: bookings })).rejects.toThrow(/dedicated/);
    await expect(applySiteBackend(w.deps, { tenant_id: "bbbbbbbb-0000-4000-8000-00000000000b", site: site(), manifestRaw: bookings })).rejects.toThrow(/tenant/);
    expect(w.steps).toEqual([]);
  });

  it("without the auth broker (S3) wired, nothing is placed", async () => {
    const w = world();
    await expect(applySiteBackend({ ...w.deps, auth: null }, { tenant_id: T, site: site(), manifestRaw: bookings })).rejects.toBeInstanceOf(PooledBackendUnavailable);
    expect(w.steps).toEqual([]);
  });

  it("never issues site-supplied SQL: every shard statement is platform SQL on zsite / storage", async () => {
    const w = world();
    await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings });
    for (const q of w.sqlLog) expect(q).toMatch(/zsite\.|to_regclass/);
  });
});

describe("deleteSiteBackend", () => {
  it("is behind the delete breaker: a refusal deletes nothing", async () => {
    const w = world();
    w.deps.deleteGuard = { ...w.deps.deleteGuard, tick: async () => false };
    expect(await deleteSiteBackend(w.deps, { tenant_id: T, site: site({ backend_mode: "pooled", shard_id: SHARD_ID }) })).toBe("refused");
    expect(w.sqlLog).toEqual([]);
    expect(w.steps).toEqual([]);
  });

  it("delete tombstones the binding in the row (and so in KV) before deleting any data", async () => {
    const w = world();
    const order: string[] = [];
    const origPut = w.deps.kv.put.bind(w.deps.kv);
    w.deps.kv.put = async (k, v, o) => (order.push("kv"), origPut(k, v, o));
    w.deps.storage = { list: async () => (order.push("storage"), []), remove: async () => undefined };
    w.deps.sql = { query: async (_r, q) => (q.includes("to_regclass") ? [{ present: true }] : q.includes("as sites") ? [{ sites: 0 }] : []) };
    expect(await deleteSiteBackend(w.deps, { tenant_id: T, site: site({ backend_mode: "pooled", shard_id: SHARD_ID }) })).toBe("deleted");
    expect(JSON.parse(w.kvMap.get("host:shop-ab12.zaviagent.com") as string).status).toBe("tombstoned");
    expect(order.indexOf("kv")).toBeLessThan(order.indexOf("storage"));
  });

  it("a site with no shard is absent; another tenant's site throws", async () => {
    const w = world();
    expect(await deleteSiteBackend(w.deps, { tenant_id: T, site: site() })).toBe("absent");
    await expect(deleteSiteBackend(w.deps, { tenant_id: "bbbbbbbb-0000-4000-8000-00000000000b", site: site({ shard_id: SHARD_ID }) })).rejects.toThrow(/tenant/);
  });
});

describe("index changes on collections that hold records (S1 0005 reindex)", () => {
  const indexed = { collections: { bookings: { rules: { create: ["anyone"] }, indexes: { day: { type: "text", ops: ["eq"], sort: false } } } } };
  function withPending(doneAfter: number | null) {
    const w = world();
    const calls: string[] = [];
    let batches = 0;
    const base = w.deps.sql.query;
    w.deps.sql = {
      async query(ref, q) {
        calls.push(q);
        if (q.includes("where reindex_pending")) return [{ site_id: SITE, name: "bookings" }];
        if (q.startsWith("select zsite.reindex_batch(")) {
          batches++;
          const done = doneAfter !== null && batches >= doneAfter;
          return [{ r: { next_after: done ? null : "aaaaaaaa-0000-4000-8000-0000000000ff", gen: 1, rows: done ? 0 : 2000, done, restart: false } }];
        }
        if (q.startsWith("select name, kind")) return [{ name: "bookings", kind: "records", rules: { create: ["anyone"] }, schema: {}, fields: {}, indexes: {}, archived: false }];
        return base(ref, q);
      },
    };
    return { w, calls, batches: () => batches };
  }

  it("applies the change (no refusal) and drives reindex_batch to done", async () => {
    const { w, calls, batches } = withPending(3);
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: indexed });
    expect(out).toMatchObject({ kind: "active", index_building: [] });
    expect(batches()).toBe(3);
    expect(calls.some((q) => q.includes("index_change_with_records"))).toBe(false);
  });

  it("a rebuild that outlasts the deploy is reported as index_building, not an error", async () => {
    const { w } = withPending(null);
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: indexed });
    expect(out).toMatchObject({ kind: "active", index_building: ["bookings"] });
  });
});

describe("applySiteBackend: dedicated capabilities never get a pooled resource", () => {
  it("a declared capability returns dedicated_required before ANY placement, SQL or binding", async () => {
    const w = world();
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: { schemaVersion: 2, capabilities: ["webhooks"], collections: bookings.collections } });
    expect(out).toEqual({ kind: "dedicated_required", capabilities: ["webhooks"] });
    expect(w.steps).toEqual([]);
    expect(w.sqlLog).toEqual([]);
    expect(w.kvMap.size).toBe(0);
  });

  it("SQL (a path or a declared raw_sql) is REFUSED, never a route to a dedicated database; nothing placed or written", async () => {
    for (const input of [
      { manifestRaw: bookings, paths: ["supabase/migrations/001_x.sql"] },
      { manifestRaw: { schemaVersion: 2, capabilities: ["raw_sql", "payments"], collections: bookings.collections } },
    ]) {
      const w = world();
      const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), ...input });
      expect(out).toMatchObject({ kind: "refused", code: "raw_sql_refused" });
      expect((out as { reason: string }).reason).toMatch(/never runs SQL from a site/);
      expect(w.steps).toEqual([]);
      expect(w.sqlLog).toEqual([]);
      expect(w.kvMap.size).toBe(0);
    }
  });

  it("demotions are audited INSIDE the shard transaction; the Zavi DB gets a pointer after commit", async () => {
    const w = world();
    const base = w.deps.sql.query;
    w.deps.sql = {
      async query(ref, q) {
        if (q.startsWith("select schema_version")) return [{ schema_version: 2, roles: ["mod"], capabilities: [], actions: {}, aggregates: {} }];
        if (q.startsWith("select user_id::text as user_id, role from zsite.members")) return [{ user_id: ADMIN, role: "mod" }];
        return base(ref, q);
      },
    };
    const v2 = { schemaVersion: 2, roles: [], collections: bookings.collections };
    const pointers: unknown[] = [];
    w.deps.roleAudit = async (i) => void pointers.push(i);
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: v2 })).kind).toBe("active");
    const tx = w.sqlLog.find((q) => q.startsWith("begin;")) as string;
    expect(tx).toMatch(/insert into zsite_auth\.member_audit/);
    expect(tx).toMatch(/''set_role''/);
    expect(tx).toMatch(/role_removed_from_manifest/);
    expect(tx.indexOf("member_audit")).toBeLessThan(tx.lastIndexOf("commit;"));
    expect(pointers).toEqual([{ tenant_id: T, site_id: SITE, manifest_hash: "mh1", shard_ref: REF, holders: [{ user_id: ADMIN, role: "mod" }] }]);
    const w2 = world();
    w2.deps.sql = w.deps.sql;
    w2.deps.roleAudit = async () => {
      throw new Error("zavi db down");
    };
    expect((await applySiteBackend(w2.deps, { tenant_id: T, site: site(), manifestRaw: v2 })).kind).toBe("active");
  });

  it("a backfill refusal from the shard is returned founder-facing and leaves NO active binding", async () => {
    const w = world();
    const base = w.deps.sql.query;
    w.deps.sql = {
      async query(ref, q) {
        if (q.startsWith("begin;")) throw new Error(`ERROR: zavi_refused ${JSON.stringify({ code: "unique_duplicates", collection: "bookings", fields: ["name"], groups: 1, records: 2 })}`);
        return base(ref, q);
      },
    };
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings });
    expect(out).toMatchObject({ kind: "refused", code: "unique_duplicates" });
    expect((out as { reason: string }).reason).toMatch(/^2 records in "bookings"/);
    expect(w.kvMap.size).toBe(0);
  });
});

describe("schemaVersion 2 is carried end to end or refused, never truncated", () => {
  const V1_LEDGER = ["0001_core", "0002_api", "0003_storage", "0004_membership_slots_perf", "0005_contracts_archive_reindex"];
  const v2 = {
    schemaVersion: 2,
    roles: ["seller"],
    capabilities: [],
    collections: { bookings: { ...bookings.collections.bookings, unique: [{ fields: ["name"], nulls: "distinct" }] } },
    actions: {},
    aggregates: {},
  };

  it("a part the control plane would not write refuses the deploy (nothing placed or written)", async () => {
    for (const raw of [{ ...v2, workflows: {} }, { ...v2, collections: { bookings: { ...v2.collections.bookings, triggers: [] } } }]) {
      const w = world();
      const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: raw });
      expect(out.kind).toBe("invalid");
      expect((out as { errors: string[] }).errors[0]).toMatch(/cannot apply yet\. Nothing was changed/);
      expect(w.steps).toEqual([]);
    }
  });

  it("a v2 manifest on a shard without the v2 schema is refused, not applied as v1", async () => {
    const w = world({ ledger: V1_LEDGER });
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: v2 });
    expect(out).toMatchObject({ kind: "refused", code: "v2_unavailable" });
    expect(w.steps).not.toContain("collections");
    expect(w.kvMap.size).toBe(0);
  });

  it("a v1 manifest on that shard still applies through the v1 reconcile", async () => {
    const w = world({ ledger: V1_LEDGER });
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings })).kind).toBe("active");
    expect(w.sqlLog.some((q) => q.includes("site_contracts"))).toBe(false);
  });

  it("on a v2 shard every v2 part is written: the collection columns and the site contract", async () => {
    const w = world();
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: v2 })).kind).toBe("active");
    const tx = w.sqlLog.find((q) => q.startsWith("begin;")) as string;
    expect(tx).toMatch(/insert into zsite\.collections \(site_id, name, kind, rules, schema, fields, indexes, recipient, uniques, states, "references"\)/);
    expect(tx).toContain('[{"fields":["name"],"nulls":"distinct"}]');
    expect(tx).toMatch(/insert into zsite\.site_contracts[\s\S]*'\["seller"\]'::jsonb/);
  });
});

describe("applySiteBackend: a GRADUATED site uses its own kernel shard, never a placement", () => {
  const KERNEL_ID = "55555555-5555-4555-8555-555555555555";
  const KREF = "kernelrefabcdefghij";
  const graduated = (over: Partial<SiteRow> = {}) => site({ backend_mode: "dedicated", shard_id: null, kernel_shard_id: KERNEL_ID, ...over } as Partial<SiteRow>);
  function kernelWorld(dedicated_site_id: string | null) {
    const w = world();
    w.deps.registry = {
      ...w.deps.registry,
      place: async () => {
        throw new Error("a graduated site must never be placed");
      },
      get: async (id: string) =>
        id === KERNEL_ID
          ? ({ ...shardRow, id: KERNEL_ID, name: `zavi-shard-dev-k${"a".repeat(32)}`, project_ref: KREF, url: `https://${KREF}.supabase.co`, state: "full", dedicated_site_id } as ShardRow)
          : null,
    } as unknown as PooledSiteDeps["registry"];
    return w;
  }

  it("applies the collections (capabilities and all) on the kernel and binds the hostname to it", async () => {
    const w = kernelWorld(SITE);
    const raw = { schemaVersion: 2, capabilities: ["payments"], collections: bookings.collections };
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: graduated(), manifestRaw: raw, paths: ["supabase/migrations/001.sql"] });
    expect(out.kind).toBe("active");
    expect(w.steps).not.toContain("place");
    expect(JSON.parse(w.kvMap.get("host:shop-ab12.zaviagent.com") as string)).toMatchObject({ shard_id: KREF, status: "active" });
  });

  it("refuses a kernel row that is registered to another site; a plain dedicated site is refused", async () => {
    await expect(applySiteBackend(kernelWorld("99999999-9999-4999-8999-999999999999").deps, { tenant_id: T, site: graduated(), manifestRaw: bookings })).rejects.toBeInstanceOf(PooledBackendUnavailable);
    await expect(applySiteBackend(world().deps, { tenant_id: T, site: site({ backend_mode: "dedicated" }), manifestRaw: bookings })).rejects.toThrow(/dedicated site/);
  });
});

describe("deleting a GRADUATED site retires its one-site kernel shard (and nothing shared)", () => {
  const KREF = "kernelrefabcdefghij";
  function kw(withKernel = true) {
    const w = world();
    const removed: string[] = [];
    const deletedKv: string[] = [];
    let kernel: string | null = withKernel ? KREF : null;
    w.kvMap.set(`shard:${KREF}`, JSON.stringify({ apikey: "sb_publishable_x" }));
    w.kvMap.set(`shard:${REF}`, JSON.stringify({ apikey: "sb_publishable_shared" }));
    w.deps.kv.delete = async (k) => void (deletedKv.push(k), w.kvMap.delete(k));
    w.deps.signer = { put: async () => undefined, remove: async (ref) => void removed.push(ref) };
    w.deps.registry = {
      ...w.deps.registry,
      kernelRef: async () => kernel,
      retireKernel: async () => {
        const r = kernel;
        kernel = null;
        return r;
      },
    } as unknown as PooledSiteDeps["registry"];
    return { w, removed, deletedKv, get kernel() { return kernel; } };
  }
  const graduated = () => site({ backend_mode: "dedicated", shard_id: null, kernel_shard_id: "55555555-5555-4555-8555-555555555555", status: "deleting" } as Partial<SiteRow>);

  it("tombstones the hostname, removes its route, its KV shard key, its signer key and its registry row; idempotent", async () => {
    const k = kw();
    expect(await deleteSiteBackend(k.w.deps, { tenant_id: T, site: graduated() })).toBe("deleted");
    expect(JSON.parse(k.w.kvMap.get("host:shop-ab12.zaviagent.com") as string).status).toBe("tombstoned");
    expect(k.w.steps).toContain("route.remove");
    expect(k.deletedKv).toEqual([`shard:${KREF}`]);
    expect(k.w.kvMap.has(`shard:${REF}`)).toBe(true);
    expect(k.removed).toEqual([KREF]);
    expect(k.kernel).toBeNull();
    expect(k.w.sqlLog).toEqual([]);
    expect(await deleteSiteBackend(k.w.deps, { tenant_id: T, site: graduated() })).toBe("absent");
    expect(k.removed).toHaveLength(1);
  });

  it("a failure part way keeps the row, so the retry finishes it (resumable)", async () => {
    const k = kw();
    k.w.deps.signer = { put: async () => undefined, remove: async () => { throw new Error("cf 500"); } };
    await expect(deleteSiteBackend(k.w.deps, { tenant_id: T, site: graduated() })).rejects.toThrow(/cf 500/);
    expect(k.kernel).toBe(KREF);
    k.w.deps.signer = { put: async () => undefined, remove: async (ref) => void k.removed.push(ref) };
    expect(await deleteSiteBackend(k.w.deps, { tenant_id: T, site: graduated() })).toBe("deleted");
    expect(k.kernel).toBeNull();
  });

  it("a POOLED site's delete never touches its shared shard's registry row, KV key or signer key", async () => {
    const k = kw(false);
    k.w.deps.sql = { query: async (_r, q) => (q.includes("to_regclass") ? [{ present: true }] : []) };
    expect(await deleteSiteBackend(k.w.deps, { tenant_id: T, site: site({ backend_mode: "pooled", shard_id: SHARD_ID }) })).toBe("deleted");
    expect(k.deletedKv).toEqual([]);
    expect(k.removed).toEqual([]);
    expect(k.w.kvMap.has(`shard:${REF}`)).toBe(true);
  });

  it("a pooled site deleted MID-graduation (kernel prepared, not switched): pool data purged AND the kernel retired", async () => {
    const k = kw(true);
    k.w.deps.sql = { query: async (_r, q) => (q.includes("to_regclass") ? [{ present: true }] : []) };
    expect(await deleteSiteBackend(k.w.deps, { tenant_id: T, site: site({ backend_mode: "pooled", shard_id: SHARD_ID }) })).toBe("deleted");
    expect(k.w.steps).toContain("release");
    expect(k.deletedKv).toEqual([`shard:${KREF}`]);
    expect(k.removed).toEqual([KREF]);
    expect(k.kernel).toBeNull();
    expect(k.w.kvMap.has(`shard:${REF}`)).toBe(true);
  });

  it("retirement is behind the delete breaker too", async () => {
    const k = kw(true);
    k.w.deps.deleteGuard = { ...k.w.deps.deleteGuard, tick: async () => false };
    expect(await deleteSiteBackend(k.w.deps, { tenant_id: T, site: graduated() })).toBe("refused");
    expect(k.deletedKv).toEqual([]);
    expect(k.kernel).toBe(KREF);
  });
});

describe("validateSiteBackend / applySiteBackend additiveOnly", () => {
  const liveRooms = {
    name: "rooms", kind: "records", archived: false,
    rules: { create: ["admin"], list: ["anyone"] },
    schema: { type: "object", properties: { title: { type: "string", maxLength: 80 } }, required: [] },
    fields: {}, indexes: {}, recipient: null, uniques: [], states: null, references: {},
  };
  const placed = () => site({ backend_mode: "pooled", shard_id: SHARD_ID });
  const withRooms = (rooms: Record<string, unknown>) => ({
    collections: {
      rooms: { rules: { create: ["admin"], list: ["anyone"] }, schema: { type: "object", properties: { title: { type: "string", maxLength: 80 } }, required: [] }, ...rooms },
    },
  });

  it("is READ-ONLY: never places, writes collections, binds or routes", async () => {
    const w = world({ collections: [liveRooms] });
    const out = await validateSiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: withRooms({}) });
    expect(out).toEqual({ kind: "ok", unchanged: false });
    expect(w.steps).toEqual([]);
    expect(w.kvMap.size).toBe(0);
    expect(w.sqlLog.some((q) => /\b(insert|update|delete)\b/i.test(q))).toBe(false);
  });

  it("a site never placed has nothing live: every candidate is additive, and nothing is placed", async () => {
    const w = world();
    expect(await validateSiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings })).toEqual({ kind: "ok", unchanged: false });
    expect(w.steps).not.toContain("place");
  });

  it("refuses a candidate that removes a collection or a field, or narrows a rule (not_additive, with the reasons)", async () => {
    for (const [manifest, why] of [
      [bookings, 'removes the collection "rooms"'],
      [withRooms({ schema: { type: "object", properties: {}, required: [] } }), 'removes the field "title"'],
      [withRooms({ rules: { create: ["admin"] } }), "list (removed)"],
      [withRooms({ schema: { type: "object", properties: { title: { type: "integer" } }, required: [] } }), "changes type from string to integer"],
    ] as const) {
      const w = world({ collections: [liveRooms] });
      const out = await validateSiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: { ...manifest, collections: { ...(manifest as { collections: object }).collections } } });
      expect(out, why).toMatchObject({ kind: "refused", code: "not_additive", reason: expect.stringContaining(why) });
    }
  });

  it("accepts pure additions: a new collection, a new optional field, a looser limit, more principals", async () => {
    const w = world({ collections: [liveRooms] });
    const candidate = {
      collections: {
        ...withRooms({
          rules: { create: ["admin", "user"], list: ["anyone"] },
          schema: { type: "object", properties: { title: { type: "string", maxLength: 200 }, note: { type: "string", maxLength: 50 } }, required: [] },
        }).collections,
        ...bookings.collections,
      },
    };
    expect(await validateSiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: candidate })).toEqual({ kind: "ok", unchanged: false });
  });

  it("an invalid manifest is invalid at validate too (same validator as the apply)", async () => {
    const w = world();
    expect((await validateSiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: { bad: true } })).kind).toBe("invalid");
  });

  const FENCED_LEDGER = ["0001_core", "0002_api", "0003_storage", "0004_membership_slots_perf", "0005_contracts_archive_reindex", "0006_contract_v2", "0007_relational_slots_rls", "0008_relational_api", "0011_site_publish_fence"];

  it("the FENCING TOKEN: reserved (never lowered), then the contract transaction's first statement requires EXACTLY this generation", async () => {
    const w = world({ collections: [liveRooms], ledger: FENCED_LEDGER });
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: withRooms({ rules: { create: ["admin", "user"], list: ["anyone"] } }), generation: 7 })).kind).toBe("active");
    const reserveAt = w.sqlLog.findIndex((q) => q.includes("insert into zsite.site_fences"));
    const txAt = w.sqlLog.findIndex((q) => q.includes("$zavi_fence$"));
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    expect(txAt).toBeGreaterThan(reserveAt);
    expect(w.sqlLog[reserveAt]).toContain("where f.applied_generation < excluded.applied_generation");
    const tx = w.sqlLog[txAt];
    const fence = tx.indexOf("update zsite.site_fences");
    expect(fence).toBeGreaterThan(0);
    expect(tx).toContain("and applied_generation = 7;");
    expect(fence).toBeLessThan(tx.indexOf("zsite.collections"));
  });

  it("reserveSitePublish: reserves on the site's existing shard; an unplaced site has nothing to reserve; a shard without 0011 is unavailable", async () => {
    const w = world({ ledger: FENCED_LEDGER });
    expect(await reserveSitePublish(w.deps, { tenant_id: T, site: placed(), generation: 5 })).toBe("reserved");
    expect(w.sqlLog.filter((q) => q.includes("insert into zsite.site_fences") && q.includes(", 5)"))).toHaveLength(1);
    expect(await reserveSitePublish(w.deps, { tenant_id: T, site: site(), generation: 5 })).toBe("unplaced");
    await expect(reserveSitePublish(world().deps, { tenant_id: T, site: placed(), generation: 5 })).rejects.toBeInstanceOf(PooledBackendUnavailable);
    await expect(reserveSitePublish(w.deps, { tenant_id: "other", site: placed(), generation: 5 })).rejects.toThrow(/tenant mismatch/);
  });

  it("a newer generation already committed: the shard refuses (lease_lost), nothing bound", async () => {
    const w = world({ collections: [liveRooms], ledger: FENCED_LEDGER });
    const query = w.deps.sql.query;
    w.deps.sql.query = async (ref, q) => {
      if (q.includes("$zavi_fence$")) throw new Error('ERROR: zavi_refused {"code":"lease_lost"}');
      return query(ref, q);
    };
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: withRooms({ rules: { create: ["admin", "user"], list: ["anyone"] } }), generation: 3 });
    expect(out).toMatchObject({ kind: "refused", code: "lease_lost" });
    expect(w.kvMap.size).toBe(0);
  });

  it("the binding write is fenced too: a stale generation never overwrites the newer binding", async () => {
    const w = world({ ledger: FENCED_LEDGER });
    w.deps.bumpHost = async () => {
      throw new Error("site_host_bump failed (55000): site_host_bump: stale_generation");
    };
    expect(await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings, generation: 2 })).toMatchObject({ kind: "refused", code: "lease_lost" });
  });

  it("an UNCHANGED fenced commit still takes the token (a stale commit in flight is then refused)", async () => {
    const w = world({ collections: [liveRooms], ledger: FENCED_LEDGER });
    const q = w.deps.sql.query;
    w.deps.sql.query = async (ref, sql) => (sql.includes("from zsite.site_contracts") ? [{ schema_version: 1, roles: [], capabilities: [], actions: {}, aggregates: {} }] : q(ref, sql));
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: withRooms({}), generation: 4 })).kind).toBe("active");
    const fenceOnly = w.sqlLog.filter((s) => s.includes("update zsite.site_fences"));
    expect(fenceOnly).toHaveLength(1);
    expect(fenceOnly[0]).not.toContain("zsite.collections");
  });

  it("a fenced commit on a shard without the fencing column is unavailable (retry), never unfenced", async () => {
    const w = world();
    await expect(applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings, generation: 2 })).rejects.toBeInstanceOf(PooledBackendUnavailable);
    expect(w.kvMap.size).toBe(0);
  });

  it("a shard missing a schema file asks for a schema repair (auto rollout) and still fails retryable", async () => {
    const asked: string[] = [];
    const w = world();
    w.deps.onShardSchemaMissing = (ref, version) => void asked.push(`${ref}:${version}`);
    await expect(applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings, generation: 2 })).rejects.toThrow(/lacks schema 0011_site_publish_fence \(publish fencing\)/);
    await expect(reserveSitePublish(w.deps, { tenant_id: T, site: placed(), generation: 5 })).rejects.toBeInstanceOf(PooledBackendUnavailable);
    expect(asked).toHaveLength(2);
    expect(asked.every((a) => a.endsWith(":0011_site_publish_fence"))).toBe(true);
    w.deps.onShardSchemaMissing = () => {
      throw new Error("inngest down");
    };
    await expect(reserveSitePublish(w.deps, { tenant_id: T, site: placed(), generation: 5 })).rejects.toBeInstanceOf(PooledBackendUnavailable);
  });

  it("a lost commit lease (fence false) stops the apply before it places, writes or binds anything", async () => {
    const w = world();
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: site(), manifestRaw: bookings, fence: async () => false });
    expect(out).toMatchObject({ kind: "refused", code: "lease_lost" });
    expect(w.steps).toEqual([]);
    expect(w.kvMap.size).toBe(0);
  });

  it("a lease lost AFTER the contract transaction never writes the binding (the newer publish's stays)", async () => {
    const w = world({ collections: [liveRooms] });
    let calls = 0;
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: withRooms({}), fence: async () => ++calls <= 2 });
    expect(out).toMatchObject({ kind: "refused", code: "lease_lost" });
    expect(calls).toBe(3);
    expect(w.sqlLog.some((q) => q.startsWith("begin;") && q.includes("set local statement_timeout = '300s';"))).toBe(true);
    expect(w.steps).not.toContain("route");
    expect(w.kvMap.size).toBe(0);
  });

  it("the fence is checked again right before the contract transaction", async () => {
    const w = world({ collections: [liveRooms] });
    let calls = 0;
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: withRooms({}), fence: async () => ++calls === 1 });
    expect(out).toMatchObject({ kind: "refused", code: "lease_lost" });
    expect(calls).toBe(2);
    expect(w.sqlLog.some((q) => /insert into zsite\.collections|zsite_contract|update zsite\.collections/i.test(q))).toBe(false);
    expect(w.kvMap.size).toBe(0);
  });

  it("the COMMIT re-checks against the rows it changes: a contract that moved since validate is refused, nothing written or bound", async () => {
    const w = world({ collections: [liveRooms] });
    const out = await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: bookings, additiveOnly: true });
    expect(out).toMatchObject({ kind: "refused", code: "not_additive" });
    expect(w.steps).not.toContain("collections");
    expect(w.kvMap.size).toBe(0);
  });

  it("without additiveOnly (other callers) the apply keeps archiving a removed collection", async () => {
    const w = world({ collections: [liveRooms] });
    expect((await applySiteBackend(w.deps, { tenant_id: T, site: placed(), manifestRaw: bookings })).kind).toBe("active");
  });
});
