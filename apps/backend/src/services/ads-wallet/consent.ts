import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export const SHARED_WALLET_CONSENT_VERSION = "shared_ads_wallet_v1";
export const SHARED_WALLET_CONSENT_TEXT =
  "I authorize Zavi to use my shared ads balance for ChatGPT and LinkedIn campaigns I approve or that Autopilot runs with my paid permission. My saved-card and auto-refill settings fund this shared balance within their displayed limits. Accounts I connect myself are billed by the ad platform. Withdrawing this permission stops LinkedIn campaigns managed through Zavi and disables auto-refill; it does not stop ChatGPT campaigns or cancel spending already incurred. Changing accounts affects future campaigns; existing campaigns retain their original funding obligations.";
export async function sharedWalletConsent(tenantId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_wallet_consents")
    .select("version,revoked_at")
    .maybeSingle();
  if (error)
    throw new ExpectedToolError(
      "ads_consent_unavailable",
      "Shared wallet permission could not be checked.",
    );
  const consent = data as { version: string; revoked_at: string | null } | null;
  return (
    !!consent &&
    consent.version === SHARED_WALLET_CONSENT_VERSION &&
    consent.revoked_at === null
  );
}
export async function requireSharedWalletConsent(tenantId: string) {
  if (!(await sharedWalletConsent(tenantId)))
    throw new ExpectedToolError(
      "ads_consent_required",
      "Review and authorize shared-wallet spending first.",
    );
}

export async function autopilotLaunchedOwnBillingCampaigns(tenantId: string): Promise<string[]> {
  const db = tenantClient(asTenantId(tenantId));
  const unavailable = () => new Error("Autopilot LinkedIn launches could not be read");
  const bindings = await db
    .from("ads_campaign_binding_details")
    .select("id")
    .eq("platform", "linkedin")
    .neq("funding_source", "wallet")
    .range(0, 999);
  if (bindings.error || !Array.isArray(bindings.data) || bindings.data.length === 1000) throw unavailable();
  const ids = (bindings.data as Array<{ id: unknown }>).map((r) => String(r.id));
  if (ids.length === 0) return [];
  const ops = await db
    .from("ads_campaign_operations")
    .select("id,campaign_binding_id,created_at")
    .eq("kind", "activate")
    .in("status", ["succeeded", "uncertain", "pending"])
    .in("campaign_binding_id", ids)
    .order("created_at", { ascending: false })
    .range(0, 4999);
  if (ops.error || !Array.isArray(ops.data) || ops.data.length === 5000) throw unavailable();
  const latest = new Map<string, string>();
  for (const op of ops.data as Array<{ id: unknown; campaign_binding_id: unknown }>)
    if (!latest.has(String(op.campaign_binding_id))) latest.set(String(op.campaign_binding_id), String(op.id));
  if (latest.size === 0) return [];
  const opIds = [...latest.values()];
  const [decisions, actions] = await Promise.all([
    db.from("decisions").select("id,approved_by_source").in("id", opIds),
    db.from("channel_actions").select("id,approved_by_source").eq("tenant_id", tenantId).in("id", opIds),
  ]);
  if (decisions.error || !Array.isArray(decisions.data) || actions.error || !Array.isArray(actions.data)) throw unavailable();
  const byAutopilot = new Set(
    ([...decisions.data, ...actions.data] as Array<{ id: unknown; approved_by_source: unknown }>)
      .filter((d) => d.approved_by_source === "cgo")
      .map((d) => String(d.id)),
  );
  return [...latest].filter(([, op]) => byAutopilot.has(op)).map(([binding]) => binding);
}
