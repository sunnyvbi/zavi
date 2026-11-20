
import { describe, it, expect, beforeEach } from "vitest";
import { deleteSite, deleteTenantSites, teardownSiteProviders } from "../teardown";
import type { SitePublisher } from "../contract";
import { fakeRepo, fakeStore, fakeSupabase, providersOf, teardownDeps, type FakeStore } from "./site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

let store: FakeStore;
let order: string[];

function publisher(fail = false): SitePublisher {
  return {
    stage: async () => { throw new Error("unused"); },
    previewUrl: async () => { throw new Error("unused"); },
    activate: async () => { throw new Error("unused"); },
    verify: async () => true,
    teardown: async ({ site_id }) => {
      order.push(`edge:${site_id}`);
      if (fail) throw new Error("cf down");
    },
  };
}

async function liveSite(tenant: string, run: string) {
  const s = await store.getOrCreateForRun({ tenant_id: tenant, root_conductor_run_id: run, company_name: "Shop", started_by_user_id: null });
  for (const k of ["cloudflare_host", "r2_prefix", "supabase_project", "github_repo"] as const) {
    await store.claimProvider(tenant, s.id, k, k === "github_repo" ? { name: s.label, owner: "praxis-built" } : {});
    await store.setProviderState(tenant, s.id, k, "created");
  }
  await store.transition(tenant, s.id, ["provisioning"], "live");
  return s;
}

function deps(opts: { edgeFail?: boolean; sbFail?: boolean } = {}) {
  const repo = fakeRepo();
  const sb = fakeSupabase(store);
  sb.failTeardown = !!opts.sbFail;
  const origSbTeardown = sb.teardown;
  sb.teardown = async (i) => { order.push(`supabase:${i.site_id}`); return origSbTeardown(i); };
  repo.deleteRepo = async (full) => { order.push(`repo:${full}`); };
  const vault: string[] = [];
  const d = teardownDeps(store, repo, sb, vault);
  d.publisher = publisher(opts.edgeFail);
  d.deleteVaultKeys = async (t, s) => { order.push(`vault:${t}:${s}`); };
  return d;
}

beforeEach(() => {
  store = fakeStore();
  order = [];
});

describe("deleteSite", () => {
  it("the shared teardown path (the reaper's) stops functions too and reports a failed stop as pending", async () => {
    const s = await liveSite(T1, "rr");
    const d = deps();
    d.stopFunctions = async () => { throw new Error("kv down"); };
    const r = await teardownSiteProviders(T1, (await store.get(T1, s.id))!, d, { allowPurge: true });
    expect(r.complete).toBe(false);
    expect(r.pending).toContain("site_functions");
    d.stopFunctions = async (id) => { order.push(`functions:${id}`); };
    const again = await teardownSiteProviders(T1, (await store.get(T1, s.id))!, d, { allowPurge: true });
    expect(again.pending).not.toContain("site_functions");
    expect(order).toContain(`functions:${s.id}`);
  });

  it("stops the site's server functions FIRST, while the site is already 'deleting'", async () => {
    const s = await liveSite(T1, "rf");
    const d = deps();
    d.stopFunctions = async (id) => { order.push(`functions:${id}:${(await store.get(T1, id))?.status}`); };
    const r = await deleteSite(T1, s.id, d);
    expect(r.complete).toBe(true);
    expect(order[0]).toBe(`functions:${s.id}:deleting`);
  });

  it("a failed functions stop leaves the site 'deleting' (incomplete) but still tears the rest down", async () => {
    const s = await liveSite(T1, "rg");
    const d = deps();
    d.stopFunctions = async () => { throw new Error("db down"); };
    const r = await deleteSite(T1, s.id, d);
    expect(r.complete).toBe(false);
    expect(r.pending).toContain("site_functions");
    expect((await store.get(T1, s.id))?.status).toBe("deleting");
    expect(order).toContain(`vault:${T1}:${s.id}`);
  });

  it("tears down Cloudflare+R2, then Supabase, then the repo, then Vault, and ends 'deleted'", async () => {
    const s = await liveSite(T1, "r1");
    const r = await deleteSite(T1, s.id, deps());
    expect(r).toEqual({ complete: true, pending: [] });
    expect(order).toEqual([`edge:${s.id}`, `supabase:${s.id}`, `repo:praxis-built/${s.label}`, `vault:${T1}:${s.id}`]);
    expect(providersOf(store, T1, s.id).every((p) => p.state === "deleted")).toBe(true);
    expect((await store.get(T1, s.id))?.status).toBe("deleted");
  });

  it("deletes the site's Artifacts thumbnails; a failed delete keeps the site 'deleting' for the reaper", async () => {
    const s = await liveSite(T1, "rt");
    const d = deps();
    d.removeThumbnails = async (t, id) => {
      order.push(`thumb:${t}:${id}`);
      throw new Error("storage down");
    };
    const r = await deleteSite(T1, s.id, d);
    expect(order).toContain(`thumb:${T1}:${s.id}`);
    expect(r.complete).toBe(false);
    expect(r.pending).toEqual(["thumbnail"]);
    expect((await store.get(T1, s.id))?.status).toBe("deleting");
    expect(providersOf(store, T1, s.id).every((p) => p.state === "deleted")).toBe(true);
    d.removeThumbnails = async () => {};
    const again = await teardownSiteProviders(T1, (await store.get(T1, s.id))!, d, { allowPurge: true });
    expect(again.pending).not.toContain("thumbnail");
  });

  it("a failing vendor is recorded cleanup_pending and the site stays 'deleting' for the reaper", async () => {
    const s = await liveSite(T1, "r1");
    const r = await deleteSite(T1, s.id, deps({ edgeFail: true }));
    expect(r.complete).toBe(false);
    expect(r.pending.sort()).toEqual(["cloudflare_host", "r2_prefix"]);
    const states = Object.fromEntries(providersOf(store, T1, s.id).map((p) => [p.kind, p.state]));
    expect(states).toMatchObject({ cloudflare_host: "cleanup_pending", r2_prefix: "cleanup_pending", supabase_project: "deleted", github_repo: "deleted" });
    expect((await store.get(T1, s.id))?.status).toBe("deleting");
  });

  it("an unwired publisher is cleanup_pending, never silently 'deleted'", async () => {
    const s = await liveSite(T1, "r1");
    const d = deps();
    d.publisher = null;
    const r = await deleteSite(T1, s.id, d);
    expect(r.pending.sort()).toEqual(["cloudflare_host", "r2_prefix"]);
  });

  it("a failed state write throws (never reports a live resource as cleaned up)", async () => {
    const s = await liveSite(T1, "r1");
    store.failSetProviderState = true;
    await expect(deleteSite(T1, s.id, deps())).rejects.toThrow(/ledger down/);
  });

  it("is tenant-scoped: another tenant's site id is a no-op", async () => {
    const s = await liveSite(T1, "r1");
    const r = await deleteSite(T2, s.id, deps());
    expect(r.complete).toBe(true);
    expect(order).toEqual([]);
    expect((await store.get(T1, s.id))?.status).toBe("live");
  });

  it("teardownSiteProviders refuses a site of another tenant", async () => {
    const s = await liveSite(T1, "r1");
    await expect(teardownSiteProviders(T2, s, deps())).rejects.toThrow(/tenant mismatch/);
  });

  it("deleteTenantSites deletes only that tenant's sites (two sites each)", async () => {
    const a1 = await liveSite(T1, "a1");
    const a2 = await liveSite(T1, "a2");
    const b1 = await liveSite(T2, "b1");
    const out = await deleteTenantSites(T1, deps());
    expect(out.map((o) => o.site_id).sort()).toEqual([a1.id, a2.id].sort());
    expect((await store.get(T2, b1.id))?.status).toBe("live");
    expect(order.some((o) => o.includes(b1.id))).toBe(false);
  });

  it("one site's teardown throwing never skips the others; the failed one stays 'deleting' for the reaper (review F2)", async () => {
    const a1 = await liveSite(T1, "a1");
    const a2 = await liveSite(T1, "a2");
    const d = deps();
    const realList = d.listProviders;
    d.listProviders = async (tenant: string, site: string) => {
      if (site === a1.id) throw new Error("provider ledger unavailable");
      return realList(tenant, site);
    };
    const out = await deleteTenantSites(T1, d);
    const byId = Object.fromEntries(out.map((o) => [o.site_id, o.result]));
    expect(byId[a1.id]).toMatchObject({ complete: false, error: expect.stringContaining("provider ledger unavailable") });
    expect(byId[a2.id]).toMatchObject({ complete: true });
    expect((await store.get(T1, a1.id))?.status).toBe("deleting");
    expect((await store.get(T1, a2.id))?.status).toBe("deleted");
  });
});

describe("teardownSiteProviders — repo grace for reaped sites", () => {
  it("with repoGrace the repo is scheduled 7 days out, not deleted", async () => {
    const s = await liveSite(T1, "r1");
    const r = await teardownSiteProviders(T1, s, deps(), { repoGrace: true });
    expect(order.some((o) => o.startsWith("repo:"))).toBe(false);
    const repoRow = providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")!;
    expect(repoRow.state).toBe("delete_scheduled");
    expect(Date.parse(repoRow.scheduled_delete_at!) - store.now()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(r.scheduled).toEqual(expect.arrayContaining(["github_repo"]));
    expect(r.complete).toBe(false);
  });

  it("the reaper's purge deletes a scheduled repo only once it is due", async () => {
    const s = await liveSite(T1, "r1");
    await teardownSiteProviders(T1, s, deps(), { repoGrace: true });
    order = [];
    await teardownSiteProviders(T1, s, deps(), { repoGrace: true, allowPurge: true });
    expect(order.some((o) => o.startsWith("repo:"))).toBe(false);
    const realNow = store.now;
    store.now = () => realNow() + 8 * 86_400_000;
    await teardownSiteProviders(T1, s, deps(), { repoGrace: true, allowPurge: true });
    expect(order).toContain(`repo:praxis-built/${s.label}`);
    expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")!.state).toBe("deleted");
  });

  it("without repoGrace (saga fallback, account deletion) the repo is deleted at once, as before", async () => {
    const s = await liveSite(T1, "r1");
    await teardownSiteProviders(T1, s, deps());
    expect(order).toContain(`repo:praxis-built/${s.label}`);
  });
});

describe("pooled backend teardown (pooled_backend provider)", () => {
  async function pooledSite(tenant: string, run: string) {
    const s = await store.getOrCreateForRun({ tenant_id: tenant, root_conductor_run_id: run, company_name: "Shop", started_by_user_id: null });
    for (const k of ["cloudflare_host", "r2_prefix", "pooled_backend", "github_repo"] as const) {
      await store.claimProvider(tenant, s.id, k, k === "github_repo" ? { name: s.label, owner: "praxis-built" } : {});
      await store.setProviderState(tenant, s.id, k, "created");
    }
    await store.transition(tenant, s.id, ["provisioning"], "live");
    return s;
  }

  it("deletes the shard data (after the edge, before the repo) and settles the provider", async () => {
    const s = await pooledSite(T1, "p1");
    const d = deps();
    d.pooled = { deleteBackend: async ({ tenant_id, site }) => (order.push(`pooled:${tenant_id}:${site.id}`), "deleted") };
    const r = await deleteSite(T1, s.id, d);
    expect(r.complete).toBe(true);
    expect(order).toEqual([`edge:${s.id}`, `pooled:${T1}:${s.id}`, `repo:praxis-built/${s.label}`, `vault:${T1}:${s.id}`]);
    expect(providersOf(store, T1, s.id).find((p) => p.kind === "pooled_backend")?.state).toBe("deleted");
  });

  it("a breaker refusal / failure / unwired backend stays cleanup_pending for the reaper", async () => {
    for (const pooled of [
      { deleteBackend: async () => "refused" as const },
      { deleteBackend: async () => { throw new Error("shard down"); } },
      null,
    ]) {
      store = fakeStore();
      order = [];
      const s = await pooledSite(T1, "p2");
      const d = deps();
      d.pooled = pooled;
      const r = await deleteSite(T1, s.id, d);
      expect(r.complete).toBe(false);
      expect(r.pending).toContain("pooled_backend");
      expect(providersOf(store, T1, s.id).find((p) => p.kind === "pooled_backend")?.state).toBe("cleanup_pending");
    }
  });
});
