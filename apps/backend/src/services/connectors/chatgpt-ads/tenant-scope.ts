
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { CHATGPT_ADS_NAME_NAMESPACE, CHATGPT_ADS_NAME_SEPARATOR } from "./constants";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeCampaignName(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

export function tenantCampaignPrefix(slug: string): string {
  const s = (slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(s)) {
    throw new ExpectedToolError(
      "chatgpt_ads_tenant_prefix_unavailable",
      "This workspace has no usable slug, so the campaigns that belong to it cannot be told apart " +
        "from other advertisers in the shared ad account. No performance figures can be read.",
    );
  }
  return `${CHATGPT_ADS_NAME_NAMESPACE}${s}${CHATGPT_ADS_NAME_SEPARATOR}`;
}

export function ownsCampaignName(name: unknown, prefix: string): boolean {
  if (!prefix.endsWith(CHATGPT_ADS_NAME_SEPARATOR)) {
    throw new Error(
      `ownsCampaignName: prefix must end with the '${CHATGPT_ADS_NAME_SEPARATOR}' separator`,
    );
  }
  const n = normalizeCampaignName(name);
  if (n.length <= prefix.length || !n.startsWith(prefix)) return false;
  const rest = n.slice(prefix.length);
  if (rest.startsWith("-")) return false;
  return !rest.includes(CHATGPT_ADS_NAME_SEPARATOR);
}

export async function resolveTenantCampaignPrefix(tenant_id: string): Promise<string> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("tenants")
    .select("slug")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) {
    throw new ExpectedToolError(
      "chatgpt_ads_tenant_prefix_unavailable",
      `Could not read this workspace's slug (${error.message}), so its campaigns cannot be told ` +
        "apart from other advertisers in the shared ad account. No performance figures were read.",
    );
  }
  const slug = (data as { slug?: string } | null)?.slug ?? "";
  return tenantCampaignPrefix(slug);
}

export function assertOwnedRows<T extends { campaign_id: string; row_campaign_id?: string | null }>(
  rows: T[],
  ownedIds: ReadonlySet<string>,
): { kept: T[]; dropped: number } {
  const kept = rows.filter(
    (r) =>
      ownedIds.has(r.campaign_id) &&
      (r.row_campaign_id == null || r.row_campaign_id === r.campaign_id),
  );
  return { kept, dropped: rows.length - kept.length };
}
