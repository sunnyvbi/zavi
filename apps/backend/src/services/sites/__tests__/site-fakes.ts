
import type {
  SiteProviderKind,
  SiteProviderState,
  SiteRow,
  SiteStatus,
  SiteStore,
  StarterFiles,
  SupabaseSiteProvisioner,
} from "../contract";
import type { SiteRepoOps } from "../site-repo";
import type { SiteProviderRow, SiteTeardownDeps } from "../teardown";

let seq = 0;
const hex = () => (++seq).toString(16).padStart(6, "0");

export type FakeStore = SiteStore & {
  sites: Map<string, SiteRow>;
  providers: Map<string, SiteProviderRow & { tenant_id: string; site_id: string }>;
  failSetProviderState?: boolean;
  now: () => number;
  beforeBegin?: () => Promise<void>;
};

export function fakeStore(): FakeStore {
  const sites = new Map<string, SiteRow>();
  const providers = new Map<string, SiteProviderRow & { tenant_id: string; site_id: string }>();
  const own = (tenant_id: string, site_id: string): SiteRow => {
    const s = sites.get(site_id);
    if (!s || s.tenant_id !== tenant_id) throw new Error(`fake store: site ${site_id} not found for tenant ${tenant_id}`);
    return s;
  };
  const store: FakeStore = {
    sites,
    providers,
    now: () => Date.now(),
    async getOrCreateForRun({ tenant_id, root_conductor_run_id, company_name, started_by_user_id, site_name }) {
      for (const s of sites.values()) {
        if (s.root_conductor_run_id === root_conductor_run_id) {
          if (s.tenant_id !== tenant_id) throw new Error("fake store: run of another tenant");
          return { ...s };
        }
      }
      const id = `00000000-0000-4000-8000-${hex().padStart(12, "0")}`;
      const label = `${(site_name ?? company_name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(-6)}`;
      const now = new Date().toISOString();
      const row: SiteRow = {
        id, tenant_id, root_conductor_run_id, started_by_user_id, owner_email: null, label, name: site_name ?? null,
        hostname: `${label}.zaviagent.com`, github_full_name: null, supabase_project_ref: null, supabase_url: null,
        status: "provisioning", live_url: null, desired_sha: null, live_sha: null, live_deploy_id: null,
        last_visit_at: null, last_edit_at: null, paused_at: null, last_error: null, created_at: now, updated_at: now,
      };
      sites.set(id, row);
      return { ...row };
    },
    async get(tenant_id, site_id) {
      const s = sites.get(site_id);
      return s && s.tenant_id === tenant_id ? { ...s } : null;
    },
    async getByRun(tenant_id, run) {
      for (const s of sites.values()) if (s.tenant_id === tenant_id && s.root_conductor_run_id === run) return { ...s };
      return null;
    },
    async getByRepo(tenant_id, full) {
      for (const s of sites.values()) if (s.tenant_id === tenant_id && s.github_full_name === full) return { ...s };
      return null;
    },
    async listForTenant(tenant_id) {
      return [...sites.values()].filter((s) => s.tenant_id === tenant_id).map((s) => ({ ...s }));
    },
    async update(tenant_id, site_id, patch) {
      const s = own(tenant_id, site_id);
      Object.assign(s, patch);
      return { ...s };
    },
    async transition(tenant_id, site_id, from: SiteStatus[], to, patch = {}) {
      const s = own(tenant_id, site_id);
      if (!from.includes(s.status)) return null;
      Object.assign(s, patch, { status: to });
      return { ...s };
    },
    async settleStopped(tenant_id, site_id, to, last_error, generation, conductor_run_id) {
      const s = own(tenant_id, site_id);
      if (s.status !== "building" && s.status !== "publishing") return null;
      const owner = !!conductor_run_id && s.publish_run_id === conductor_run_id;
      const byGen = typeof generation === "number" && (s.publish_generation ?? 0) <= generation;
      const unknown = typeof generation !== "number" && (!conductor_run_id || !s.publish_run_id);
      if (!owner && !byGen && !unknown) return null;
      Object.assign(s, { status: s.live_deploy_id ? "live" : to, last_error: last_error.slice(0, 500) });
      return { ...s };
    },
    async activateIfDesired(tenant_id, site_id, sha, deploy_id, live_url) {
      const s = own(tenant_id, site_id);
      if (s.desired_sha !== sha || ["deleting", "deleted", "fell_back_old"].includes(s.status)) return false;
      Object.assign(s, { live_sha: sha, live_deploy_id: deploy_id, live_url });
      return true;
    },
    async claimProvider(tenant_id, site_id, kind: SiteProviderKind, ref) {
      own(tenant_id, site_id);
      const key = `${site_id}:${kind}`;
      const cur = providers.get(key);
      providers.set(key, { tenant_id, site_id, kind, state: cur?.state ?? "claimed", ref: { ...(cur?.ref ?? {}), ...ref } });
    },
    async setProviderState(tenant_id, site_id, kind: SiteProviderKind, state: SiteProviderState, ref) {
      if (store.failSetProviderState) throw new Error("ledger down");
      own(tenant_id, site_id);
      const cur = providers.get(`${site_id}:${kind}`);
      if (!cur) throw new Error(`fake store: no ${kind} claim`);
      if (state === "delete_scheduled") throw new Error("fake store: use scheduleProviderDelete");
      if (state === "delete_issuing") throw new Error("fake store: use beginProviderDelete");
      if (cur.state === "delete_issuing" && state !== "deleted") throw new Error("fake store: provider is being deleted");
      cur.state = state;
      if (ref) cur.ref = { ...cur.ref, ...ref };
      if (state !== "deleted") cur.scheduled_delete_at = null;
    },
    async scheduleProviderDelete(tenant_id, site_id, kind: SiteProviderKind, grace_days, ref) {
      if (store.failSetProviderState) throw new Error("ledger down");
      own(tenant_id, site_id);
      if (!(grace_days >= 7)) throw new Error("grace period must be at least 7 days");
      const cur = providers.get(`${site_id}:${kind}`);
      if (!cur || cur.state === "deleted" || cur.state === "delete_issuing") throw new Error(`fake store: no live ${kind} claim`);
      if (!(cur.state === "delete_scheduled" && cur.scheduled_delete_at)) {
        cur.scheduled_delete_at = new Date(store.now() + grace_days * 86_400_000).toISOString();
      }
      cur.state = "delete_scheduled";
      if (ref) cur.ref = { ...cur.ref, ...ref };
      return cur.scheduled_delete_at!;
    },
    async cancelProviderDelete(tenant_id, site_id, kind: SiteProviderKind, ref) {
      own(tenant_id, site_id);
      const cur = providers.get(`${site_id}:${kind}`);
      if (!cur || cur.state !== "delete_scheduled") return false;
      cur.state = "created";
      cur.scheduled_delete_at = null;
      if (ref) cur.ref = { ...cur.ref, ...ref };
      return true;
    },
    async beginProviderDelete(tenant_id, site_id, kind: SiteProviderKind, from) {
      own(tenant_id, site_id);
      if (store.beforeBegin) await store.beforeBegin();
      const cur = providers.get(`${site_id}:${kind}`);
      if (!cur || cur.state !== from) return false;
      if (from === "delete_scheduled") {
        const due = Date.parse(cur.scheduled_delete_at ?? "");
        if (!Number.isFinite(due) || due > store.now() || cur.ref.retained === true) return false;
        cur.ref = { ...cur.ref, delete_issued_at: new Date(store.now()).toISOString() };
      }
      cur.state = "delete_issuing";
      return true;
    },
  };
  return store;
}

export function providersOf(store: FakeStore, tenant_id: string, site_id: string): SiteProviderRow[] {
  return [...store.providers.values()]
    .filter((p) => p.tenant_id === tenant_id && p.site_id === site_id)
    .map(({ kind, state, ref, scheduled_delete_at }) => ({ kind, state, ref, scheduled_delete_at: scheduled_delete_at ?? null }));
}

export type FakeRepo = SiteRepoOps & { repos: Set<string>; deleted: string[]; failCreate?: boolean; seeds: number };
export function fakeRepo(): FakeRepo {
  const repos = new Set<string>();
  const r: FakeRepo = {
    repos,
    deleted: [],
    seeds: 0,
    org: () => "praxis-built",
    async ensureRepo(name) {
      if (r.failCreate) throw new Error("github down");
      const full = `praxis-built/${name}`;
      repos.add(full);
      return { full_name: full, default_branch: "main", repo_url: `https://github.com/${full}` };
    },
    async seed() {
      r.seeds++;
      return "a".repeat(40);
    },
    async deleteRepo(full) {
      r.deleted.push(full);
      repos.delete(full);
    },
  };
  return r;
}

export type FakeSupabase = SupabaseSiteProvisioner & {
  projects: Map<string, string>;
  calls: string[];
  failEnsure?: boolean;
  failTeardown?: boolean;
};

export function fakeSupabase(store: FakeStore): FakeSupabase {
  const projects = new Map<string, string>();
  const sb: FakeSupabase = {
    projects,
    calls: [],
    async ensureProject({ tenant_id, site_id }) {
      sb.calls.push(`ensure:${site_id}`);
      await store.claimProvider(tenant_id, site_id, "supabase_project", { name: `zs-${site_id}` });
      if (sb.failEnsure) throw new Error("supabase down");
      if (!projects.has(site_id)) projects.set(site_id, `ref-${site_id.slice(-6)}`);
      await store.setProviderState(tenant_id, site_id, "supabase_project", "created", { project_ref: projects.get(site_id) });
      return { project_ref: projects.get(site_id)!, url: `https://${projects.get(site_id)}.supabase.co` };
    },
    async configureAuth({ site_id }) { sb.calls.push(`auth:${site_id}`); },
    async applySql({ site_id, migration_id }) { sb.calls.push(`sql:${site_id}:${migration_id}`); return "applied"; },
    async ensureOwnerAdmin({ site_id }) { sb.calls.push(`owner:${site_id}`); return { user_id: "u" }; },
    async ownerMagicLink() { return "https://link"; },
    async verifyCatalog() { return []; },
    async pause() { return "paused" as const; },
    async restore() {},
    async teardown({ tenant_id, site_id }) {
      sb.calls.push(`teardown:${site_id}`);
      if (sb.failTeardown) throw new Error("supabase pause failed");
      if (!projects.has(site_id)) {
        await store.setProviderState(tenant_id, site_id, "supabase_project", "deleted");
        return "absent";
      }
      await store.scheduleProviderDelete(tenant_id, site_id, "supabase_project", 7, { project_ref: projects.get(site_id), paused: true });
      return "scheduled";
    },
    async purge({ tenant_id, site_id }) {
      sb.calls.push(`purge:${site_id}`);
      const row = store.providers.get(`${site_id}:supabase_project`);
      if (!row || row.state !== "delete_scheduled") return "not_scheduled";
      if (Date.parse(row.scheduled_delete_at ?? "") > store.now()) return "not_due";
      projects.delete(site_id);
      await store.setProviderState(tenant_id, site_id, "supabase_project", "deleted", { hard_deleted_at: new Date(store.now()).toISOString() });
      return "deleted";
    },
    async cancelDeletion({ tenant_id, site_id }) {
      const ok = await store.cancelProviderDelete(tenant_id, site_id, "supabase_project", { retained: true });
      return ok ? "restored" : "not_scheduled";
    },
  };
  return sb;
}

export const STARTER: StarterFiles = {
  files: { "package.json": "{}", "src/main.tsx": "export {};" },
  starter_sql: "create table profiles (id uuid primary key);",
  manifest_json: '{"smoke":{"journeys":[]}}',
};

export function teardownDeps(store: FakeStore, repo: FakeRepo, supabase: FakeSupabase | null, vault: string[] = []): SiteTeardownDeps {
  return {
    store,
    listProviders: async (t, s) => providersOf(store, t, s),
    publisher: null,
    supabase,
    repo,
    deleteVaultKeys: async (t, s) => { vault.push(`${t}:${s}`); },
  };
}
