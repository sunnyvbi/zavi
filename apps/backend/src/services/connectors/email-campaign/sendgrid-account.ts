
import { getSecret } from "@/services/secrets/vault";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { sendgridKeyDigest } from "./credential";
import { campaignReady } from "./sendgrid-scopes";

export type SendgridAccount = { api_key: string; key_digest: string };

async function readSavedScopes(tenantId: string): Promise<string[] | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("connector_metadata")
    .select("scopes")
    .eq("slug", "email")
    .maybeSingle();
  if (error) throw new Error(`sendgrid connection read failed: ${error.message}`);
  const scopes = (data as { scopes?: unknown } | null)?.scopes;
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : null;
}

const scopesCampaignReady = (scopes: string[]) => campaignReady(Object.fromEntries(scopes.map((s) => [s, true])));

export async function resolveSendgridAccount(tenantId: string): Promise<SendgridAccount | null> {
  const scopes = await readSavedScopes(tenantId);
  if (!scopes || !scopesCampaignReady(scopes)) return null;
  const apiKey = await getSecret(tenantId, "email.api_key");
  if (!apiKey) return null;
  return { api_key: apiKey, key_digest: sendgridKeyDigest(apiKey) };
}

export async function sendgridKeyNeedsPermissions(tenantId: string): Promise<boolean> {
  const scopes = await readSavedScopes(tenantId);
  if (!scopes || scopesCampaignReady(scopes)) return false;
  return !!(await getSecret(tenantId, "email.api_key"));
}
