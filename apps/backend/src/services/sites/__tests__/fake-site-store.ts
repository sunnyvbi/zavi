
import type { SitePublishGenerations, SiteRow, SiteStore } from "../contract";

export const T1 = "11111111-1111-4111-8111-111111111111";
export const T2 = "22222222-2222-4222-8222-222222222222";

export function siteRow(over: Partial<SiteRow> & { id: string; tenant_id?: string }): SiteRow {
  const label = over.label ?? `site-${over.id.slice(0, 4)}`;
  return {
    tenant_id: T1,
    root_conductor_run_id: null,
    started_by_user_id: null,
    owner_email: "owner@example.test",
    label,
    hostname: `${label}.zaviagent.com`,
    github_full_name: `Praxis-build/${label}`,
    supabase_project_ref: "ref",
    supabase_url: "https://ref.supabase.co",
    status: "building",
    live_url: null,
    desired_sha: null,
    live_sha: null,
    live_deploy_id: null,
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: null,
    created_at: "2026-09-30T00:00:00Z",
    updated_at: "2026-09-30T00:00:00Z",
    ...over,
  };
}

export function fakeSiteStore(rows: SiteRow[]) {
  const sites = rows.map((r) => ({ ...r }));
  const find = (t: string, id: string) => sites.find((s) => s.id === id && s.tenant_id === t) ?? null;
  const store: SiteStore = {
    async getOrCreateForRun() {
      throw new Error("not used");
    },
    async get(t, id) {
      const s = find(t, id);
      return s ? { ...s } : null;
    },
    async getByRun(t, run) {
      const s = sites.find((x) => x.tenant_id === t && x.root_conductor_run_id === run);
      return s ? { ...s } : null;
    },
    async getByRepo(t, name) {
      const s = sites.find((x) => x.tenant_id === t && x.github_full_name?.toLowerCase() === name.toLowerCase());
      return s ? { ...s } : null;
    },
    async listForTenant(t) {
      return sites.filter((s) => s.tenant_id === t).map((s) => ({ ...s }));
    },
    async update(t, id, patch) {
      const s = find(t, id);
      if (!s) throw new Error("no site");
      Object.assign(s, patch);
      return { ...s };
    },
    async transition(t, id, from, to, patch = {}) {
      const s = find(t, id);
      if (!s || !from.includes(s.status)) return null;
      Object.assign(s, patch, { status: to });
      return { ...s };
    },
    async settleStopped(t, id, to, last_error, generation, conductor_run_id) {
      const s = find(t, id);
      if (!s || (s.status !== "building" && s.status !== "publishing")) return null;
      const owner = !!conductor_run_id && s.publish_run_id === conductor_run_id;
      const byGen = typeof generation === "number" && (s.publish_generation ?? 0) <= generation;
      const unknown = typeof generation !== "number" && (!conductor_run_id || !s.publish_run_id);
      if (!owner && !byGen && !unknown) return null;
      Object.assign(s, { status: s.live_deploy_id ? "live" : to, last_error: last_error.slice(0, 500) });
      return { ...s };
    },
    async activateIfDesired(t, id, sha, deploy_id, live_url, generation) {
      const s = find(t, id);
      if (s && typeof generation === "number" && (s.publish_generation ?? 0) !== generation) return false;
      if (!s || s.desired_sha !== sha || ["deleting", "deleted", "fell_back_old"].includes(s.status)) return false;
      Object.assign(s, { live_sha: sha, live_deploy_id: deploy_id, live_url });
      return true;
    },
    async claimProvider() {},
    async setProviderState() {},
    async scheduleProviderDelete() {
      return new Date(Date.now() + 7 * 86_400_000).toISOString();
    },
    async cancelProviderDelete() {
      return false;
    },
    async beginProviderDelete() {
      return false;
    },
  };
  return { store, sites };
}

export function fakeGenerations(sites: SiteRow[], now: () => number = Date.now) {
  const leases = new Map<string, { gen: number; until: number; token?: string }>();
  const find = (t: string, id: string) => sites.find((s) => s.id === id && s.tenant_id === t) ?? null;
  const calls: string[] = [];
  const generations: SitePublishGenerations = {
    async begin(t, id, sha, conductor_run_id) {
      const s = find(t, id);
      if (!s) throw new Error("site_publish_begin: site not found");
      const held = leases.get(id);
      if (held && held.until > now()) return calls.push("begin:busy"), "busy";
      s.publish_generation = (s.publish_generation ?? 0) + 1;
      s.desired_sha = sha;
      s.publish_run_id = conductor_run_id ?? null;
      calls.push(`begin:${s.publish_generation}`);
      return s.publish_generation;
    },
    async lease(t, id, gen, ttl_s, token) {
      const s = find(t, id);
      if (!s || (s.publish_generation ?? 0) !== gen) return calls.push(`lease:${gen}:superseded`), "superseded";
      const held = leases.get(id);
      if (held && held.until > now() && held.token !== token) return calls.push(`lease:${gen}:busy`), "busy";
      leases.set(id, { gen, until: now() + ttl_s * 1000, token });
      calls.push(`lease:${gen}:leased`);
      return "leased";
    },
    async release(_t, id, gen, token) {
      const held = leases.get(id);
      if (held?.gen === gen && held.token === token) leases.delete(id);
      calls.push(`release:${gen}`);
    },
  };
  return { generations, leases, calls };
}
