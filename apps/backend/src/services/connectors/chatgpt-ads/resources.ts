import type { CampaignResourceOptions } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { previewChatgptAccount } from "@/services/ads-wallet/chatgpt-account-preview";
import { chatgptAdsGet } from "./http";

type Binding = { resource_id: string; kind: "conversion_event" | "audience" | "product_feed"; source_id: string | null };
export async function bindings(tenantId: string, accountId?:string|null): Promise<Binding[]> {
  let q = tenantClient(asTenantId(tenantId)).from("ads_resource_binding_details").select("resource_id,kind,source_id").eq("tenant_id", tenantId);
  q=accountId?q.eq("account_id",accountId):q.eq("legacy_key","chatgpt_platform");
  const r=await q;
  if (r.error) throw new ExpectedToolError("ads_resource_setup_unavailable", "Workspace tracking and audience setup could not be checked. Try again later.");
  return (r.data ?? []) as Binding[];
}
async function providerList(key: string, path: string, query: Record<string, string> = {}) {
  const rows: Record<string, any>[] = []; let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await chatgptAdsGet<{ data: Record<string, any>[]; has_more?: boolean; last_id?: string }>(key, path, { ...query, limit: 500, after });
    if (!Array.isArray(r.data)) throw new Error("Unreadable resource list");
    rows.push(...r.data);
    if (!r.has_more) return rows;
    if (!r.last_id || r.last_id === after) break;
    after = r.last_id;
  }
  throw new Error("Incomplete resource list");
}
export type ResourceAccount={key:string;accountId:string};
export async function resourceOptions(tenantId: string, context?:ResourceAccount): Promise<CampaignResourceOptions> {
  const resolved=context??await previewChatgptAccount(tenantId);
  const owned = await bindings(tenantId,resolved.accountId);
  const {key} = resolved;
  const result: CampaignResourceOptions = { conversion_events: [], inclusion_audiences: [], exclusion_audiences: [], product_feeds: [], warnings: [] };
  const specs = [
    ["conversion_events", "conversion_event", "/conversions/event_settings", {}],
    ["inclusion_audiences", "audience", "/custom_audiences", { intended_use: "inclusion" }],
    ["exclusion_audiences", "audience", "/custom_audiences", { intended_use: "exclusion" }],
    ["product_feeds", "product_feed", "/feeds", {}],
  ] as const;
  await Promise.all(specs.map(async ([field, kind, path, query]) => {
    const bound = owned.filter(b => b.kind === kind);
    if (!bound.length) return;
    try {
      const rows = await providerList(key, path, query);
      result[field] = rows.filter(r => {
        const b = bound.find(b => b.resource_id === (r.id ?? r.feed_id));
        if (!b || r.archived === true || r.status === "archived") return false;
        if (kind === "conversion_event") return r.archived === false && typeof r.event_type === "string" && r.event_type !== "custom" && r.source_ids?.length === 1 && r.source_ids[0] === b.source_id && !r.sources?.some((s: any) => s.archived === true || s.status === "inactive");
        return kind !== "audience" || r.status === "ready";
      }).map(r => ({ id: r.id ?? r.feed_id, name: typeof r.name === "string" ? r.name : "Workspace resource" }));
    } catch { result.warnings.push(`${field.replaceAll("_", " ")} could not be verified. Zavi must check provider setup.`); }
  }));
  return result;
}
export function requireOption(options: Array<{ id: string }>, value: string) {
  if (!options.some(o => o.id === value)) throw new ExpectedToolError("chatgpt_ads_conflict", "This tracking source, audience or feed is not verified for your workspace. Ask Zavi to complete its setup.");
}
