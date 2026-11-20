
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { detectAndProposeBookingMapping } from "@/services/growth/booking-metrics/detect/propose";
import { getBookingMetricConfig } from "@/services/growth/booking-metrics/config";

export const BOOKING_MAPPING_DETECT_TENANT_C8reverified = true;

export function tenantsNeedingDetection(
  mongoTenantIds: string[],
  configuredTenantIds: string[],
): string[] {
  const configured = new Set(configuredTenantIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of mongoTenantIds) {
    if (!id || configured.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export const bookingMappingDetectFn = inngest.createFunction(
  {
    id: "booking-mapping-detect",
    concurrency: { limit: 1, key: "event.data.tenant_id" },
    retries: 1,
  },
  { event: "booking-mapping.detect.requested" },
  async ({ event, logger }) => {
    const tenant_id = event.data.tenant_id;
    if (!tenant_id || typeof tenant_id !== "string") {
      logger.warn("booking-mapping-detect: missing tenant_id in event");
      return { outcome: "no_tenant" };
    }

    const existing = await getBookingMetricConfig(tenant_id);
    if (existing) {
      logger.info(`booking-mapping-detect: tenant=${tenant_id} skipped (config row exists)`);
      return { outcome: "skipped_has_config" };
    }

    const r = await detectAndProposeBookingMapping(tenant_id, { timeoutMs: 60_000 });
    if (!r) {
      logger.info(`booking-mapping-detect: tenant=${tenant_id} skipped (nothing to propose)`);
      return { outcome: "skipped" };
    }
    logger.info(
      `booking-mapping-detect: tenant=${tenant_id} wrote=${r.wrote} source=${r.mapping.booking_source}`,
    );
    return { outcome: r.wrote ? "proposed" : "detect_write_failed", booking_source: r.mapping.booking_source };
  },
);

export const bookingMappingBackfillFn = inngest.createFunction(
  { id: "booking-mapping-detect-backfill", concurrency: 1 },
  { cron: "30 8 * * *" },
  async ({ step, logger }) => {
    const targets = await step.run("scan-mongo-tenants-without-config", async () => {
      const svc = serviceClient();
      const [dbCfg, bookingCfg] = await Promise.all([
        svc.from("tenant_db_config").select("tenant_id").eq("type", "mongodb"),
        svc.from("booking_metric_config").select("tenant_id"),
      ]);
      if (dbCfg.error) throw new Error(`tenant_db_config scan failed: ${dbCfg.error.message}`);
      if (bookingCfg.error) throw new Error(`booking_metric_config scan failed: ${bookingCfg.error.message}`);
      const mongoIds = (dbCfg.data ?? []).map((r) => r.tenant_id as string);
      const configuredIds = (bookingCfg.data ?? []).map((r) => r.tenant_id as string);
      return tenantsNeedingDetection(mongoIds, configuredIds);
    });

    if (targets.length > 0) {
      await step.sendEvent(
        "fire-detect-events",
        targets.map((tenant_id) => ({
          name: "booking-mapping.detect.requested" as const,
          data: { tenant_id },
        })),
      );
    }

    logger.info(`booking-mapping-detect-backfill: fired detection for ${targets.length} tenant(s)`);
    return { fired: targets.length };
  },
);
