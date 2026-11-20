
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { googleApiRequest } from "@/services/connectors/google-api-request";
import { googleAnalyticsCreds } from "@/services/tools/google-analytics/_client";
import { fbGet, metaAdsCreds } from "@/services/tools/meta-ads/_client";
import { getConfirmedBookingConfig } from "@/services/growth/booking-metrics/config";
import { isValidTimeZone } from "@/services/analytics/metric-time";

export type TzSource = "stored" | "ga4_property" | "meta_ad_account" | "booking_config" | "default";

export type ResolvedTz = { tz: string; source: TzSource };

export type TzDeps = {
  readStored(tenant_id: string): Promise<string | null>;
  ga4PropertyTz(tenant_id: string): Promise<string | null>;
  metaAccountTz(tenant_id: string): Promise<string | null>;
  bookingConfigTz(tenant_id: string): Promise<string | null>;
  persistIfUnset(tenant_id: string, tz: string): Promise<void>;
};

const GA_ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";

const STORABLE_TZ = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;

export function isStorableTimeZone(tz: unknown): tz is string {
  return isValidTimeZone(tz) && STORABLE_TZ.test(tz);
}

export const realTzDeps: TzDeps = {
  async readStored(tenant_id) {
    const { data, error } = (await tenantClient(asTenantId(tenant_id))
      .from("tenants")
      .select("reporting_timezone")
      .maybeSingle()) as { data: { reporting_timezone?: string | null } | null; error: unknown };
    if (error || !data) return null;
    return data.reporting_timezone ?? null;
  },
  async ga4PropertyTz(tenant_id) {
    try {
      const creds = await googleAnalyticsCreds(tenant_id);
      const r = await googleApiRequest(creds.auth, {
        method: "GET",
        url: `${GA_ADMIN_API}/properties/${creds.property_id}`,
        timeoutMs: 8_000,
      });
      if (!r.ok) return null;
      const j = r.json as { timeZone?: string };
      return j.timeZone ?? null;
    } catch {
      return null;
    }
  },
  async metaAccountTz(tenant_id) {
    try {
      const creds = await metaAdsCreds(tenant_id);
      const j = (await fbGet(tenant_id, creds.ad_account_id, { fields: "timezone_name" })) as { timezone_name?: string };
      return j.timezone_name ?? null;
    } catch {
      return null;
    }
  },
  async bookingConfigTz(tenant_id) {
    try {
      const cfg = await getConfirmedBookingConfig(tenant_id);
      const tz = cfg?.reporting_timezone ?? null;
      return tz && tz !== "UTC" ? tz : null;
    } catch {
      return null;
    }
  },
  async persistIfUnset(tenant_id, tz) {
    await tenantClient(asTenantId(tenant_id))
      .from("tenants")
      .update({ reporting_timezone: tz })
      .is("reporting_timezone", null);
  },
};

export async function resolveReportingTimezone(
  tenant_id: string,
  opts: { persist?: boolean; deps?: TzDeps } = {},
): Promise<ResolvedTz> {
  const deps = opts.deps ?? realTzDeps;
  const persist = opts.persist ?? true;

  const stored = await deps.readStored(tenant_id).catch(() => null);
  if (isValidTimeZone(stored)) return { tz: stored, source: "stored" };

  const detectors: Array<[Exclude<TzSource, "stored" | "default">, (t: string) => Promise<string | null>]> = [
    ["ga4_property", deps.ga4PropertyTz],
    ["meta_ad_account", deps.metaAccountTz],
    ["booking_config", deps.bookingConfigTz],
  ];
  for (const [source, detect] of detectors) {
    const tz = await detect(tenant_id).catch(() => null);
    if (!isValidTimeZone(tz)) continue;
    if (persist && isStorableTimeZone(tz)) {
      await deps.persistIfUnset(tenant_id, tz).catch(() => undefined);
    }
    return { tz, source };
  }
  return { tz: "UTC", source: "default" };
}
