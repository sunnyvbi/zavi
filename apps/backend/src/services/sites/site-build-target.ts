
import type { SiteRow, SiteStatus } from "./contract";
import { siteStore } from "./store";
import { findProtectedPathHits, normalizeRepoPath, type ProtectedPathHit } from "@/services/agents/pipeline-policy";

export const SITE_MIGRATIONS_PROTECTED_GLOB = "supabase/migrations/**";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_BUILDABLE: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["failed", "fell_back_old", "deleting", "deleted"]);

export type SiteRepoLookup = (tenant_id: string, github_full_name: string) => Promise<SiteRow | null>;

export function payloadSiteId(payload: unknown): string | null {
  const v = (payload as { site_id?: unknown } | null | undefined)?.site_id;
  return typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null;
}

export type KernelSqlPolicy = (input: { tenant_id: string; site: SiteRow }) => Promise<boolean>;
const defaultKernelSqlPolicy: KernelSqlPolicy = async (i) => {
  const { createPooledBackend } = await import("@/services/site-shards/facade");
  const b = createPooledBackend();
  return b.kernelSqlAllowed ? b.kernelSqlAllowed(i) : false;
};

export type SiteRepoRunCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "no_site_id" | "no_repo" | "no_site" | "other_site" | "repo_mismatch" | "not_buildable" | "read_error" | "no_sql_database";
      status?: SiteStatus;
    };

const READ_ATTEMPTS = 2;

export async function verifySiteRepoRun(
  input: { tenant_id: string; repo_full_name: string | null | undefined; payload: unknown },
  loadSiteByRepo: SiteRepoLookup = (t, r) => siteStore().getByRepo(t, r),
  kernelSqlAllowed: KernelSqlPolicy = defaultKernelSqlPolicy,
): Promise<SiteRepoRunCheck> {
  const siteId = payloadSiteId(input.payload);
  const repo = String(input.repo_full_name ?? "").trim();
  if (!siteId) return { ok: false, reason: "no_site_id" };
  if (!repo || !input.tenant_id) return { ok: false, reason: "no_repo" };
  let site: SiteRow | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      site = await loadSiteByRepo(input.tenant_id, repo);
      break;
    } catch (e) {
      console.warn(
        `[site-build-target] site read failed for tenant=${input.tenant_id} (attempt ${attempt}/${READ_ATTEMPTS}): ${(e as Error)?.message ?? e}`,
      );
      if (attempt >= READ_ATTEMPTS) return { ok: false, reason: "read_error" };
    }
  }
  if (!site || site.tenant_id !== input.tenant_id) return { ok: false, reason: "no_site" };
  if (String(site.id).toLowerCase() !== siteId) return { ok: false, reason: "other_site" };
  if ((site.github_full_name ?? "").trim() !== repo) return { ok: false, reason: "repo_mismatch" };
  if (NOT_BUILDABLE.has(site.status)) return { ok: false, reason: "not_buildable", status: site.status };
  if (site.backend_mode === "pooled" || site.shard_id) return { ok: false, reason: "no_sql_database" };
  if (site.kernel_shard_id) {
    let allowed = false;
    try {
      allowed = (await kernelSqlAllowed({ tenant_id: input.tenant_id, site })) === true;
    } catch (e) {
      console.warn(`[site-build-target] kernel SQL policy read failed for tenant=${input.tenant_id}: ${(e as Error)?.message ?? e}`);
      return { ok: false, reason: "read_error" };
    }
    if (!allowed) return { ok: false, reason: "no_sql_database" };
  }
  return { ok: true };
}

export async function isVerifiedSiteRepoRun(
  input: { tenant_id: string; repo_full_name: string | null | undefined; payload: unknown },
  loadSiteByRepo: SiteRepoLookup = (t, r) => siteStore().getByRepo(t, r),
  kernelSqlAllowed: KernelSqlPolicy = defaultKernelSqlPolicy,
): Promise<boolean> {
  return (await verifySiteRepoRun(input, loadSiteByRepo, kernelSqlAllowed)).ok;
}

const SITE_MIGRATION_FILE_RE = /^supabase\/migrations\/[^/]+\.sql$/;

export function siteProtectedPathHits(
  files: Array<{ path?: string | null; action?: string | null }>,
  globs: readonly string[],
): ProtectedPathHit[] {
  const paths = files.map((f) => f.path ?? null);
  const hits = findProtectedPathHits(paths, globs.filter((g) => g !== SITE_MIGRATIONS_PROTECTED_GLOB));
  const seen = new Set(hits.map((h) => h.path));
  for (const f of files) {
    if (typeof f.path !== "string") continue;
    const p = normalizeRepoPath(f.path);
    if (!p.startsWith("supabase/migrations/") || seen.has(p)) continue;
    if (!SITE_MIGRATION_FILE_RE.test(p) || f.action === "delete") {
      seen.add(p);
      hits.push({ path: p, glob: SITE_MIGRATIONS_PROTECTED_GLOB });
    }
  }
  return hits;
}

export function withoutSiteMigrationHits<T extends { path: string; glob: string }>(hits: readonly T[]): T[] {
  return hits.filter((h) => !(h.glob === SITE_MIGRATIONS_PROTECTED_GLOB && SITE_MIGRATION_FILE_RE.test(h.path)));
}
