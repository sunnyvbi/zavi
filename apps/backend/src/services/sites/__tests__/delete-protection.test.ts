
import { describe, it, expect, beforeEach } from "vitest";
import { createSupabaseMgmt, type MgmtFetch } from "../supabase-mgmt";
import { cancelSiteProjectDeletion, createSupabaseSiteProvisioner, siteProjectName } from "../supabase-site-provisioner";
import { deleteSite, deleteTenantSites, type SiteTeardownDeps } from "../teardown";
import { reapSites, type SiteReaperCandidate } from "../site-reaper";
import { SITE_PROJECT_DELETE_GRACE_DAYS, type SupabaseSiteProvisioner } from "../contract";
import { SITE_DELETE_BUCKET, siteDeleteMaxPerHour, type SiteDeleteGuard } from "../delete-guard";
import { fakeRepo, fakeStore, providersOf, type FakeStore } from "./site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const ORG = "zavi-sites-org";
const DAY = 86_400_000;

type ApiProject = { id: string; name: string; organization_id: string; status: string };

let clock: number;
let store: FakeStore;
let api: Map<string, ApiProject>;
let apiCalls: string[];
let deleteNetworkFails: boolean;
let onDelete: (() => Promise<void>) | null;
let counts: Map<string, number>;
let tickFails: boolean;
let alerts: Array<{ code?: string; msg: string }>;
let errors: string[];
let vaultKeys: Set<string>;
let provisioner: SupabaseSiteProvisioner;
let refSeq = 0;

const fetchFn: MgmtFetch = async (url, init) => {
  const method = init?.method ?? "GET";
  const path = new URL(url).pathname;
  apiCalls.push(`${method} ${path}`);
  const res = (status: number, body?: unknown) => ({ status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  if (method === "GET" && path === "/v1/projects") return res(200, [...api.values()]);
  if (path.endsWith("/health")) return res(200, [{ name: "db", healthy: true }]);
  const m = path.match(/^\/v1\/projects\/([a-z0-9]+)(\/pause|\/restore)?$/);
  if (!m) return res(404);
  const p = api.get(m[1]);
  if (method === "GET") return p ? res(200, p) : res(404);
  if (!p) return res(404);
  if (m[2] === "/pause") { p.status = "INACTIVE"; return res(200, {}); }
  if (m[2] === "/restore") { p.status = "ACTIVE_HEALTHY"; return res(200, {}); }
  if (method === "DELETE") {
    if (onDelete) await onDelete();
    api.delete(p.id);
    if (deleteNetworkFails) throw new Error("socket hang up");
    return res(200, {});
  }
  return res(404);
};

function guard(): SiteDeleteGuard {
  return {
    tick: async (key, limit) => {
      if (tickFails) throw new Error("counter ledger down");
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= limit;
    },
    maxPerHour: 5,
    alert: async (i) => { alerts.push({ code: i.code, msg: i.msg }); },
    error: (m) => { errors.push(m); },
  };
}

function teardownDeps(): SiteTeardownDeps {
  return {
    store,
    listProviders: async (t, s) => providersOf(store, t, s),
    publisher: { stage: async () => { throw new Error("unused"); }, previewUrl: async () => { throw new Error("unused"); }, activate: async () => { throw new Error("unused"); }, verify: async () => true, teardown: async () => {} },
    supabase: provisioner,
    repo: fakeRepo(),
    deleteVaultKeys: async (_t, s) => { vaultKeys.delete(s); },
  };
}

function reaperDeps(cands: SiteReaperCandidate[], enabled = true) {
  return {
    candidates: async () => cands,
    teardown: teardownDeps(),
    enabled: () => enabled,
    envScope: () => ({ allowed: true }),
    now: () => new Date(clock),
  };
}

async function liveSite(tenant = T1, run = `r${++refSeq}`) {
  const s = await store.getOrCreateForRun({ tenant_id: tenant, root_conductor_run_id: run, company_name: "Shop", started_by_user_id: null });
  const ref = `proj${String(++refSeq).padStart(16, "0")}`;
  api.set(ref, { id: ref, name: siteProjectName(s.id), organization_id: ORG, status: "ACTIVE_HEALTHY" });
  for (const k of ["cloudflare_host", "r2_prefix", "github_repo", "supabase_project"] as const) {
    await store.claimProvider(tenant, s.id, k, k === "supabase_project" ? { project_ref: ref } : { name: s.label });
    await store.setProviderState(tenant, s.id, k, "created");
  }
  await store.update(tenant, s.id, { supabase_project_ref: ref });
  await store.transition(tenant, s.id, ["provisioning"], "live");
  vaultKeys.add(s.id);
  return { site: s, ref };
}

const sbRow = (tenant: string, site_id: string) => providersOf(store, tenant, site_id).find((p) => p.kind === "supabase_project")!;
const deletes = () => apiCalls.filter((c) => c.startsWith("DELETE")).length;
const cand = (site_id: string, tenant_id = T1): SiteReaperCandidate => ({ tenant_id, site_id, status: "deleting", tenant_slug: "real-co" });

beforeEach(() => {
  clock = Date.parse("2026-10-01T00:00:00Z");
  store = fakeStore();
  store.now = () => clock;
  api = new Map();
  apiCalls = [];
  deleteNetworkFails = false;
  onDelete = null;
  counts = new Map();
  tickFails = false;
  alerts = [];
  errors = [];
  vaultKeys = new Set();
  const mgmt = createSupabaseMgmt({ fetchFn, config: { token: "sbp_test", orgId: ORG, region: "us-west-1" } });
  provisioner = createSupabaseSiteProvisioner({
    mgmt: () => mgmt,
    store,
    vault: { get: async () => null, set: async () => {} },
    providerRow: async (t, s, kind) => {
      const r = store.providers.get(`${s}:${kind}`);
      return r && r.tenant_id === t ? { state: r.state, ref: r.ref, scheduled_delete_at: r.scheduled_delete_at ?? null } : null;
    },
    sleep: async () => {},
    now: () => clock,
    newPassword: () => "pw",
    deleteGuard: guard(),
    log: () => {},
  });
});

describe("7-day grace (soft delete)", () => {
  it("deleteSite pauses and schedules the project, never deletes it, and keeps the Vault keys", async () => {
    const { site, ref } = await liveSite();
    const r = await deleteSite(T1, site.id, teardownDeps());
    expect(r).toEqual({ complete: false, pending: [], scheduled: ["supabase_project"] });
    expect(deletes()).toBe(0);
    expect(api.get(ref)!.status).toBe("INACTIVE");
    const row = sbRow(T1, site.id);
    expect(row.state).toBe("delete_scheduled");
    expect(row.scheduled_delete_at).toBe(new Date(clock + SITE_PROJECT_DELETE_GRACE_DAYS * DAY).toISOString());
    expect(vaultKeys.has(site.id)).toBe(true);
    expect((await store.get(T1, site.id))?.status).toBe("deleting");
    expect(providersOf(store, T1, site.id).filter((p) => p.kind !== "supabase_project").every((p) => p.state === "deleted")).toBe(true);
  });

  it("a second teardown keeps the original schedule (never pushes it out)", async () => {
    const { site } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    const first = sbRow(T1, site.id).scheduled_delete_at;
    clock += 3 * DAY;
    await deleteSite(T1, site.id, teardownDeps());
    expect(sbRow(T1, site.id).scheduled_delete_at).toBe(first);
  });

  it("account deletion (deleteTenantSites) schedules every site's project, keeps its Vault keys, and the reaper drops them after the purge", async () => {
    const a = await liveSite(T1);
    const b = await liveSite(T1);
    const other = await liveSite(T2);
    const out = await deleteTenantSites(T1, teardownDeps());
    expect(out.map((o) => o.result)).toEqual([
      { complete: false, pending: [], scheduled: ["supabase_project"] },
      { complete: false, pending: [], scheduled: ["supabase_project"] },
    ]);
    expect(deletes()).toBe(0);
    for (const s of [a, b]) expect(sbRow(T1, s.site.id).state).toBe("delete_scheduled");
    expect(sbRow(T2, other.site.id).state).toBe("created");
    expect(api.get(other.ref)!.status).toBe("ACTIVE_HEALTHY");
    for (const s of [a, b]) expect(vaultKeys.has(s.site.id)).toBe(true);
    clock += SITE_PROJECT_DELETE_GRACE_DAYS * DAY + 1;
    const r = await reapSites(reaperDeps([cand(a.site.id), cand(b.site.id)]));
    expect(r.reaped.sort()).toEqual([a.site.id, b.site.id].sort());
    for (const s of [a, b]) {
      expect(sbRow(T1, s.site.id).state).toBe("deleted");
      expect(vaultKeys.has(s.site.id)).toBe(false);
    }
    expect(vaultKeys.has(other.site.id)).toBe(true);
  });

  it("the reaper does not hard-delete before 7 days", async () => {
    const { site, ref } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    clock += SITE_PROJECT_DELETE_GRACE_DAYS * DAY - 60_000;
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(r.reaped).toEqual([]);
    expect(deletes()).toBe(0);
    expect(api.has(ref)).toBe(true);
    expect(sbRow(T1, site.id).state).toBe("delete_scheduled");
    expect(vaultKeys.has(site.id)).toBe(true);
  });

  it("the reaper hard-deletes once 7 days have passed, then drops the Vault keys and marks the site deleted", async () => {
    const { site, ref } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    clock += SITE_PROJECT_DELETE_GRACE_DAYS * DAY + 1;
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(r.reaped).toEqual([site.id]);
    expect(apiCalls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /v1/projects/${ref}`]);
    const di = apiCalls.indexOf(`DELETE /v1/projects/${ref}`);
    expect(apiCalls[di - 1]).toBe(`GET /v1/projects/${ref}`);
    expect(api.has(ref)).toBe(false);
    const row = sbRow(T1, site.id);
    expect(row.state).toBe("deleted");
    expect(typeof row.ref.hard_deleted_at).toBe("string");
    expect(vaultKeys.has(site.id)).toBe(false);
    expect((await store.get(T1, site.id))?.status).toBe("deleted");
  });

  it("only the reaper purges: deleteSite after 7 days still does not delete", async () => {
    const { site } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    clock += 30 * DAY;
    await deleteSite(T1, site.id, teardownDeps());
    expect(deletes()).toBe(0);
  });

  it("the reaper in dry-run (INFRA_REAPER_ENABLED off) deletes nothing even when due", async () => {
    const { site } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    clock += 30 * DAY;
    await reapSites(reaperDeps([cand(site.id)], false));
    expect(deletes()).toBe(0);
  });
});

describe("cancelSiteProjectDeletion (restore path)", () => {
  it("clears the schedule, restores the project, keeps the keys, and nothing re-schedules or deletes it", async () => {
    const { site, ref } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    expect(await cancelSiteProjectDeletion(T1, site.id, provisioner)).toBe("restored");
    const row = sbRow(T1, site.id);
    expect(row.state).toBe("created");
    expect(row.scheduled_delete_at ?? null).toBeNull();
    expect(row.ref.retained).toBe(true);
    expect(api.get(ref)!.status).toBe("ACTIVE_HEALTHY");

    clock += 30 * DAY;
    await reapSites(reaperDeps([cand(site.id)]));
    await deleteSite(T1, site.id, teardownDeps());
    expect(deletes()).toBe(0);
    expect(api.get(ref)!.status).toBe("ACTIVE_HEALTHY");
    expect(sbRow(T1, site.id).state).toBe("created");
    expect(vaultKeys.has(site.id)).toBe(true);
  });

  it("is tenant-scoped and a no-op when nothing is scheduled", async () => {
    const { site } = await liveSite();
    expect(await cancelSiteProjectDeletion(T1, site.id, provisioner)).toBe("not_scheduled");
    await deleteSite(T1, site.id, teardownDeps());
    await expect(cancelSiteProjectDeletion(T2, site.id, provisioner)).rejects.toThrow(/not found/);
    expect(sbRow(T1, site.id).state).toBe("delete_scheduled");
  });
});

describe("circuit breaker", () => {
  it("refuses the 6th scheduled deletion in an hour: nothing paused, provider pending for a retry, loud error + alert", async () => {
    const sites = [];
    for (let i = 0; i < 6; i++) sites.push(await liveSite());
    await deleteTenantSites(T1, teardownDeps());
    const states = sites.map((s) => sbRow(T1, s.site.id).state);
    expect(states.filter((s) => s === "delete_scheduled")).toHaveLength(5);
    const refused = sites.find((s) => sbRow(T1, s.site.id).state === "cleanup_pending")!;
    expect(refused).toBeDefined();
    expect(api.get(refused.ref)!.status).toBe("ACTIVE_HEALTHY");
    expect(vaultKeys.has(refused.site.id)).toBe(true);
    expect(errors.some((e) => e.includes("sites.delete.circuit_open"))).toBe(true);
    expect(alerts.map((a) => a.code)).toContain("sites.delete.circuit_open");
    expect(counts.get(SITE_DELETE_BUCKET.schedule)).toBe(6);
  });

  it("refuses the hard delete at the limit: no DELETE, the project stays scheduled", async () => {
    const { site, ref } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    counts.set(SITE_DELETE_BUCKET.execute, 5);
    clock += 8 * DAY;
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(r.pending).toEqual([site.id]);
    expect(deletes()).toBe(0);
    expect(api.has(ref)).toBe(true);
    expect(sbRow(T1, site.id).state).toBe("delete_scheduled");
    expect(vaultKeys.has(site.id)).toBe(true);
    expect(alerts.map((a) => a.code)).toContain("sites.delete.circuit_open");
  });

  it("fails CLOSED when the counter cannot be read: no schedule, no pause, no delete", async () => {
    const { site, ref } = await liveSite();
    tickFails = true;
    const r = await deleteSite(T1, site.id, teardownDeps());
    expect(r.pending).toContain("supabase_project");
    expect(sbRow(T1, site.id).state).toBe("cleanup_pending");
    expect(api.get(ref)!.status).toBe("ACTIVE_HEALTHY");
    expect(apiCalls.some((c) => c.endsWith("/pause"))).toBe(false);
    expect(errors.some((e) => e.includes("sites.delete.circuit_open") && e.includes("counter_unavailable"))).toBe(true);
  });

  it("fails CLOSED on the hard delete too", async () => {
    const { site } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    tickFails = true;
    clock += 8 * DAY;
    await reapSites(reaperDeps([cand(site.id)]));
    expect(deletes()).toBe(0);
    expect(sbRow(T1, site.id).state).toBe("delete_scheduled");
  });
});

describe("final name check before the DELETE", () => {
  async function scheduledAndDue() {
    const s = await liveSite();
    await deleteSite(T1, s.site.id, teardownDeps());
    clock += 8 * DAY;
    return s;
  }

  it.each([
    ["the project was renamed (not this site's)", (p: ApiProject) => { p.name = "prod-main-db"; }],
    ["the project is another site's", (p: ApiProject) => { p.name = siteProjectName("99999999-9999-4999-8999-999999999999"); }],
    ["the project is in another org", (p: ApiProject) => { p.organization_id = "someone-elses-org"; }],
  ])("refuses when %s: no DELETE, stays scheduled, keys kept, loud error", async (_l, mutate) => {
    const { site, ref } = await scheduledAndDue();
    mutate(api.get(ref)!);
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(r.pending).toEqual([site.id]);
    expect(deletes()).toBe(0);
    expect(api.has(ref)).toBe(true);
    expect(sbRow(T1, site.id).state).toBe("delete_scheduled");
    expect(vaultKeys.has(site.id)).toBe(true);
    expect(errors.some((e) => e.includes("sites.delete.name_mismatch"))).toBe(true);
    expect(alerts.map((a) => a.code)).toContain("sites.delete.name_mismatch");
  });

  it("refuses on a 404 read: no DELETE, stays scheduled, keys kept", async () => {
    const { site, ref } = await scheduledAndDue();
    api.delete(ref);
    await reapSites(reaperDeps([cand(site.id)]));
    expect(deletes()).toBe(0);
    expect(sbRow(T1, site.id).state).toBe("delete_scheduled");
    expect(vaultKeys.has(site.id)).toBe(true);
    expect(errors.some((e) => e.includes("sites.delete.name_mismatch") && e.includes("not_found"))).toBe(true);
  });

  it("a DELETE whose response was lost is recognised on the next pass without a second DELETE", async () => {
    const { site, ref } = await scheduledAndDue();
    deleteNetworkFails = true;
    const first = await reapSites(reaperDeps([cand(site.id)]));
    expect(first.pending).toEqual([site.id]);
    expect(sbRow(T1, site.id).state).toBe("delete_issuing");
    expect(typeof sbRow(T1, site.id).ref.delete_issued_at).toBe("string");
    expect(vaultKeys.has(site.id)).toBe(true);
    expect(await cancelSiteProjectDeletion(T1, site.id, provisioner)).toBe("not_scheduled");
    await deleteSite(T1, site.id, teardownDeps());
    expect(sbRow(T1, site.id).state).toBe("delete_issuing");
    deleteNetworkFails = false;
    const second = await reapSites(reaperDeps([cand(site.id)]));
    expect(second.reaped).toEqual([site.id]);
    expect(apiCalls.filter((c) => c === `DELETE /v1/projects/${ref}`)).toHaveLength(1);
    expect(sbRow(T1, site.id).state).toBe("deleted");
    expect(vaultKeys.has(site.id)).toBe(false);
  });
});

describe("a cancellation racing the hard delete (compare-and-set before the DELETE)", () => {
  async function scheduledAndDue() {
    const s = await liveSite();
    await deleteSite(T1, s.site.id, teardownDeps());
    clock += 8 * DAY;
    return s;
  }

  it("a cancel that lands between the due read and the DELETE wins: no DELETE, restored, keys kept", async () => {
    const { site, ref } = await scheduledAndDue();
    let cancelled: string | null = null;
    store.beforeBegin = async () => {
      store.beforeBegin = undefined;
      cancelled = await cancelSiteProjectDeletion(T1, site.id, provisioner);
    };
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(cancelled).toBe("restored");
    expect(deletes()).toBe(0);
    expect(r.reaped).toEqual([]);
    expect(api.get(ref)!.status).toBe("ACTIVE_HEALTHY");
    const row = sbRow(T1, site.id);
    expect(row.state).toBe("created");
    expect(row.ref.retained).toBe(true);
    expect(row.ref.delete_issued_at).toBeUndefined();
    expect(vaultKeys.has(site.id)).toBe(true);
    clock += 30 * DAY;
    await reapSites(reaperDeps([cand(site.id)]));
    expect(deletes()).toBe(0);
  });

  it("a cancel while the DELETE is in flight refuses (never reports a restore it cannot deliver)", async () => {
    const { site, ref } = await scheduledAndDue();
    let cancelled: string | null = null;
    onDelete = async () => {
      onDelete = null;
      cancelled = await cancelSiteProjectDeletion(T1, site.id, provisioner);
    };
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(cancelled).toBe("not_scheduled");
    expect(r.reaped).toEqual([site.id]);
    expect(deletes()).toBe(1);
    expect(api.has(ref)).toBe(false);
    expect(sbRow(T1, site.id).state).toBe("deleted");
    expect(apiCalls.some((c) => c.endsWith("/restore"))).toBe(false);
  });

  it("a cancel after the row is 'delete_issuing' refuses and changes nothing", async () => {
    const { site, ref } = await scheduledAndDue();
    expect(await store.beginProviderDelete(T1, site.id, "supabase_project", "delete_scheduled")).toBe(true);
    const before = apiCalls.length;
    expect(await cancelSiteProjectDeletion(T1, site.id, provisioner)).toBe("not_scheduled");
    expect(apiCalls.length).toBe(before);
    expect(sbRow(T1, site.id).state).toBe("delete_issuing");
    expect(api.get(ref)!.status).toBe("INACTIVE");
  });

  it("the compare-and-set refuses a row that is not yet due, retained, or already issuing from a stale read", async () => {
    const { site } = await liveSite();
    await deleteSite(T1, site.id, teardownDeps());
    expect(await store.beginProviderDelete(T1, site.id, "supabase_project", "delete_scheduled")).toBe(false);
    clock += 8 * DAY;
    expect(await store.beginProviderDelete(T1, site.id, "supabase_project", "delete_issuing")).toBe(false);
    expect(await store.beginProviderDelete(T1, site.id, "supabase_project", "delete_scheduled")).toBe(true);
    expect(await store.beginProviderDelete(T1, site.id, "supabase_project", "delete_scheduled")).toBe(false);
    await expect(store.beginProviderDelete(T2, site.id, "supabase_project", "delete_issuing")).rejects.toThrow(/not found/);
  });

  it("a 'delete_issuing' row whose DELETE was never sent (crash) is finished with exactly one DELETE", async () => {
    const { site, ref } = await scheduledAndDue();
    expect(await store.beginProviderDelete(T1, site.id, "supabase_project", "delete_scheduled")).toBe(true);
    const r = await reapSites(reaperDeps([cand(site.id)]));
    expect(r.reaped).toEqual([site.id]);
    expect(apiCalls.filter((c) => c === `DELETE /v1/projects/${ref}`)).toHaveLength(1);
    expect(sbRow(T1, site.id).state).toBe("deleted");
    expect(vaultKeys.has(site.id)).toBe(false);
  });
});

describe("idle pause / restore is unchanged", () => {
  it("pause and restore never schedule or delete", async () => {
    const { site, ref } = await liveSite();
    await provisioner.pause({ tenant_id: T1, site_id: site.id });
    expect(api.get(ref)!.status).toBe("INACTIVE");
    await provisioner.restore({ tenant_id: T1, site_id: site.id });
    expect(api.get(ref)!.status).toBe("ACTIVE_HEALTHY");
    expect(sbRow(T1, site.id).state).toBe("created");
    expect(deletes()).toBe(0);
    expect(counts.size).toBe(0);
  });
});

describe("SITE_DELETE_MAX_PER_HOUR", () => {
  it("defaults to 5 and accepts a positive override only", () => {
    expect(siteDeleteMaxPerHour({})).toBe(5);
    expect(siteDeleteMaxPerHour({ SITE_DELETE_MAX_PER_HOUR: "12" })).toBe(12);
    expect(siteDeleteMaxPerHour({ SITE_DELETE_MAX_PER_HOUR: "0" })).toBe(5);
    expect(siteDeleteMaxPerHour({ SITE_DELETE_MAX_PER_HOUR: "abc" })).toBe(5);
  });
});
