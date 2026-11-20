import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SiteRow } from "@/services/sites/contract";
import { hostKey } from "@/services/sites/host-record";
import {
  advanceGraduation,
  GRADUATION_MAX_ATTEMPTS,
  HostVersionConflict,
  NO_IMPORTER,
  requestGraduation,
  type GraduationDeps,
  type GraduationRow,
  type GraduationState,
  type GraduationStore,
} from "../graduation";
import type { SiteImporter } from "../export-v2";

const T = "aaaaaaaa-0000-4000-8000-00000000000a";
const T2 = "bbbbbbbb-0000-4000-8000-00000000000b";
const SITE = "11111111-1111-4111-8111-111111111111";
const SHARD = "33333333-3333-4333-8333-333333333333";
const SRC = "shardsrcabcdefgh";
const DST = "dedicatedabcdefgh";
const HOST = "shop-ab12.zaviagent.com";

type Db = { status: Map<string, "active" | "suspended" | "gone">; records: Map<string, string>; inflight: string[] };

const STEPS: Array<[GraduationState, GraduationState]> = [
  ["requested", "project_ready"], ["project_ready", "suspended"], ["suspended", "imported"], ["imported", "verified"],
  ["switched", "archived"], ["imported", "suspended"],
];

function world(opts: { importer?: "ok" | "none" | "crash_once" | "always_fail"; kvFailOnce?: boolean; badHash?: boolean; lagging?: boolean } = {}) {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const dbs = new Map<string, Db>([
    [SRC, { status: new Map([[SITE, "active"]]), records: new Map(), inflight: [] }],
    [DST, { status: new Map(), records: new Map(), inflight: [] }],
  ]);
  let site = {
    id: SITE, tenant_id: T, hostname: HOST, backend_mode: "pooled", shard_id: SHARD, status: "live", host_version: 1,
    gateway_binding: { shard_id: SRC, shard_url: `https://${SRC}.supabase.co`, status: "active", manifest_hash: "mh" },
  } as unknown as SiteRow;
  const kv = new Map<string, string>([[hostKey(HOST), JSON.stringify({ rv: 1, shard_id: SRC, status: "active" })]]);
  let grad: GraduationRow | null = null;
  let lease = 0;
  const calls: string[] = [];

  const store: GraduationStore = {
    async request(tid, sid, reason, caps) {
      if (tid !== site.tenant_id || sid !== SITE) throw new Error("not found");
      if (grad && !["rolled_back", "build_dedicated"].includes(grad.state)) return { ...grad };
      if (site.backend_mode !== "pooled") throw new Error("not pooled");
      grad = {
        site_id: SITE, tenant_id: T, state: "requested", reason, capabilities: caps, source_shard_id: SHARD, source_project_ref: SRC,
        target_project_ref: null, target_url: null, counts: {}, sha256: null, attempts: 0, last_error: null, archive_after: null, switched_at: null,
      };
      return { ...grad };
    },
    requestBySite: async () => null,
    async get(tid) {
      return tid === T && grad ? { ...grad } : null;
    },
    async claim(tid, _s, secs) {
      if (tid !== T || !grad || ["archived", "rolled_back"].includes(grad.state) || lease > clock) return null;
      lease = clock + secs * 1000;
      grad = { ...grad, attempts: grad.attempts + 1 };
      return { ...grad };
    },
    async advance(tid, _s, from, to, patch = {}) {
      if (tid !== T || !grad || grad.state !== from) return null;
      const ok = from === to || STEPS.some(([a, b]) => a === from && b === to) || to === "rolled_back";
      if (!ok) throw new Error(`bad step ${from}->${to}`);
      grad = { ...grad, ...patch, state: to };
      if (to === "archived" || to === "rolled_back") lease = 0;
      return { ...grad };
    },
    async switchOver(tid, _s, expected, binding, archiveAfter) {
      if (tid !== T || !grad || grad.state !== "verified") throw new Error("not verified");
      if (site.backend_mode !== "pooled" || site.shard_id !== SHARD) throw new Error("not on source");
      if ((site.host_version ?? 0) !== expected) throw new HostVersionConflict();
      if (binding.shard_id !== grad.target_project_ref || binding.status !== "active") throw new Error("not the target");
      site = { ...site, backend_mode: "dedicated", shard_id: null, gateway_binding: binding, host_version: (site.host_version ?? 0) + 1 } as SiteRow;
      grad = { ...grad, state: "switched", archive_after: archiveAfter, switched_at: new Date(clock).toISOString() };
      calls.push("switch");
      return { ...site };
    },
    due: async () => [],
    dedicateStatic: async () => site,
    status: async (sid) => (sid === SITE && grad ? { ...grad } : null),
    auditPointer: async () => 0,
  };

  const lines = (db: Db) =>
    [...db.records.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, v]) => JSON.stringify({ id, v }));
  const sha = (db: Db) => createHash("sha256").update(lines(db).join("\n")).digest("hex");
  let crashed = false;
  const importer: SiteImporter =
    opts.importer === "none"
      ? NO_IMPORTER
      : {
          available: () => true,
          async import(i) {
            const target = dbs.get(i.project_ref)!;
            const dec = new TextDecoder();
            let n = 0;
            for await (const chunk of i.dump) {
              for (const l of dec.decode(chunk).split("\n").filter(Boolean)) {
                const { id, v } = JSON.parse(l) as { id: string; v: string };
                if (opts.importer === "always_fail") throw new Error("target schema mismatch");
                if (opts.importer === "crash_once" && !crashed && n === 2) {
                  crashed = true;
                  throw new Error("connection reset mid-import");
                }
                if (!target.records.has(id)) target.records.set(id, v);
                n++;
              }
            }
            return { records: n, files: 0, members: 0, sha256: sha(target) };
          },
        };

  const deps: GraduationDeps = {
    store,
    registry: { get: async (id: string) => (id === SHARD ? ({ id: SHARD, name: "zavi-shard-dev-1", project_ref: SRC, url: `https://${SRC}.supabase.co` } as never) : null) },
    sql: { query: async () => [] },
    storage: { list: async () => [], remove: async () => undefined },
    auth: null,
    kv: {
      get: async (k) => kv.get(k) ?? null,
      async put(k, v) {
        if (opts.kvFailOnce) {
          opts.kvFailOnce = false;
          throw new Error("kv 500");
        }
        kv.set(k, v);
      },
    },
    bumpHost: async (_t, _s, binding) => {
      site = { ...site, host_version: (site.host_version ?? 0) + 1, ...(binding !== undefined ? { gateway_binding: binding } : {}) } as SiteRow;
      return { ...site };
    },
    getSite: async () => ({ ...site }),
    importer,
    ensureDedicatedProject: async () => (calls.push("project"), { project_ref: DST, url: `https://${DST}.supabase.co` }),
    prepareKernel: async () => void calls.push("prepare"),
    deleteGuard: { tick: async () => true, maxPerHour: 5, alert: async () => undefined, error: () => undefined },
    graceDays: async () => 7,
    sourceLedger: async () => new Set(opts.lagging ? ["0005_contracts_archive_reindex"] : ["0005_contracts_archive_reindex", "0008_relational_api"]),
    alert: async (m) => void calls.push(`alert:${m.slice(0, 20)}`),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      const src = dbs.get(SRC)!;
      for (const id of src.inflight.splice(0)) src.records.set(id, `inflight-${id}`), acked.add(id);
    },
    ops: {
      suspend: async (_q, ref, sid) => (calls.push("suspend"), dbs.get(ref)!.status.set(sid, "suspended"), "frozen"),
      drained: async (_q, ref) => dbs.get(ref)!.inflight.length === 0,
      unsuspend: async (_q, ref, sid) => void (calls.push("unsuspend"), dbs.get(ref)!.status.set(sid, "active")),
      exporter: async function* (src) {
        exportedAt.push(clock);
        const enc = new TextEncoder();
        for (const l of lines(dbs.get(src.project_ref)!)) yield enc.encode(`${l}\n`);
      },
      hash: async (src) => {
        const db = dbs.get(src.project_ref)!;
        return { counts: { records: db.records.size }, sha256: opts.badHash && src.project_ref === DST ? "0".repeat(64) : sha(db) };
      },
      purge: async (_d, shard) => void (calls.push("purge"), dbs.get(shard.project_ref)!.records.clear(), dbs.get(shard.project_ref)!.status.set(SITE, "gone")),
    },
  };

  const acked = new Set<string>();
  const exportedAt: number[] = [];
  let n = 0;
  const write = (): boolean => {
    const b = JSON.parse(kv.get(hostKey(HOST)) as string) as { shard_id: string };
    const db = dbs.get(b.shard_id)!;
    const id = `r${String(n++).padStart(4, "0")}`;
    if (b.shard_id === SRC ? db.status.get(SITE) !== "active" : false) return false;
    db.records.set(id, `v-${id}`);
    acked.add(id);
    return true;
  };
  return { deps, dbs, kv, calls, acked, write, exportedAt, get site() { return site; }, get grad() { return grad; }, tick: (ms: number) => (clock += ms) };
}

const pooledSite = (w: ReturnType<typeof world>) => w.site;

describe("graduation (fakes): end to end", () => {
  it("export -> dedicated project -> import -> verify -> atomic switch -> KV flip, with no lost write", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) expect(w.write()).toBe(true);
    w.dbs.get(SRC)!.inflight.push("inflight-1");
    const req = await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "capability", capabilities: ["payments"] });
    expect(req.available).toBe(true);
    const out = await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE });
    expect(out.kind).toBe("switched");
    expect(w.calls.slice(0, 4)).toEqual(["project", "prepare", "suspend", "switch"]);
    expect(w.site.backend_mode).toBe("dedicated");
    expect(w.site.shard_id).toBeNull();
    expect(w.site.gateway_binding).toMatchObject({ shard_id: DST, status: "active", manifest_hash: "mh" });
    const kvRec = JSON.parse(w.kv.get(hostKey(HOST)) as string);
    expect(kvRec.rv).toBe(w.site.host_version);
    expect(kvRec.shard_id).toBe(DST);
    for (let i = 0; i < 3; i++) expect(w.write()).toBe(true);
    const dst = w.dbs.get(DST)!.records;
    for (const id of w.acked) expect(dst.has(id), id).toBe(true);
    expect(dst.size).toBe(w.acked.size);
    expect(w.grad?.state).toBe("switched");
  });

  it("refuses writes on the frozen pooled copy while the move runs (acknowledged = present)", async () => {
    const w = world();
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "founder", capabilities: [] });
    const origImport = w.deps.importer.import.bind(w.deps.importer);
    let refusedDuringMove = 0;
    w.deps.importer = {
      available: () => true,
      async import(i) {
        if (!w.write()) refusedDuringMove++;
        return origImport(i);
      },
    };
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
    expect(refusedDuringMove).toBe(1);
    for (const id of w.acked) expect(w.dbs.get(DST)!.records.has(id)).toBe(true);
  });

  it("an interrupted import resumes from suspended on the next pass (no second project, no duplicate)", async () => {
    const w = world({ importer: "crash_once" });
    for (let i = 0; i < 6; i++) w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "size", capabilities: [] });
    const first = await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE });
    expect(first).toMatchObject({ kind: "error", state: "suspended" });
    expect(w.grad?.last_error).toMatch(/connection reset/);
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("busy");
    w.tick(31 * 60_000);
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
    expect(w.calls.filter((c) => c === "project")).toHaveLength(1);
    expect(w.dbs.get(DST)!.records.size).toBe(6);
  });

  it("a crash between the switch and the KV write is converged by the next pass", async () => {
    const w = world({ kvFailOnce: true });
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "load", capabilities: [] });
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("error");
    expect(w.grad?.state).toBe("switched");
    expect(JSON.parse(w.kv.get(hostKey(HOST)) as string).shard_id).toBe(SRC);
    expect(w.write()).toBe(false);
    w.tick(31 * 60_000);
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
    expect(JSON.parse(w.kv.get(hostKey(HOST)) as string).shard_id).toBe(DST);
  });

  it("archives (purges) the frozen pooled copy only after the grace period", async () => {
    const w = world();
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "capability", capabilities: ["jobs"] });
    await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE });
    w.tick(31 * 60_000);
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
    expect(w.calls).not.toContain("purge");
    w.tick(8 * 86_400_000);
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("archived");
    expect(w.calls).toContain("purge");
    expect(w.dbs.get(DST)!.records.size).toBe(1);
  });

  it("unavailable (no importer / kernel prep): nothing is frozen and NO project is created", async () => {
    const w = world({ importer: "none" });
    const r = await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "capability", capabilities: ["payments"] });
    expect(r.available).toBe(false);
    expect(w.calls.some((c) => c.startsWith("alert:"))).toBe(true);
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("unavailable");
    expect(w.calls).not.toContain("suspend");
    expect(w.calls).not.toContain("project");
    expect(w.dbs.get(SRC)!.status.get(SITE)).toBe("active");
    const w2 = world();
    w2.deps.prepareKernel = null;
    await requestGraduation(w2.deps, { tenant_id: T, site: pooledSite(w2), reason: "capability", capabilities: ["payments"] });
    expect((await advanceGraduation(w2.deps, { tenant_id: T, site_id: SITE })).kind).toBe("unavailable");
    expect(w2.calls).not.toContain("project");
  });

  it("a request queued while unavailable keeps its retry budget: once wired it moves, never rolls back unattempted", async () => {
    const w = world();
    const prepare = w.deps.prepareKernel;
    w.deps.prepareKernel = null;
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "capability", capabilities: ["payments"] });
    for (let i = 0; i < GRADUATION_MAX_ATTEMPTS * 2; i++) {
      expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("unavailable");
      w.tick(3_600_000);
    }
    expect(w.grad?.attempts).toBe(0);
    w.deps.prepareKernel = prepare;
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
  });

  it("a copy that never verifies rolls back before the switch: pooled serves again, binding untouched", async () => {
    const w = world({ badHash: true });
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "size", capabilities: [] });
    let last = "";
    for (let i = 0; i < GRADUATION_MAX_ATTEMPTS + 3 && last !== "rolled_back"; i++) {
      last = (await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind;
      w.tick(31 * 60_000);
    }
    expect(last).toBe("rolled_back");
    expect(w.calls).not.toContain("switch");
    expect(w.calls).toContain("unsuspend");
    expect(w.site.backend_mode).toBe("pooled");
    expect(JSON.parse(w.kv.get(hostKey(HOST)) as string).shard_id).toBe(SRC);
    expect(w.write()).toBe(true);
  });

  it("the switch is a CAS on host_version: a concurrent host-record writer forces a re-read, never a lost update", async () => {
    const w = world();
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "founder", capabilities: [] });
    const realSwitch = w.deps.store.switchOver.bind(w.deps.store);
    let raced = false;
    w.deps.store.switchOver = async (t, s, expected, b, a) => {
      if (!raced) {
        raced = true;
        await w.deps.bumpHost(t, s);
      }
      return realSwitch(t, s, expected, b, a);
    };
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
    expect(raced).toBe(true);
  });

  it("export waits out the upload-token lifetime after the freeze (no token-acknowledged file is missed)", async () => {
    const w = world();
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "founder", capabilities: [] });
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("switched");
    const frozen = Date.parse(w.grad!.frozen_at as string);
    expect(w.exportedAt[0] - frozen).toBeGreaterThanOrEqual(600_000);
  });

  it("a lagging source shard (no v2 schema) is never frozen and gets no project", async () => {
    const w = world({ lagging: true });
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "capability", capabilities: ["jobs"] });
    expect((await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind).toBe("unavailable");
    expect(w.calls).not.toContain("project");
    expect(w.calls).not.toContain("suspend");
    expect(w.grad?.last_error).toMatch(/lacks 0008_relational_api/);
  });

  it("a move that keeps failing AFTER the freeze rolls back (the site is never left frozen)", async () => {
    const w = world({ importer: "always_fail" });
    w.write();
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "size", capabilities: [] });
    let last = "";
    for (let i = 0; i < GRADUATION_MAX_ATTEMPTS + 3 && last !== "rolled_back"; i++) {
      last = (await advanceGraduation(w.deps, { tenant_id: T, site_id: SITE })).kind;
      w.tick(31 * 60_000);
    }
    expect(last).toBe("rolled_back");
    expect(w.calls).toContain("unsuspend");
    expect(w.write()).toBe(true);
  });

  it("another tenant can neither request nor advance this site's graduation", async () => {
    const w = world();
    await expect(requestGraduation(w.deps, { tenant_id: T2, site: pooledSite(w), reason: "founder", capabilities: [] })).rejects.toThrow(/tenant/);
    await requestGraduation(w.deps, { tenant_id: T, site: pooledSite(w), reason: "founder", capabilities: [] });
    expect((await advanceGraduation(w.deps, { tenant_id: T2, site_id: SITE })).kind).toBe("busy");
    expect(w.calls).not.toContain("suspend");
  });
});
