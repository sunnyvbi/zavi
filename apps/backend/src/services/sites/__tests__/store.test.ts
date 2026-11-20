
import { describe, it, expect, vi } from "vitest";
import { createSiteStore, SITE_PATCH_KEYS, type SiteStoreDeps } from "../store";
import type { SiteRow } from "../contract";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  const runs = new Map<string, string>([
    ["run-a", T1],
    ["run-b", T1],
    ["run-other", T2],
  ]);
  const sites: SiteRow[] = [];
  let n = 0;
  const rpcCalls: Array<{ tid: string; name: string; args: Record<string, unknown> }> = [];

  const rpc: SiteStoreDeps["rpc"] = async (tid, name, args) => {
    rpcCalls.push({ tid, name, args });
    const site = () => sites.find((s) => s.id === args.p_site_id && s.tenant_id === tid);
    switch (name) {
      case "site_get_or_create_for_run": {
        if (runs.get(args.p_run_id as string) !== tid) {
          return { data: null, error: { code: "42501", message: "run does not belong to tenant" } };
        }
        const existing = sites.find((s) => s.root_conductor_run_id === args.p_run_id);
        if (existing) return { data: existing, error: null };
        n += 1;
        const id = `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        const row: SiteRow = {
          id, tenant_id: tid, root_conductor_run_id: args.p_run_id as string,
          started_by_user_id: (args.p_started_by as string) ?? null, owner_email: null,
          label: `site-${n}`, hostname: `site-${n}${args.p_hostname_suffix}.${args.p_base_domain}`, github_full_name: null,
          supabase_project_ref: null, supabase_url: null, status: "provisioning", live_url: null,
          desired_sha: null, live_sha: null, live_deploy_id: null, last_visit_at: null,
          last_edit_at: null, paused_at: null, last_error: null,
          created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
        };
        sites.push(row);
        return { data: row, error: null };
      }
      case "site_update": {
        const s = site();
        if (!s) return { data: null, error: { code: "P0002", message: "not found" } };
        Object.assign(s, args.p_patch);
        return { data: s, error: null };
      }
      case "site_transition": {
        const s = site();
        if (!s || !(args.p_from as string[]).includes(s.status)) {
          return { data: { id: null, tenant_id: null }, error: null };
        }
        Object.assign(s, args.p_patch, { status: args.p_to });
        return { data: s, error: null };
      }
      case "site_settle_stopped": {
        const s = site();
        if (!s || !["building", "publishing"].includes(s.status)) return { data: { id: null, tenant_id: null }, error: null };
        Object.assign(s, { status: s.live_deploy_id ? "live" : args.p_to, last_error: args.p_last_error });
        return { data: s, error: null };
      }
      case "site_activate_if_desired": {
        const s = site();
        if (!s || s.desired_sha !== args.p_sha) return { data: false, error: null };
        s.live_sha = args.p_sha as string;
        s.live_deploy_id = args.p_deploy_id as string;
        s.live_url = args.p_live_url as string;
        return { data: true, error: null };
      }
      case "site_provider_claim":
      case "site_provider_set":
        return site() ? { data: null, error: null } : { data: null, error: { code: "42501", message: "no" } };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  };

  const table: SiteStoreDeps["table"] = (tid) => {
    let rows = sites.filter((s) => s.tenant_id === tid);
    const q: any = {
      select: () => q,
      eq: (col: keyof SiteRow, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), q),
      ilike: (col: keyof SiteRow, v: string) => {
        const lit = v.replace(/\\([\\%_])/g, "$1").toLowerCase();
        rows = rows.filter((r) => String(r[col] ?? "").toLowerCase() === lit);
        return q;
      },
      limit: () => q,
      order: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    };
    return q;
  };

  return { rpc, table, sites, rpcCalls };
}

describe("SiteStore", () => {
  it("get-or-create is idempotent per run and scoped to the tenant", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const a1 = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Acme", started_by_user_id: "u1" });
    const a2 = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Acme", started_by_user_id: "u1" });
    expect(a2.id).toBe(a1.id);
    expect(db.sites).toHaveLength(1);
    expect(db.rpcCalls[0]).toMatchObject({ tid: T1, name: "site_get_or_create_for_run", args: { p_run_id: "run-a", p_company_name: "Acme", p_started_by: "u1", p_hostname_suffix: "", p_base_domain: "zaviagent.com" } });
    expect(db.rpcCalls[0].args).not.toHaveProperty("p_tenant_id");
  });

  it("passes the site's own name to the RPC, cleaned, and leaves it out when there is none (DEL-1323 B33)", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Apna Tutor", started_by_user_id: null, site_name: "  Paws\n and   Suds " });
    await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-b", company_name: "Apna Tutor", started_by_user_id: null, site_name: "   " });
    expect(db.rpcCalls[0].args).toMatchObject({ p_company_name: "Apna Tutor", p_site_name: "Paws and Suds" });
    expect(db.rpcCalls[1].args).not.toHaveProperty("p_site_name");
    expect(Object.keys(db.rpcCalls[1].args).sort()).toEqual(["p_base_domain", "p_company_name", "p_hostname_suffix", "p_run_id", "p_started_by"]);
  });

  it.each(["PGRST202", "42883"])("retries without p_site_name once when the named RPC is missing (%s)", async (code) => {
    const db = fakeDb();
    const calls: Record<string, unknown>[] = [];
    const store = createSiteStore({
      table: db.table,
      rpc: async (tid, name, args) => {
        calls.push(args);
        if ("p_site_name" in args) return { data: null, error: { code, message: "Could not find the function" } };
        return db.rpc(tid, name, args);
      },
    });
    const site = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Acme", started_by_user_id: null, site_name: "Paws and Suds" });
    expect(site.tenant_id).toBe(T1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveProperty("p_site_name", "Paws and Suds");
    expect(calls[1]).not.toHaveProperty("p_site_name");
    expect(calls[1]).toMatchObject({ p_run_id: "run-a", p_company_name: "Acme" });
  });

  it("does not retry the named RPC on any other error", async () => {
    const calls: Record<string, unknown>[] = [];
    const store = createSiteStore({
      table: fakeDb().table,
      rpc: async (_tid, _name, args) => {
        calls.push(args);
        return { data: null, error: { code: "XX000", message: "boom" } };
      },
    });
    await expect(store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Acme", started_by_user_id: null, site_name: "Paws" })).rejects.toThrow(/XX000.*boom/);
    expect(calls).toHaveLength(1);
  });

  it("passes the per-environment hostname parts into the RPC (dev: <label>-dev.zaviagent.com)", async () => {
    const db = fakeDb();
    const store = createSiteStore({ ...db, hostnameConfig: () => ({ suffix: "-dev", base_domain: "zaviagent.com" }) });
    const site = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Acme", started_by_user_id: null });
    expect(db.rpcCalls[0].args).toMatchObject({ p_hostname_suffix: "-dev", p_base_domain: "zaviagent.com" });
    expect(site.hostname).toBe("site-1-dev.zaviagent.com");
  });

  it("a bad hostname config throws before any RPC", async () => {
    const db = fakeDb();
    const store = createSiteStore({ ...db, hostnameConfig: () => { throw new Error("SITE_HOSTNAME_SUFFIX is invalid"); } });
    await expect(store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "Acme", started_by_user_id: null }))
      .rejects.toThrow(/SITE_HOSTNAME_SUFFIX/);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("two builds in one tenant give two sites that do not see each other", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const a = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    const b = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-b", company_name: "B", started_by_user_id: null });
    expect(a.id).not.toBe(b.id);
    expect((await store.getByRun(T1, "run-a"))?.id).toBe(a.id);
    expect((await store.getByRun(T1, "run-b"))?.id).toBe(b.id);
    expect(await store.listForTenant(T1)).toHaveLength(2);
    expect(await store.listForTenant(T2)).toHaveLength(0);
  });

  it("rejects a run that belongs to another tenant", async () => {
    const store = createSiteStore(fakeDb());
    await expect(
      store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-other", company_name: "X", started_by_user_id: null }),
    ).rejects.toThrow(/42501/);
  });

  it("fails closed when an RPC hands back another tenant's row", async () => {
    const db = fakeDb();
    const store = createSiteStore({
      table: db.table,
      rpc: async () => ({ data: { id: "x", tenant_id: T2 }, error: null }),
    });
    await expect(
      store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "X", started_by_user_id: null }),
    ).rejects.toThrow(/does not match/);
  });

  it("holds the patch whitelist before any RPC is called", async () => {
    const db = fakeDb();
    const rpc = vi.fn(db.rpc);
    const store = createSiteStore({ rpc, table: db.table });
    await expect(store.update(T1, "s", { tenant_id: T2 } as any)).rejects.toThrow(/not patchable/);
    await expect(store.update(T1, "s", { live_sha: "abc" } as any)).rejects.toThrow(/not patchable/);
    await expect(store.update(T1, "s", { hostname: "evil.zaviagent.com" } as any)).rejects.toThrow(/not patchable/);
    await expect(store.transition(T1, "s", ["live"], "paused", { status: "live" } as any)).rejects.toThrow(/not patchable/);
    expect(rpc).not.toHaveBeenCalled();
    expect([...SITE_PATCH_KEYS].sort()).toEqual([
      "desired_sha", "github_full_name", "last_edit_at", "last_error", "last_visit_at", "live_url",
      "owner_email", "paused_at", "status", "supabase_project_ref", "supabase_url",
    ]);
  });

  it("transition returns null when the status is not in `from`", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    expect(await store.transition(T1, s.id, ["live"], "paused")).toBeNull();
    const moved = await store.transition(T1, s.id, ["provisioning"], "building", { desired_sha: "sha1" });
    expect(moved?.status).toBe("building");
    expect(moved?.desired_sha).toBe("sha1");
    expect(await store.transition(T1, s.id, [], "live")).toBeNull();
  });

  it("activateIfDesired is false when desired_sha moved on", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    await store.update(T1, s.id, { desired_sha: "new" });
    expect(await store.activateIfDesired(T1, s.id, "old", "d1", "https://x")).toBe(false);
    expect(await store.activateIfDesired(T1, s.id, "new", "d2", "https://x")).toBe(true);
    expect(db.sites[0].live_deploy_id).toBe("d2");
  });

  it("settleStopped is one tenant-scoped RPC and returns null when the site was not building or publishing", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    expect(await store.settleStopped(T1, s.id, "failed", "x")).toBeNull();
    await store.transition(T1, s.id, ["provisioning"], "building");
    expect(await store.settleStopped(T1, s.id, "failed", "boom")).toMatchObject({ status: "failed", last_error: "boom" });
    const calls = db.rpcCalls.filter((c) => c.name === "site_settle_stopped");
    expect(calls.at(-1)).toMatchObject({ tid: T1, args: { p_site_id: s.id, p_to: "failed", p_last_error: "boom" } });
  });

  it("activateIfDesired names the asking run to the CAS only when it has one", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    await store.update(T1, s.id, { desired_sha: "new" });
    await store.activateIfDesired(T1, s.id, "new", "d1", "https://x", undefined, "33333333-3333-4333-8333-333333333333");
    await store.activateIfDesired(T1, s.id, "new", "d2", "https://x");
    const calls = db.rpcCalls.filter((c) => c.name === "site_activate_if_desired").map((c) => c.args);
    expect(calls[0]).toMatchObject({ p_conductor_run_id: "33333333-3333-4333-8333-333333333333" });
    expect(calls[1]).not.toHaveProperty("p_conductor_run_id");
  });

  it("reads are tenant-scoped: another tenant cannot get or find a site by repo", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    await store.update(T1, s.id, { github_full_name: "zavi-sites/a_b" });
    expect((await store.get(T1, s.id))?.id).toBe(s.id);
    expect(await store.get(T2, s.id)).toBeNull();
    expect((await store.getByRepo(T1, "Zavi-Sites/A_B"))?.id).toBe(s.id);
    expect(await store.getByRepo(T1, "zavi-sites/aXb")).toBeNull();
    expect(await store.getByRepo(T2, "zavi-sites/a_b")).toBeNull();
    expect(await store.getByRepo(T1, "  ")).toBeNull();
  });

  it("provider claims and state changes go through the tenant-checked RPCs", async () => {
    const db = fakeDb();
    const store = createSiteStore(db);
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-a", company_name: "A", started_by_user_id: null });
    await store.claimProvider(T1, s.id, "supabase_project", { name: `zs-${s.id}` });
    await store.setProviderState(T1, s.id, "supabase_project", "created", { project_ref: "ref" });
    await expect(store.claimProvider(T2, s.id, "github_repo", {})).rejects.toThrow(/42501/);
    expect(db.rpcCalls.map((c) => c.name)).toContain("site_provider_set");
  });

  it("schedule / cancel a deletion go through their own RPCs with the grace period", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const at = "2026-10-08T00:00:00+00:00";
    const store = createSiteStore({
      table: fakeDb().table,
      rpc: async (_tid, name, args) => {
        calls.push({ name, args });
        return { data: name === "site_provider_schedule_delete" ? at : true, error: null };
      },
    });
    expect(await store.scheduleProviderDelete(T1, "s1", "supabase_project", 7, { paused: true })).toBe(at);
    expect(await store.cancelProviderDelete(T1, "s1", "supabase_project")).toBe(true);
    expect(await store.beginProviderDelete(T1, "s1", "supabase_project", "delete_scheduled")).toBe(true);
    expect(calls).toEqual([
      { name: "site_provider_schedule_delete", args: { p_site_id: "s1", p_kind: "supabase_project", p_grace_days: 7, p_ref: { paused: true } } },
      { name: "site_provider_cancel_delete", args: { p_site_id: "s1", p_kind: "supabase_project", p_ref: null } },
      { name: "site_provider_begin_delete", args: { p_site_id: "s1", p_kind: "supabase_project", p_from: "delete_scheduled" } },
    ]);
  });

  it("begin_delete answers 'do not delete' for anything but an explicit true", async () => {
    for (const data of [false, null, "true", 1]) {
      const store = createSiteStore({ table: fakeDb().table, rpc: async () => ({ data, error: null }) });
      expect(await store.beginProviderDelete(T1, "s1", "supabase_project", "delete_scheduled"), String(data)).toBe(false);
    }
  });

  it("a schedule RPC that returns no time throws (never a silent unscheduled delete)", async () => {
    const store = createSiteStore({ table: fakeDb().table, rpc: async () => ({ data: null, error: null }) });
    await expect(store.scheduleProviderDelete(T1, "s1", "supabase_project", 7)).rejects.toThrow(/no schedule/);
  });

  it("surfaces an RPC error instead of swallowing it", async () => {
    const store = createSiteStore({
      table: fakeDb().table,
      rpc: async () => ({ data: null, error: { code: "XX000", message: "boom" } }),
    });
    await expect(store.update(T1, "s", { last_error: "x" })).rejects.toThrow(/boom/);
  });
});
