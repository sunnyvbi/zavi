import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export type PrimarySiteWebsiteInput = { tenant_id: string; site_id: string; url: string };

export type PrimarySiteWebsiteOutcome = "recorded" | "bad_url" | "not_primary" | "has_website";

export type PrimarySiteWebsiteDeps = {
  primarySiteId: (tenant_id: string) => Promise<string | null>;
  hasWebsite: (tenant_id: string) => Promise<boolean>;
  setWebsite: (tenant_id: string, url: string, source_ref: string) => Promise<void>;
  regenerateBrief: (tenant_id: string) => Promise<unknown>;
};

const SITE_URL_RE = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export async function recordPrimarySiteAsCompanyWebsite(
  input: PrimarySiteWebsiteInput,
  deps: PrimarySiteWebsiteDeps = realPrimarySiteWebsiteDeps,
): Promise<PrimarySiteWebsiteOutcome> {
  const host = SITE_URL_RE.exec(input.url)?.[1];
  if (!host) return "bad_url";
  const primary = await deps.primarySiteId(input.tenant_id);
  if (!primary || primary !== input.site_id) return "not_primary";
  if (await deps.hasWebsite(input.tenant_id)) return "has_website";
  await deps.setWebsite(input.tenant_id, input.url, `site ${host.toLowerCase()} verified live by site-activate`);
  try {
    await deps.regenerateBrief(input.tenant_id);
  } catch (e) {
    console.warn(`[primary-site-website] company brief not re-rendered for ${input.tenant_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  return "recorded";
}

export const realPrimarySiteWebsiteDeps: PrimarySiteWebsiteDeps = {
  async primarySiteId(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("sites")
      .select("id")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);
    if (error) throw new Error(`sites primary read failed: ${error.message}`);
    const id = (data?.[0] as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? id : null;
  },
  async hasWebsite(tenant_id) {
    const sb = tenantClient(asTenantId(tenant_id));
    const [fact, tenant] = await Promise.all([
      sb.from("tenant_fact").select("key").eq("key", "domain").limit(1),
      sb.from("tenants").select("product_url").maybeSingle(),
    ]);
    if (fact.error) throw new Error(`tenant_fact domain read failed: ${fact.error.message}`);
    if (tenant.error) throw new Error(`tenants product_url read failed: ${tenant.error.message}`);
    if ((fact.data ?? []).length > 0) return true;
    const marketing = (tenant.data as { product_url?: { marketing?: unknown } | null } | null)?.product_url?.marketing;
    return typeof marketing === "string" && marketing.trim().length > 0;
  },
  async setWebsite(tenant_id, url, source_ref) {
    const { error } = await tenantRpc(asTenantId(tenant_id), "set_tenant_company_domain_system", {
      p_url: url,
      p_source: "provisioned",
      p_source_ref: source_ref,
    });
    if (error) throw new Error(`set_tenant_company_domain_system failed: ${error.message}`);
  },
  async regenerateBrief(tenant_id) {
    const { regenerateCompanyBrief } = await import("@/services/company/brief");
    return regenerateCompanyBrief(tenant_id);
  },
};
