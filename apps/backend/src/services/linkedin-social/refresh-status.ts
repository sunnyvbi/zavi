import { asTenantId, tenantClient } from "@/services/tenant-client";

const KEY = "linkedin_public_refresh";
export type LinkedInRefreshStatus = { page_url: string; at: string; ok: boolean; message: string | null };

export async function readLinkedInRefreshStatus(tenantId: string, pageUrl: string | null, client?: ReturnType<typeof tenantClient>): Promise<LinkedInRefreshStatus | null> {
  try {
    const { data, error } = await (client ?? tenantClient(asTenantId(tenantId))).from("tenant_app_setting").select("value").eq("tenant_id", tenantId).eq("key", KEY).maybeSingle();
    const v = (data as { value?: unknown } | null)?.value as Partial<LinkedInRefreshStatus> | undefined;
    if (error || !v || v.page_url !== pageUrl || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at)) || typeof v.ok !== "boolean") return null;
    return { page_url: v.page_url, at: v.at, ok: v.ok, message: typeof v.message === "string" ? v.message : null };
  } catch { return null; }
}

export async function writeLinkedInRefreshStatus(tenantId: string, status: LinkedInRefreshStatus, client?: ReturnType<typeof tenantClient>): Promise<void> {
  try {
    const { error } = await (client ?? tenantClient(asTenantId(tenantId))).from("tenant_app_setting").upsert({
      tenant_id: tenantId, key: KEY, value: status, updated_at: status.at, updated_by: "linkedin-public-refresh",
    }, { onConflict: "tenant_id,key" });
    if (error) console.warn("[linkedin-snapshots] could not save refresh status");
  } catch { console.warn("[linkedin-snapshots] could not save refresh status"); }
}
