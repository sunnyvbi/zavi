
import { ExpectedToolError } from "@/services/tools/types";
import { debugToken } from "@/services/connectors/meta-ads/oauth";
import { metaAdsCreds } from "./_client";

const TTL_MS = 10 * 60_000;
const CACHE = new Map<string, { scopes: Set<string>; exp: number }>();

export function _resetScopeCache(): void {
  CACHE.clear();
}

const GEN = new Map<string, number>();

export function forgetMetaScopes(tenant_id: string): void {
  GEN.set(tenant_id, (GEN.get(tenant_id) ?? 0) + 1);
  CACHE.delete(tenant_id);
}

async function grantedScopes(tenant_id: string): Promise<Set<string> | null> {
  const hit = CACHE.get(tenant_id);
  if (hit && hit.exp > Date.now()) return hit.scopes;
  const gen = GEN.get(tenant_id) ?? 0;
  try {
    const { access_token } = await metaAdsCreds(tenant_id);
    const d = await debugToken(access_token);
    const scopes = new Set(d.scopes);
    if ((GEN.get(tenant_id) ?? 0) === gen) CACHE.set(tenant_id, { scopes, exp: Date.now() + TTL_MS });
    return scopes;
  } catch {
    return null;
  }
}

export const META_SCOPES_PENDING_APP_REVIEW: ReadonlySet<string> = new Set(["business_management"]);

export async function assertMetaScopes(tenant_id: string, needed: readonly string[], what: string): Promise<void> {
  const scopes = await grantedScopes(tenant_id);
  if (!scopes) return;
  const missing = needed.filter((s) => !scopes.has(s));
  if (missing.length === 0) return;
  if (missing.some((s) => META_SCOPES_PENDING_APP_REVIEW.has(s))) {
    const adsOk = scopes.has("ads_management") || scopes.has("ads_read");
    throw new ExpectedToolError(
      "meta_ads_scope_missing",
      `${what} needs the Meta permission ${missing.join(", ")}, which Meta has not yet approved for Zavi's app, so reconnecting cannot add it. Business Manager-level reads (its ad accounts, Pages, pixels) are waiting on Meta's review of our app; there is nothing to do on your side.${adsOk ? " Campaign-level reads still work." : ""}`,
      { next_step: "praxis_admin_action", missing_scopes: missing, app_review_pending: true },
    );
  }
  throw new ExpectedToolError(
    "meta_ads_scope_missing",
    `${what} needs the Meta permission ${missing.join(", ")}, which this connection does not have. Reconnect Meta Ads and allow it; if Meta does not offer it, Zavi's app is still waiting for Meta's approval of that permission.`,
    { next_step: "operator_action", missing_scopes: missing },
  );
}
