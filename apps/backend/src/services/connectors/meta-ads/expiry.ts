
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { debugToken } from "./oauth";

export const META_ADS_SLUG = "meta_ads";
export const META_ADS_TOKEN_KEY = "meta_ads.access_token";

const FALLBACK_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export async function resolveTokenExpiry(
  longToken: string,
  expiresInSec: number | undefined,
  tenant_id: string,
): Promise<Date> {
  try {
    const dbg = await debugToken(longToken);
    if (dbg.expires_at) return dbg.expires_at;
    if (dbg.is_valid) return new Date(Date.now() + FALLBACK_TTL_MS);
  } catch {
  }
  if (typeof expiresInSec === "number" && expiresInSec > 0) {
    return new Date(Date.now() + expiresInSec * 1000);
  }
  await logEvent({
    level: "warn",
    source: "meta_ads",
    code: "meta_ads.expires_in_missing",
    tenant_id,
    message: "Meta returned no expires_in and debug_token gave no expiry; using 60d fallback",
    meta: { connector_slug: META_ADS_SLUG },
  });
  return new Date(Date.now() + FALLBACK_TTL_MS);
}

export async function persistMetaAdsExpiry(args: {
  tenant_id: string;
  access_token: string;
  expires_at: Date;
}): Promise<boolean> {
  const { error } = await tenantRpc(
    asTenantId(args.tenant_id),
    "refresh_connector_secrets",
    {
      p_slug: META_ADS_SLUG,
      p_secrets: { [META_ADS_TOKEN_KEY]: args.access_token },
      p_expires_at: args.expires_at.toISOString(),
    },
  );
  if (error) {
    await logEvent({
      level: "error",
      source: "meta_ads",
      code: "meta_ads.expiry_persist_failed",
      tenant_id: args.tenant_id,
      message: `refresh_connector_secrets failed: ${error.message}`,
      meta: { connector_slug: META_ADS_SLUG },
    });
    return false;
  }
  return true;
}
