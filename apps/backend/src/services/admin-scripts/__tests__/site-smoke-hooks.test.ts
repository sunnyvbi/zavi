import { describe, expect, it, vi } from "vitest";
import { applySmokeHooks, previewSmokeHooks, smokeHooksSchema, SMOKE_HOOKS_CONFIRM, type HookSite, type SmokeHooksDeps } from "../site-smoke-hooks";
import { SMOKE_HOOKS_LEFT_SQL, SMOKE_HOOKS_REMOVE_SQL } from "@/services/sites/smoke-hooks-cleanup";

const T = "11111111-1111-4111-8111-111111111111";
const s = (n: number, ref = `ref${String(n).padStart(17, "0")}`): HookSite => ({
  id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
  tenant_id: T,
  label: `site-${n}`,
  supabase_project_ref: ref,
});

function world(state: Record<string, { triggers: number; objects: number; removeFails?: boolean }>, sites: HookSite[]) {
  const queries: Array<[string, string]> = [];
  const deps: SmokeHooksDeps = {
    readSite: async (id) => sites.find((x) => x.id === id) ?? null,
    listSites: async (after, limit) => sites.filter((x) => !after || x.id > after).slice(0, limit),
    verifyProject: vi.fn(async (site) => {
      if (site.supabase_project_ref === "notmineref0000000000") throw new Error("the site's database project is not its own");
    }),
    query: async (ref, sql) => {
      queries.push([ref, sql]);
      const st = state[ref] ?? { triggers: 0, objects: 0 };
      if (sql === SMOKE_HOOKS_LEFT_SQL) return [{ triggers: st.triggers, objects: st.objects }];
      if (sql === SMOKE_HOOKS_REMOVE_SQL) {
        if (st.removeFails) throw new Error("canceling statement due to lock timeout");
        state[ref] = { triggers: 0, objects: 0 };
        return [];
      }
      throw new Error("unexpected sql");
    },
  };
  return { deps, queries, state };
}

const args = (over: Record<string, unknown> = {}) => smokeHooksSchema.parse({ max_sites: 50, ...over });

describe("admin script: remove leftover publish-check triggers", () => {
  it("Dry Run lists only sites with leftovers (or unreachable), runs only the read query", async () => {
    const sites = [s(1), s(2), s(3, "notmineref0000000000")];
    const w = world({ [sites[0].supabase_project_ref!]: { triggers: 6, objects: 3 } }, sites);
    const out = await previewSmokeHooks(args(), w.deps);
    expect(out).toMatchObject({ scanned: 3, with_leftovers: 1, unreachable: 1, next_after: null });
    expect(out.sites.map((x) => x.site_id)).toEqual([sites[0].id, sites[2].id]);
    expect(w.queries.every(([, q]) => q === SMOKE_HOOKS_LEFT_SQL)).toBe(true);
    expect(w.queries.some(([ref]) => ref === "notmineref0000000000")).toBe(false);
  });

  it("Apply needs the typed confirm", async () => {
    const w = world({}, [s(1)]);
    await expect(applySmokeHooks(args(), "yes", w.deps)).rejects.toMatchObject({ code: "confirm_mismatch" });
    expect(w.queries).toEqual([]);
  });

  it("Apply removes leftovers, re-reads, leaves clean sites untouched, reports what is left", async () => {
    const sites = [s(1), s(2), s(4)];
    const w = world(
      {
        [sites[0].supabase_project_ref!]: { triggers: 6, objects: 3 },
        [sites[2].supabase_project_ref!]: { triggers: 3, objects: 2, removeFails: true },
      },
      sites,
    );
    const progress = vi.fn(async () => undefined);
    const out = await applySmokeHooks(args(), SMOKE_HOOKS_CONFIRM, w.deps, progress);
    expect(out).toMatchObject({ scanned: 3, removed: 1, left: 1 });
    expect(out.sites).toEqual([expect.objectContaining({ site_id: sites[2].id, ok: false, error: expect.stringContaining("lock timeout") })]);
    expect(w.queries.filter(([, q]) => q === SMOKE_HOOKS_REMOVE_SQL).map(([r]) => r)).toEqual([sites[0].supabase_project_ref, sites[2].supabase_project_ref]);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("one site by id; a site without its own database is refused", async () => {
    const one = s(1);
    const w = world({ [one.supabase_project_ref!]: { triggers: 1, objects: 0 } }, [one, { ...s(2), supabase_project_ref: null }]);
    expect((await applySmokeHooks(args({ site_id: one.id }), SMOKE_HOOKS_CONFIRM, w.deps)).removed).toBe(1);
    await expect(previewSmokeHooks(args({ site_id: s(2).id }), w.deps)).rejects.toMatchObject({ code: "no_database" });
    await expect(previewSmokeHooks(args({ site_id: s(9).id }), w.deps)).rejects.toMatchObject({ code: "not_found" });
  });

  it("the cleanup SQL drops only platform-made objects, one transaction with a lock timeout", () => {
    expect(SMOKE_HOOKS_REMOVE_SQL).toContain("set local lock_timeout = '5s'");
    expect(SMOKE_HOOKS_REMOVE_SQL).toContain("obj_description(g.tgfoid, 'pg_proc') = 'zavi smoke log v1 (platform-owned)'");
    expect(SMOKE_HOOKS_REMOVE_SQL).toContain("g.tgparentid = 0");
    expect(SMOKE_HOOKS_REMOVE_SQL).toContain("if exists (select 1 from pg_catalog.pg_trigger g where g.tgfoid = pg_catalog.to_regproc('zavi._smoke_log_fn')::oid)");
    expect(SMOKE_HOOKS_REMOVE_SQL).toContain("'pg_proc') is distinct from 'zavi smoke log v1 (platform-owned)' then");
    expect(SMOKE_HOOKS_REMOVE_SQL.indexOf("return;")).toBeLessThan(SMOKE_HOOKS_REMOVE_SQL.indexOf("drop table if exists zavi._smoke_log"));
    expect(SMOKE_HOOKS_REMOVE_SQL).not.toMatch(/drop schema/i);
  });
});
