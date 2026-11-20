
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { SITE_DEPS_SYNC_TIMEOUT_MS } from "@/services/build/deps-install-script";

const SITE_DEPS_SYNC_S = Math.ceil(SITE_DEPS_SYNC_TIMEOUT_MS / 1000);

export const PREVIEW_READINESS_BUDGET_S = 13 * 60;

export type SiteLeaseKind = "restart" | "wake" | "edit";

export const SITE_LEASE_TTL_S: Record<SiteLeaseKind, number> = {
  restart: 5 * 60 + SITE_DEPS_SYNC_S + PREVIEW_READINESS_BUDGET_S,
  wake: 90 + 5 * 60 + SITE_DEPS_SYNC_S + PREVIEW_READINESS_BUDGET_S,
  edit: 2 * 60,
};

export const SITE_DIRECT_CHANGE_LEASE_TTL_S = 30 * 60;

export type SiteLeaseClaim = { token: string } | { token: null; held: SiteLeaseKind | "unknown" };

const heldHere = new Map<string, { tenant_id: string; site_id: string }>();

export function siteLeasesHeldHere(): number {
  return heldHere.size;
}

export async function releaseHeldSiteLeases(timeoutMs = 3_000): Promise<number> {
  const held = [...heldHere.entries()];
  if (!held.length) return 0;
  await Promise.race([
    Promise.all(held.map(([token, l]) => releaseSiteLease(l.tenant_id, l.site_id, { token }))),
    new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
  ]);
  return held.length;
}

async function claimSiteLeaseFor(
  tenant_id: string,
  site_id: string,
  kind: SiteLeaseKind,
  ttlSeconds: number,
): Promise<SiteLeaseClaim> {
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "claim_site_preview_lease", {
      p_site_id: site_id,
      p_kind: kind,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { token?: string | null; held_kind?: string | null } | null;
    if (row?.token) {
      heldHere.set(row.token, { tenant_id, site_id });
      return { token: row.token };
    }
    const held = row?.held_kind;
    return { token: null, held: held === "restart" || held === "wake" || held === "edit" ? held : "unknown" };
  } catch (e) {
    console.warn(JSON.stringify({ evt: "site_lease_claim_failed", tenant_id, site_id, kind, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return { token: null, held: "unknown" };
  }
}

export async function claimSiteLease(tenant_id: string, site_id: string, kind: SiteLeaseKind): Promise<SiteLeaseClaim> {
  return claimSiteLeaseFor(tenant_id, site_id, kind, SITE_LEASE_TTL_S[kind]);
}

export async function releaseSiteLease(
  tenant_id: string,
  site_id: string,
  by: { token: string } | { kind: SiteLeaseKind },
): Promise<void> {
  if ("token" in by) heldHere.delete(by.token);
  try {
    const { error } = await tenantRpc(asTenantId(tenant_id), "release_site_preview_lease", {
      p_site_id: site_id,
      p_token: "token" in by ? by.token : null,
      p_kind: "kind" in by ? by.kind : null,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(JSON.stringify({ evt: "site_lease_release_failed", tenant_id, site_id, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
}

export async function siteLeaseHeld(tenant_id: string, site_id: string): Promise<SiteLeaseKind | "unknown" | null> {
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_preview_lease_held", { p_site_id: site_id });
    if (error) throw new Error(error.message);
    return data === "restart" || data === "wake" || data === "edit" ? data : data == null ? null : "unknown";
  } catch {
    return "unknown";
  }
}

export type SiteEditLease = { release: () => Promise<void> } | { held: SiteLeaseKind | "unknown" };

export async function claimSiteEditLease(tenant_id: string, site_id: string): Promise<SiteEditLease> {
  const claim = await claimSiteLease(tenant_id, site_id, "edit");
  if (claim.token === null) return { held: claim.held };
  const token = claim.token;
  return { release: () => releaseSiteLease(tenant_id, site_id, { token }) };
}

export async function claimSiteDirectChangeLease(tenant_id: string, site_id: string): Promise<SiteEditLease> {
  const claim = await claimSiteLeaseFor(tenant_id, site_id, "edit", SITE_DIRECT_CHANGE_LEASE_TTL_S);
  if (claim.token === null) return { held: claim.held };
  const token = claim.token;
  return { release: () => releaseSiteLease(tenant_id, site_id, { token }) };
}
