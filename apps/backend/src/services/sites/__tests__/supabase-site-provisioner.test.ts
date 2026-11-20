
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createSupabaseSiteProvisioner,
  siteProjectName,
  SiteMigrationChecksumMismatch,
  MIGRATION_LEDGER,
  type ProviderRow,
  type SupabaseSiteProvisionerDeps,
} from "../supabase-site-provisioner";
import type { MgmtProject, SupabaseMgmt, SiteAuthAdmin } from "../supabase-mgmt";
import { siteVaultKey, type SiteRow, type SiteStore, type SiteProviderKind } from "../contract";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_EMAIL = "o'brien+owner@example.com";

function siteRow(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: S1, tenant_id: T1, root_conductor_run_id: null, started_by_user_id: null, owner_email: null,
    label: "shop-1a2b3c4d-aaaaaa", hostname: "shop-1a2b3c4d-aaaaaa.zaviagent.com", github_full_name: null,
    supabase_project_ref: null, supabase_url: null, status: "provisioning", live_url: null, desired_sha: null,
    live_sha: null, live_deploy_id: null, last_visit_at: null, last_edit_at: null, paused_at: null,
    last_error: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over,
  };
}

function harness(opts: { site?: Partial<SiteRow> } = {}) {
  let clock = 0;
  const events: string[] = [];
  const sites = new Map<string, SiteRow>([[S1, siteRow(opts.site)]]);
  const providers = new Map<string, ProviderRow>();
  const vault = new Map<string, string>();
  const projects: MgmtProject[] = [];
  const queries: string[] = [];
  const ledger = new Map<string, string>();
  const ledgerPresent = { value: true };
  let n = 0;
  const failCreateResponse = { value: false };
  const listFails = { value: false };
  const catalogRows: { value: unknown[] } = { value: [] };
  let authUsers: Array<{ id: string; email: string }> = [];
  const links: Array<{ email: string; redirect: string }> = [];
  const authBodies: string[] = [];

  const store: SiteStore = {
    getOrCreateForRun: async () => { throw new Error("unused"); },
    get: async (t, id) => { const s = sites.get(id); return s && s.tenant_id === t ? { ...s } : null; },
    getByRun: async () => null,
    getByRepo: async () => null,
    listForTenant: async () => [],
    update: async (t, id, patch) => {
      const s = sites.get(id);
      if (!s || s.tenant_id !== t) throw new Error("not found");
      events.push(`update:${Object.keys(patch).join(",")}`);
      Object.assign(s, patch);
      return { ...s };
    },
    transition: async () => null,
    settleStopped: async () => null,
    activateIfDesired: async () => false,
    claimProvider: async (t, id, kind, ref) => {
      events.push(`claim:${kind}`);
      const k = `${id}:${kind}`;
      const cur = providers.get(k);
      providers.set(k, { state: cur?.state ?? "claimed", ref: { ...(cur?.ref ?? {}), ...ref } });
    },
    setProviderState: async (t, id, kind, state, ref) => {
      events.push(`provider:${kind}:${state}`);
      const k = `${id}:${kind}`;
      const cur = providers.get(k);
      if (!cur) throw new Error("no claim");
      providers.set(k, { state, ref: { ...cur.ref, ...(ref ?? {}) } });
    },
    scheduleProviderDelete: async (t, id, kind, grace, ref) => {
      events.push(`provider:${kind}:delete_scheduled`);
      const k = `${id}:${kind}`;
      const cur = providers.get(k);
      if (!cur || cur.state === "deleted") throw new Error("no live claim");
      const at = cur.state === "delete_scheduled" && cur.scheduled_delete_at ? cur.scheduled_delete_at : new Date(clock + grace * 86_400_000).toISOString();
      providers.set(k, { state: "delete_scheduled", ref: { ...cur.ref, ...(ref ?? {}) }, scheduled_delete_at: at });
      return at;
    },
    cancelProviderDelete: async () => false,
    beginProviderDelete: async () => false,
  };

  const admin: SiteAuthAdmin = {
    createUser: async (email) => {
      authBodies.push(email);
      if (authUsers.some((u) => u.email.toLowerCase() === email.toLowerCase())) return { exists: true };
      const u = { id: OWNER_ID, email };
      authUsers.push(u);
      return { user: u };
    },
    listUsers: async (page, per) => authUsers.slice((page - 1) * per, page * per),
    generateMagicLink: async (email, redirect) => {
      links.push({ email, redirect });
      return `https://ref.supabase.co/auth/v1/verify?token=t${links.length}&redirect_to=${encodeURIComponent(redirect)}`;
    },
  };

  const mgmt: SupabaseMgmt = {
    orgId: "org-1",
    createProject: async ({ name }) => {
      events.push("POST");
      n += 1;
      const p = { ref: `proj${String(n).padStart(16, "0")}`, name, organization_id: "org-1", status: "ACTIVE_HEALTHY" };
      projects.push(p);
      if (failCreateResponse.value) throw new Error("timeout");
      return p;
    },
    getProject: async (ref) => projects.find((p) => p.ref === ref) ?? null,
    listProjectsByName: async (name) => {
      events.push("LIST");
      if (listFails.value) throw new Error("list down");
      return projects.filter((p) => p.name === name);
    },
    isHealthy: async (ref) => projects.find((p) => p.ref === ref)?.status === "ACTIVE_HEALTHY",
    apiKeys: async () => ({ anon: "anon-key", service_role: "service-key" }),
    query: async (_ref, sql) => {
      queries.push(sql);
      if (/^select to_regclass/.test(sql)) return [{ present: ledgerPresent.value }];
      if (sql === `select id, sha256 from ${MIGRATION_LEDGER};`) return [...ledger].map(([id, sha256]) => ({ id, sha256 }));
      const sel = sql.match(/select sha256 from zavi\._zavi_migrations where id = '([^']+)'/);
      if (sel) return ledger.has(sel[1]) ? [{ sha256: ledger.get(sel[1]) }] : [];
      const ins = sql.match(/insert into zavi\._zavi_migrations \(id, sha256\) values \('([^']+)', '([0-9a-f]+)'\)/);
      if (ins) ledger.set(ins[1], ins[2]);
      if (/update public\.profiles set role = 'admin'/.test(sql)) return [{ role: "admin" }];
      if (/^select problem from/.test(sql)) return catalogRows.value;
      if (/pg_auth_members/.test(sql) && /^select /.test(sql)) return [{ f: "roles-v1" }];
      return [];
    },
    pause: async (ref) => { events.push("PAUSE"); const p = projects.find((x) => x.ref === ref); if (!p) return "not_found"; p.status = "INACTIVE"; return "ok"; },
    restore: async (ref) => { events.push("RESTORE"); const p = projects.find((x) => x.ref === ref); if (!p) return "not_found"; p.status = "ACTIVE_HEALTHY"; return "ok"; },
    deleteSiteProject: async (ref) => { events.push("DELETE"); const i = projects.findIndex((x) => x.ref === ref); if (i < 0) return "not_found"; projects.splice(i, 1); return "ok"; },
    updateAuthConfig: async (_ref, c) => { events.push(`auth:${c.site_url}|${c.uri_allow_list}`); },
    authAdmin: () => admin,
  };

  const deps: Partial<SupabaseSiteProvisionerDeps> = {
    mgmt: () => mgmt,
    store,
    vault: {
      get: async (t, k) => vault.get(`${t}:${k}`) ?? null,
      set: async (t, k, v) => { events.push(`vault:${k}`); vault.set(`${t}:${k}`, v); },
    },
    providerRow: async (_t, id, kind: SiteProviderKind) => providers.get(`${id}:${kind}`) ?? null,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    newPassword: () => `pw-${events.length}`,
    deleteGuard: { tick: async () => true, maxPerHour: 5, alert: async () => {}, error: () => {} },
    log: () => {},
  };

  return {
    p: createSupabaseSiteProvisioner(deps),
    mgmt,
    events, sites, providers, vault, projects, queries, ledger, ledgerPresent, failCreateResponse, listFails, catalogRows,
    setAuthUsers: (u: typeof authUsers) => { authUsers = u; }, links, authBodies,
  };
}

describe("ensureProject (saga)", () => {
  it("claims the provider BEFORE the POST, then records created + ref, then keys", async () => {
    const h = harness();
    const ref = await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    expect(h.events.indexOf("claim:supabase_project")).toBeLessThan(h.events.indexOf("POST"));
    expect(h.events.indexOf(`vault:${siteVaultKey.dbPassword(S1)}`)).toBeLessThan(h.events.indexOf("POST"));
    expect(h.events.indexOf("POST")).toBeLessThan(h.events.indexOf("provider:supabase_project:created"));
    expect(h.projects).toHaveLength(1);
    expect(h.projects[0].name).toBe(siteProjectName(S1));
    expect(ref.url).toBe(`https://${ref.project_ref}.supabase.co`);
    expect(h.sites.get(S1)!.supabase_project_ref).toBe(ref.project_ref);
    expect(h.sites.get(S1)!.supabase_url).toBe(ref.url);
    expect(h.vault.get(`${T1}:${siteVaultKey.serviceRole(S1)}`)).toBe("service-key");
    expect(h.vault.get(`${T1}:${siteVaultKey.anon(S1)}`)).toBe("anon-key");
    expect(h.providers.get(`${S1}:supabase_project`)!.ref.project_ref).toBe(ref.project_ref);
  });

  it("crash window: POST succeeded, response lost; the retry rebinds by name (one project)", async () => {
    const h = harness();
    h.failCreateResponse.value = true;
    h.listFails.value = true;
    await expect(h.p.ensureProject({ tenant_id: T1, site_id: S1 })).rejects.toThrow();
    expect(h.projects).toHaveLength(1);
    expect(h.sites.get(S1)!.supabase_project_ref).toBeNull();

    h.failCreateResponse.value = false;
    h.listFails.value = false;
    const ref = await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    expect(h.projects).toHaveLength(1);
    expect(h.events.filter((e) => e === "POST")).toHaveLength(1);
    expect(ref.project_ref).toBe(h.projects[0].ref);
  });

  it("a lost response in the same call is rescued by a name lookup", async () => {
    const h = harness();
    h.failCreateResponse.value = true;
    const ref = await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    expect(h.projects).toHaveLength(1);
    expect(ref.project_ref).toBe(h.projects[0].ref);
  });

  it("the retry reuses the Vault DB password (never rotates it under a rebound project)", async () => {
    const h = harness();
    h.failCreateResponse.value = true;
    h.listFails.value = true;
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 }).catch(() => {});
    const pw = h.vault.get(`${T1}:${siteVaultKey.dbPassword(S1)}`);
    h.failCreateResponse.value = false;
    h.listFails.value = false;
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    expect(h.vault.get(`${T1}:${siteVaultKey.dbPassword(S1)}`)).toBe(pw);
  });

  it("a site that already records a ref never POSTs again", async () => {
    const h = harness();
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    expect(h.events.filter((e) => e === "POST")).toHaveLength(1);
  });

  it("another tenant's site id is not found", async () => {
    const h = harness();
    await expect(h.p.ensureProject({ tenant_id: T2, site_id: S1 })).rejects.toThrow(/not found/);
    expect(h.events).not.toContain("POST");
  });

  it("gives up when the project never becomes healthy", async () => {
    const h = harness();
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    h.projects[0].status = "COMING_UP";
    await expect(h.p.restore({ tenant_id: T1, site_id: S1 })).rejects.toThrow(/healthy/);
  });
});

describe("configureAuth", () => {
  it("sets site_url and the allow list to the site's own hostname", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await h.p.configureAuth({ tenant_id: T1, site_id: S1, site_url: "https://shop-1a2b3c4d-aaaaaa.zaviagent.com" });
    expect(h.events).toContain("auth:https://shop-1a2b3c4d-aaaaaa.zaviagent.com|https://shop-1a2b3c4d-aaaaaa.zaviagent.com/**");
  });

  it("refuses a site_url on another host", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await expect(h.p.configureAuth({ tenant_id: T1, site_id: S1, site_url: "https://evil.example.com" })).rejects.toThrow();
  });
});

describe("applySql", () => {
  const base = { tenant_id: T1, site_id: S1 };

  it("bootstraps the ledger on a fresh project before reading it", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    expect(await h.p.applySql({ ...base, migration_id: "000_starter", sql: "create table t(id int);" })).toBe("applied");
    expect(h.queries[0]).toContain(`create table if not exists ${MIGRATION_LEDGER}`);
    expect(h.queries[1]).toContain(`select sha256 from ${MIGRATION_LEDGER}`);
    expect(h.queries[2]).toContain("pg_auth_members");
    expect(h.queries[3]).toContain("create table t(id int);");
    expect(h.queries[3]).toContain(`insert into ${MIGRATION_LEDGER}`);
  });

  it("asserts the catalog inside the migration's transaction, between the migration and its ledger row", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await h.p.applySql({ ...base, migration_id: "001_x", sql: "create table public.a (id int);" });
    const run = h.queries.find((q) => q.includes("create table public.a (id int);"))!;
    const mig = run.indexOf("create table public.a (id int);");
    const check = run.indexOf("zavi catalog check failed");
    const ledger = run.indexOf(`insert into ${MIGRATION_LEDGER}`);
    expect(mig).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(mig);
    expect(ledger).toBeGreaterThan(check);
    expect(run).toContain("table without row level security");
    expect(run).toContain("database roles, role memberships or role settings changed");
  });

  it("a site migration runs between the row-guard snapshot and assertion (its LAST statement, after deferred triggers fired), in one transaction (the starter does not)", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await h.p.applySql({ ...base, migration_id: "002_y", sql: "create table public.b (id int);", preserveExistingRows: true });
    const run = h.queries.find((q) => q.includes("create table public.b (id int);"))!;
    const snap = run.indexOf("create temp table zavi_rows_");
    const mig = run.indexOf("create table public.b (id int);");
    const guard = run.indexOf("zavi existing rows changed");
    const ledger = run.indexOf(`insert into ${MIGRATION_LEDGER}`);
    expect(snap).toBe(0);
    expect(mig).toBeGreaterThan(snap);
    const immediate = run.indexOf("set constraints all immediate;");
    expect(immediate).toBeGreaterThan(mig);
    expect(ledger).toBeGreaterThan(mig);
    expect(guard).toBeGreaterThan(ledger);
    expect(run.lastIndexOf("set constraints all immediate;")).toBeLessThan(guard);
    await h.p.applySql({ ...base, migration_id: "000_starter", sql: "create table s(id int);" });
    expect(h.queries.find((q) => q.includes("create table s(id int);"))).not.toContain("zavi_rows_");
  });

  it("verifyCatalog returns the problems the catalog query reports", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    h.catalogRows.value = [{ problem: "table without row level security: public.x" }];
    expect(await h.p.verifyCatalog({ ...base })).toEqual(["table without row level security: public.x"]);
    h.catalogRows.value = [];
    expect(await h.p.verifyCatalog({ ...base })).toEqual([]);
  });

  it("skips an applied id with the same checksum", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await h.p.applySql({ ...base, migration_id: "001_x", sql: "select 1;" });
    expect(await h.p.applySql({ ...base, migration_id: "001_x", sql: "select 1;" })).toBe("skipped");
  });

  it("fails loudly when an applied id's checksum changed", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await h.p.applySql({ ...base, migration_id: "001_x", sql: "select 1;" });
    await expect(h.p.applySql({ ...base, migration_id: "001_x", sql: "select 2;" })).rejects.toBeInstanceOf(SiteMigrationChecksumMismatch);
  });

  it("runs the guard only for a migration that has not been applied, and never executes a refused one", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    const refuse = () => {
      throw new Error("refused by policy");
    };
    await expect(h.p.applySql({ ...base, migration_id: "002_bad", sql: "drop table t;", guard: refuse })).rejects.toThrow(/refused by policy/);
    expect(h.queries.some((q) => q.includes("drop table t;"))).toBe(false);
    await h.p.applySql({ ...base, migration_id: "003_ok", sql: "select 1;" });
    const guard = vi.fn();
    expect(await h.p.applySql({ ...base, migration_id: "003_ok", sql: "select 1;", guard })).toBe("skipped");
    expect(guard).not.toHaveBeenCalled();
  });

  it("rejects a migration id that could break out of the SQL literal", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await expect(h.p.applySql({ ...base, migration_id: "x'); drop table t; --", sql: "select 1;" })).rejects.toThrow(/invalid migration id/);
    expect(h.queries).toHaveLength(0);
  });
});

describe("ensureOwnerAdmin", () => {
  it("creates the user and grants admin by UUID; the email never enters SQL", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    const r = await h.p.ensureOwnerAdmin({ tenant_id: T1, site_id: S1, owner_email: OWNER_EMAIL });
    expect(r.user_id).toBe(OWNER_ID);
    expect(h.authBodies).toEqual([OWNER_EMAIL]);
    const upd = h.queries.find((q) => q.includes("update public.profiles"))!;
    expect(upd).toContain(`'${OWNER_ID}'::uuid`);
    for (const q of h.queries) {
      expect(q).not.toContain(OWNER_EMAIL);
      expect(q).not.toContain("example.com");
    }
  });

  it("an already-registered owner is looked up by email through the admin API", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    h.setAuthUsers([{ id: "44444444-4444-4444-8444-444444444444", email: "someone@else.test" }, { id: OWNER_ID, email: OWNER_EMAIL.toUpperCase() }]);
    const r = await h.p.ensureOwnerAdmin({ tenant_id: T1, site_id: S1, owner_email: OWNER_EMAIL });
    expect(r.user_id).toBe(OWNER_ID);
  });

  it("refuses a non-UUID user id rather than interpolating it", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    h.setAuthUsers([{ id: "1' or '1'='1", email: OWNER_EMAIL }]);
    await expect(h.p.ensureOwnerAdmin({ tenant_id: T1, site_id: S1, owner_email: OWNER_EMAIL })).rejects.toThrow(/uuid/);
    expect(h.queries.some((q) => q.includes("update public.profiles"))).toBe(false);
  });
});

describe("ownerMagicLink", () => {
  const base = { tenant_id: T1, site_id: S1, owner_email: "owner@example.com" };

  it("mints a new link on every call, redirecting under the site host", async () => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    const a = await h.p.ownerMagicLink({ ...base, redirect_to: "https://shop-1a2b3c4d-aaaaaa.zaviagent.com/admin" });
    const b = await h.p.ownerMagicLink({ ...base, redirect_to: "https://shop-1a2b3c4d-aaaaaa.zaviagent.com/admin" });
    expect(a).not.toBe(b);
    expect(h.links).toHaveLength(2);
  });

  it.each([
    "https://evil.example.com/admin",
    "https://shop-1a2b3c4d-aaaaaa.zaviagent.com.evil.example.com/admin",
    "http://shop-1a2b3c4d-aaaaaa.zaviagent.com/admin",
    "https://user@shop-1a2b3c4d-aaaaaa.zaviagent.com/admin",
    "https://other-site.zaviagent.com/admin",
    "not a url",
  ])("rejects a redirect outside the site host: %s", async (redirect_to) => {
    const h = harness({ site: { supabase_project_ref: "projref0000000001" } });
    await expect(h.p.ownerMagicLink({ ...base, redirect_to })).rejects.toThrow(/redirect/);
    expect(h.links).toHaveLength(0);
  });
});

describe("pause / restore / teardown", () => {
  it("pause and restore are idempotent and record the provider state", async () => {
    const h = harness();
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    expect(await h.p.pause({ tenant_id: T1, site_id: S1 })).toBe("paused");
    expect(await h.p.pause({ tenant_id: T1, site_id: S1 })).toBe("paused");
    expect(h.events.filter((e) => e === "PAUSE")).toHaveLength(1);
    expect(h.providers.get(`${S1}:supabase_project`)!.ref.paused).toBe(true);
    await h.p.restore({ tenant_id: T1, site_id: S1 });
    await h.p.restore({ tenant_id: T1, site_id: S1 });
    expect(h.events.filter((e) => e === "RESTORE")).toHaveLength(1);
    expect(h.providers.get(`${S1}:supabase_project`)!.ref.paused).toBe(false);
  });

  it("a paid org refusing the pause returns 'unsupported' and records nothing", async () => {
    const h = harness();
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    const before = { ...(h.providers.get(`${S1}:supabase_project`)!.ref) };
    h.mgmt.pause = async () => "unsupported";
    expect(await h.p.pause({ tenant_id: T1, site_id: S1 })).toBe("unsupported");
    expect(h.providers.get(`${S1}:supabase_project`)!.ref).toEqual(before);
    expect(h.providers.get(`${S1}:supabase_project`)!.ref.paused).not.toBe(true);
  });

  it("a site with no project of its own (pooled) or a vanished project reports no_project", async () => {
    const pooled = harness({ site: { supabase_project_ref: null } });
    expect(await pooled.p.pause({ tenant_id: T1, site_id: S1 })).toBe("no_project");
    expect(pooled.events).not.toContain("PAUSE");
    const h = harness();
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 });
    h.projects.splice(0, h.projects.length);
    expect(await h.p.pause({ tenant_id: T1, site_id: S1 })).toBe("no_project");
  });

  it("teardown finds the project by name when the ref was never recorded, pauses and schedules it, never deletes", async () => {
    const h = harness();
    h.failCreateResponse.value = true;
    h.listFails.value = true;
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 }).catch(() => {});
    h.listFails.value = false;
    expect(await h.p.teardown({ tenant_id: T1, site_id: S1 })).toBe("scheduled");
    expect(h.projects).toHaveLength(1);
    expect(h.projects[0].status).toBe("INACTIVE");
    expect(h.events).not.toContain("DELETE");
    const row = h.providers.get(`${S1}:supabase_project`)!;
    expect(row.state).toBe("delete_scheduled");
    expect(row.ref.project_ref).toBe(h.projects[0].ref);
    expect(await h.p.teardown({ tenant_id: T1, site_id: S1 })).toBe("scheduled");
    expect(h.events.filter((e) => e === "PAUSE")).toHaveLength(1);
  });

  it("teardown with no project anywhere records 'deleted' (nothing to protect)", async () => {
    const h = harness();
    await h.p.ensureProject({ tenant_id: T1, site_id: S1 }).catch(() => {});
    h.projects.length = 0;
    h.sites.get(S1)!.supabase_project_ref = null;
    h.providers.set(`${S1}:supabase_project`, { state: "claimed", ref: {} });
    expect(await h.p.teardown({ tenant_id: T1, site_id: S1 })).toBe("absent");
    expect(h.providers.get(`${S1}:supabase_project`)!.state).toBe("deleted");
  });
});
