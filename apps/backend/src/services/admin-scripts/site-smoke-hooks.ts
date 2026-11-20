
import { z } from "zod";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { parseHooksLeft, SMOKE_HOOKS_LEFT_SQL, SMOKE_HOOKS_REMOVE_SQL, type SmokeHooksLeft } from "@/services/sites/smoke-hooks-cleanup";

export const SITE_SMOKE_HOOKS_KEY = "site-smoke-hooks";
export const SMOKE_HOOKS_CONFIRM = "REMOVE SMOKE HOOKS";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^[a-z0-9]{20}$/;

export type HookSite = { id: string; tenant_id: string; label: string; supabase_project_ref: string | null };

export type SmokeHooksDeps = {
  readSite: (site_id: string) => Promise<HookSite | null>;
  listSites: (after: string | null, limit: number) => Promise<HookSite[]>;
  query: (ref: string, sql: string) => Promise<unknown[]>;
  verifyProject: (site: HookSite) => Promise<void>;
};

export class SmokeHooksError extends Error {
  constructor(
    readonly code: "not_found" | "no_database" | "confirm_mismatch",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const optionalUuid = (name: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().regex(UUID_RE, `${name} must be a site uuid`).transform((s) => s.toLowerCase()).optional(),
  );

export const smokeHooksSchema = z.object({
  site_id: optionalUuid("site_id"),
  max_sites: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 50 : typeof v === "string" ? Number(v) : v),
    z.number().int().min(1).max(200),
  ),
  after: optionalUuid("after"),
});
export type SmokeHooksArgs = z.infer<typeof smokeHooksSchema>;

const SITE_COLUMNS = "id, tenant_id, label, supabase_project_ref";

const DEFAULT_DEPS: SmokeHooksDeps = {
  async readSite(site_id) {
    const sb = staffCrossTenantClient("admin script site-smoke-hooks: staff removes retired publish-check triggers from a site");
    const { data, error } = await sb.from("sites").select(SITE_COLUMNS).eq("id", site_id).maybeSingle();
    if (error) throw new Error(`site-smoke-hooks: site read failed: ${error.message}`);
    return (data as HookSite | null) ?? null;
  },
  async listSites(after, limit) {
    const sb = staffCrossTenantClient("admin script site-smoke-hooks: staff lists dedicated sites for the retired publish-check triggers");
    let q = sb.from("sites").select(SITE_COLUMNS).not("supabase_project_ref", "is", null).not("status", "in", "(deleting,deleted)");
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(`site-smoke-hooks: site list failed: ${error.message}`);
    return (data ?? []) as HookSite[];
  },
  query: async (ref, sql) => (await import("@/services/sites/supabase-mgmt")).createSupabaseMgmt().query(ref, sql),
  async verifyProject(site) {
    const [{ createSupabaseMgmt }, { siteProjectName }] = await Promise.all([
      import("@/services/sites/supabase-mgmt"),
      import("@/services/sites/supabase-site-provisioner"),
    ]);
    const mgmt = createSupabaseMgmt();
    const ref = site.supabase_project_ref ?? "";
    const p = ref ? await mgmt.getProject(ref) : null;
    if (!p || p.ref !== ref || p.name !== siteProjectName(site.id) || p.organization_id !== mgmt.orgId) {
      throw new Error("the site's database project is not its own (wrong org or name)");
    }
  },
};
export const DEFAULT_SMOKE_HOOKS_DEPS = DEFAULT_DEPS;

export type HookSiteResult = { site_id: string; tenant_id: string; label: string } & (
  | ({ ok: true } & SmokeHooksLeft)
  | { ok: false; error: string }
);

async function pageOf(a: SmokeHooksArgs, deps: SmokeHooksDeps): Promise<HookSite[]> {
  if (a.site_id) {
    const s = await deps.readSite(a.site_id);
    if (!s) throw new SmokeHooksError("not_found", "No site with that id.", 404);
    if (!s.supabase_project_ref) throw new SmokeHooksError("no_database", "That site has no database project of its own: nothing to clean.", 400);
    return [s];
  }
  return deps.listSites(a.after ?? null, a.max_sites);
}

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

async function inspect(site: HookSite, deps: SmokeHooksDeps): Promise<HookSiteResult> {
  const base = { site_id: site.id, tenant_id: site.tenant_id, label: site.label };
  try {
    if (!REF_RE.test(site.supabase_project_ref ?? "")) throw new Error("invalid project ref");
    await deps.verifyProject(site);
    return { ...base, ok: true, ...parseHooksLeft(await deps.query(site.supabase_project_ref!, SMOKE_HOOKS_LEFT_SQL)) };
  } catch (e) {
    return { ...base, ok: false, error: short(e) };
  }
}

export async function previewSmokeHooks(a: SmokeHooksArgs, deps: SmokeHooksDeps = DEFAULT_DEPS) {
  const sites = await pageOf(a, deps);
  const results: HookSiteResult[] = [];
  for (const s of sites) results.push(await inspect(s, deps));
  const left = results.filter((r) => r.ok && (r.triggers > 0 || r.objects > 0));
  return {
    scanned: results.length,
    with_leftovers: left.length,
    unreachable: results.filter((r) => !r.ok).length,
    sites: results.filter((r) => !r.ok || r.triggers > 0 || r.objects > 0),
    next_after: !a.site_id && sites.length === a.max_sites ? sites[sites.length - 1].id : null,
  };
}

export async function applySmokeHooks(
  a: SmokeHooksArgs,
  confirm: string | undefined,
  deps: SmokeHooksDeps = DEFAULT_DEPS,
  progress?: (p: Record<string, unknown>) => Promise<void>,
) {
  if ((confirm ?? "").trim() !== SMOKE_HOOKS_CONFIRM) {
    throw new SmokeHooksError("confirm_mismatch", `Type ${SMOKE_HOOKS_CONFIRM} to remove them.`, 400);
  }
  const sites = await pageOf(a, deps);
  const results: HookSiteResult[] = [];
  let removed = 0;
  for (const [i, s] of sites.entries()) {
    const before = await inspect(s, deps);
    if (before.ok && (before.triggers > 0 || before.objects > 0)) {
      try {
        await deps.query(s.supabase_project_ref!, SMOKE_HOOKS_REMOVE_SQL);
        const after = await inspect(s, deps);
        if (after.ok && after.triggers === 0 && after.objects === 0) removed++;
        results.push(after);
      } catch (e) {
        results.push({ site_id: s.id, tenant_id: s.tenant_id, label: s.label, ok: false, error: short(e) });
      }
    } else {
      results.push(before);
    }
    await progress?.({ done: i + 1, of: sites.length, removed });
  }
  const left = results.filter((r) => !r.ok || r.triggers > 0 || r.objects > 0);
  return {
    scanned: results.length,
    removed,
    left: left.length,
    sites: left,
    next_after: !a.site_id && sites.length === a.max_sites ? sites[sites.length - 1].id : null,
  };
}
