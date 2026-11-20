
export const THROWAWAY_TENANT_PREFIXES = [
  "bv3",
  "bv9",
  "human-",
  "qa-",
  "test-",
  "smoke-",
  "gt-",
  "gtb-",
  "gtv-",
  "qab-",
  "qabw-",
  "bp2-",
  "bp3-",
  "b2-",
  "b2r-",
  "b3-",
  "cprobe",
  "credtest",
] as const;

export function isThrowawayTenantSlug(slug: string | null | undefined): boolean {
  if (!slug || typeof slug !== "string") return false;
  const s = slug.toLowerCase();
  return THROWAWAY_TENANT_PREFIXES.some((p) => s.startsWith(p));
}

export interface ReapableInput {
  tenantId: string | null | undefined;
  tenantAlive: boolean;
  tenantSlug: string | null | undefined;
  status: string | null | undefined;
}

export type ReapableReason =
  | "orphaned_no_tenant"
  | "tenant_deleted"
  | "throwaway_tenant"
  | "explicit_deprovisioning"
  | "protected_live_customer";

export interface ReapableVerdict {
  reapable: boolean;
  reason: ReapableReason;
}

export function isResourceReapable(input: ReapableInput): ReapableVerdict {
  const status = (input.status ?? "").toLowerCase();

  if (status === "teardown" || status === "deprovisioning" || status === "torn_down") {
    return { reapable: true, reason: "explicit_deprovisioning" };
  }

  if (input.tenantId == null) {
    return { reapable: true, reason: "orphaned_no_tenant" };
  }

  if (!input.tenantAlive) {
    return { reapable: true, reason: "tenant_deleted" };
  }

  if (isThrowawayTenantSlug(input.tenantSlug)) {
    return { reapable: true, reason: "throwaway_tenant" };
  }

  return { reapable: false, reason: "protected_live_customer" };
}

export function protectedRepoFullNames(
  repoRows: Array<{
    tenant_id: string | null;
    status: string | null;
    external_ref: { github_full_name?: string; full_name?: string } | null;
  }>,
  liveTenantSlugById: Map<string, string | null>,
): Set<string> {
  const protectedSet = new Set<string>();
  for (const r of repoRows) {
    const full = r.external_ref?.github_full_name ?? r.external_ref?.full_name;
    if (!full || typeof full !== "string") continue;
    const tenantAlive = r.tenant_id != null && liveTenantSlugById.has(r.tenant_id);
    const tenantSlug = r.tenant_id != null ? liveTenantSlugById.get(r.tenant_id) ?? null : null;
    const verdict = isResourceReapable({
      tenantId: r.tenant_id,
      tenantAlive,
      tenantSlug,
      status: r.status,
    });
    if (!verdict.reapable) protectedSet.add(full);
  }
  return protectedSet;
}
