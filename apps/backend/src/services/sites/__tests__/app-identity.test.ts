
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}), serverClientFromBearer: () => ({}) }));

import {
  AppSelectionError,
  defaultSiteForTenant,
  resolveRepoEventOwner,
  resolveRequestedApp,
  siteForHostname,
  siteForRepo,
  siteForRun,
  type AppIdentityDeps,
} from "../app-identity";
import type { SiteRow } from "../contract";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const X = "cccccccc-0000-4000-8000-00000000000c";
const RUN_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const RUN_REFINE = "aaaaaaaa-2222-4000-8000-00000000000a";

function site(id: string, over: Partial<SiteRow> = {}): SiteRow {
  return {
    id, tenant_id: T, root_conductor_run_id: null, hostname: `${id.slice(0, 4)}.zavi.site`, github_full_name: `zavi-sites/${id.slice(0, 4)}`,
    status: "live", created_at: "2026-10-01T00:00:00Z", ...over,
  } as SiteRow;
}

function deps(rows: SiteRow[], markers: Record<string, { s0?: unknown }> = {}): AppIdentityDeps {
  return {
    store: () => ({
      get: async (tid, id) => rows.find((r) => r.tenant_id === tid && r.id === id) ?? null,
      getByRun: async (tid, run) => rows.find((r) => r.tenant_id === tid && r.root_conductor_run_id === run) ?? null,
      getByRepo: async (tid, repo) => rows.find((r) => r.tenant_id === tid && r.github_full_name?.toLowerCase() === repo.toLowerCase()) ?? null,
      listForTenant: async (tid) => rows.filter((r) => r.tenant_id === tid),
    }),
    resolver: () => ({
      byHostname: async (h) => {
        const r = rows.find((x) => x.hostname === h);
        return r ? { tenant_id: r.tenant_id, site_id: r.id, status: r.status } : null;
      },
      byRepo: async (n) => {
        const r = rows.find((x) => x.github_full_name?.toLowerCase() === n.toLowerCase());
        return r ? { tenant_id: r.tenant_id, site_id: r.id, status: r.status } : null;
      },
    }),
    readRunMarkers: async (tid, run) => (tid === T ? markers[run] ?? null : null),
  };
}

const rows = () => [
  site(A, { root_conductor_run_id: RUN_A, created_at: "2026-10-01T00:00:00Z" }),
  site(B, { created_at: "2026-10-02T00:00:00Z" }),
  site(X, { tenant_id: OTHER, created_at: "2026-10-03T00:00:00Z" }),
];

describe("canonical lookups", () => {
  it("repo -> site: own site only, case-insensitive; another tenant's repo is null", async () => {
    const d = deps(rows());
    expect((await siteForRepo(T, "ZAVI-SITES/AAAA", d))?.id).toBe(A);
    expect((await siteForRepo(T, "zavi-sites/bbbb", d))?.id).toBe(B);
    expect(await siteForRepo(T, "zavi-sites/cccc", d)).toBeNull();
    expect(await siteForRepo(T, "  ", d)).toBeNull();
  });

  it("hostname -> site: another tenant's host is null, never loaded", async () => {
    const d = deps(rows());
    expect((await siteForHostname(T, "AAAA.zavi.site", d))?.id).toBe(A);
    expect(await siteForHostname(T, "cccc.zavi.site", d)).toBeNull();
    expect(await siteForHostname(T, "nope.zavi.site", d)).toBeNull();
  });

  it("run -> site: root run, else the run's site marker; foreign / unknown / old-flow = null", async () => {
    const d = deps(rows(), { [RUN_REFINE]: { s0: B } });
    expect((await siteForRun(T, RUN_A, d))?.id).toBe(A);
    expect((await siteForRun(T, RUN_REFINE, d))?.id).toBe(B);
    expect(await siteForRun(OTHER, RUN_A, d)).toBeNull();
    expect(await siteForRun(T, "dddddddd-1111-4000-8000-00000000000d", d)).toBeNull();
    expect(await siteForRun(T, "not-a-run", d)).toBeNull();
    expect(await siteForRun(T, RUN_REFINE, deps(rows(), { [RUN_REFINE]: { s0: X } }))).toBeNull();
  });

  it("default site: most recent active, ignoring gone / failed sites and other tenants", async () => {
    expect((await defaultSiteForTenant(T, deps(rows())))?.id).toBe(B);
    const r = rows();
    r[1] = { ...r[1], status: "deleting" };
    expect((await defaultSiteForTenant(T, deps(r)))?.id).toBe(A);
    r[0] = { ...r[0], status: "failed" };
    expect(await defaultSiteForTenant(T, deps(r))).toBeNull();
  });
});

describe("webhook owner (repo -> site, pre-tenant)", () => {
  it("a site repo belongs to the site's tenant, whatever installation fired", async () => {
    const d = deps(rows());
    expect(await resolveRepoEventOwner("zavi-sites/aaaa", OTHER, d)).toEqual({
      kind: "site", tenant_id: T, site_id: A, status: "live", active: true, connector_mismatch: true,
    });
    expect(await resolveRepoEventOwner("zavi-sites/aaaa", T, d)).toMatchObject({ kind: "site", connector_mismatch: false });
    expect(await resolveRepoEventOwner("zavi-sites/aaaa", null, d)).toMatchObject({ kind: "site", connector_mismatch: false });
  });

  it("a deleted site is inactive; a plain repo keeps the connector tenant; a lookup error is lookup_failed", async () => {
    const r = rows();
    r[0] = { ...r[0], status: "deleted" };
    expect(await resolveRepoEventOwner("zavi-sites/aaaa", T, deps(r))).toMatchObject({ kind: "site", active: false });
    expect(await resolveRepoEventOwner("acme/web", T, deps(r))).toEqual({ kind: "not_site", tenant_id: T });
    expect(await resolveRepoEventOwner(null, T, deps(r))).toEqual({ kind: "not_site", tenant_id: T });
    const broken: AppIdentityDeps = { ...deps(r), resolver: () => ({ byHostname: async () => null, byRepo: async () => { throw new Error("down"); } }) };
    expect(await resolveRepoEventOwner("acme/web", T, broken)).toEqual({ kind: "lookup_failed", error: "down" });
  });
});

describe("resolveRequestedApp", () => {
  const sb = { from: () => { throw new Error("no session read expected"); } } as never;

  it("explicit site_id: own active site; another tenant's, a gone one, or a store outage is refused", async () => {
    const d = deps(rows());
    expect(await resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: A }, d)).toMatchObject({
      kind: "site", via: "site_id", run_id: RUN_A, site: { id: A },
    });
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: X }, d)).rejects.toMatchObject({ status: 404, code: "site_not_found" });
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: "x" }, d)).rejects.toBeInstanceOf(AppSelectionError);
    const r = rows();
    r[0] = { ...r[0], status: "deleted" };
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: A }, deps(r))).rejects.toMatchObject({ status: 404 });
    const down: AppIdentityDeps = { ...d, store: () => ({ ...d.store(), get: async () => { throw new Error("db"); } }) };
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: A }, down)).rejects.toMatchObject({ status: 503 });
  });

  it("app=workspace names the legacy app explicitly; with a site/session or any other value it is refused", async () => {
    const d = deps(rows());
    expect(await resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: undefined, app: "workspace" }, d)).toEqual({
      kind: "legacy", via: "workspace_app", run_id: null,
    });
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: undefined, app: "site" }, d)).rejects.toMatchObject({
      status: 400, code: "invalid_app",
    });
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: A, app: "workspace" }, d)).rejects.toMatchObject({
      status: 400, code: "app_selection_conflict",
    });
    await expect(resolveRequestedApp(sb, T, { build_session_id: RUN_A, site_id: undefined, app: "workspace" }, d)).rejects.toMatchObject({
      status: 400, code: "app_selection_conflict",
    });
  });

  it("nothing named: the default site, or legacy only when no active site exists", async () => {
    expect(await resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: undefined }, deps(rows()))).toMatchObject({
      kind: "site", via: "default_site", site: { id: B },
    });
    expect(await resolveRequestedApp(sb, T, { build_session_id: null, site_id: null }, deps([]))).toEqual({
      kind: "legacy", via: "no_active_site", run_id: null,
    });
    const down: AppIdentityDeps = { ...deps(rows()), store: () => ({ ...deps(rows()).store(), listForTenant: async () => { throw new Error("db"); } }) };
    await expect(resolveRequestedApp(sb, T, { build_session_id: undefined, site_id: undefined }, down)).rejects.toMatchObject({ status: 503 });
  });
});
