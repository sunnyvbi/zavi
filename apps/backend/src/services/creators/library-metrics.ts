
import { fleetSweepClient } from "@/services/tenant-client";
import { metaListAdsTool } from "@/services/tools/meta-ads/list_ads";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { CREATOR_AD_METRIC_FIELDS, type CreatorAdMetrics } from "@zavi/shared";

export type LibraryMetricsRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  meta_ad_id: string | null;
  meta_ad_set_id: string | null;
  meta_auto_paused_at: string | null;
  rights_start_at: string;
  rights_end_at: string;
  metrics_read_at: string | null;
};

export const METRICS_ROW_COLUMNS =
  "id, tenant_id, order_id, meta_ad_id, meta_ad_set_id, meta_auto_paused_at, " +
  "rights_start_at, rights_end_at, metrics_read_at";

export type ReadbackOutcome =
  | "written"
  | "no_ad"
  | "no_ad_set"
  | "ad_not_in_set"
  | "settled"
  | "deferred";

const CONNECTION_ERROR_CODES = new Set([
  "meta_ads_not_connected",
  "meta_ads_token_expired",
  "meta_ads_permission_revoked",
  "meta_ads_timeout",
]);

export const SETTLE_AFTER_PAUSE_MS = 8 * 24 * 60 * 60 * 1000;

export function isSettled(row: LibraryMetricsRow): boolean {
  if (!row.meta_auto_paused_at || !row.metrics_read_at) return false;
  return (
    Date.parse(row.metrics_read_at) >=
    Date.parse(row.meta_auto_paused_at) + SETTLE_AFTER_PAUSE_MS
  );
}

export function isDue(row: LibraryMetricsRow, staleAfterMs: number, now = Date.now()): boolean {
  if (!row.meta_ad_id || !row.meta_ad_set_id) return false;
  if (isSettled(row)) return false;
  if (!row.metrics_read_at) return true;
  return now - Date.parse(row.metrics_read_at) >= staleAfterMs;
}

function asDay(iso: string | number | Date): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function projectMetrics(ad: Record<string, unknown>): CreatorAdMetrics {
  return CREATOR_AD_METRIC_FIELDS.reduce((acc, field) => {
    const v = Number(ad[field] ?? 0);
    acc[field] = Number.isFinite(v) ? v : 0;
    return acc;
  }, {} as CreatorAdMetrics);
}

export async function readbackAssetMetrics(
  row: LibraryMetricsRow,
  opts: { now?: Date } = {},
): Promise<{ outcome: ReadbackOutcome; metrics?: CreatorAdMetrics }> {
  if (!row.meta_ad_id) return { outcome: "no_ad" };
  if (!row.meta_ad_set_id) return { outcome: "no_ad_set" };
  if (isSettled(row)) return { outcome: "settled" };

  const now = opts.now ?? new Date();
  let ads: Array<Record<string, unknown>>;
  try {
    const result = (await metaListAdsTool.execute({ tenant_id: row.tenant_id, log: () => {} }, {
      adset_id: row.meta_ad_set_id,
      time_range: { since: asDay(row.rights_start_at), until: asDay(now) },
    })) as { ads?: Array<Record<string, unknown>> };
    ads = result.ads ?? [];
  } catch (e) {
    if (e instanceof ExpectedToolError && CONNECTION_ERROR_CODES.has(e.code)) {
      await logEvent({
        level: "warn",
        source: "creator.library_metrics",
        code: "readback_deferred",
        tenant_id: row.tenant_id,
        meta: { error_class: e.code },
      });
      return { outcome: "deferred" };
    }
    await logEvent({
      level: "warn",
      source: "creator.library_metrics",
      code: "readback_failed",
      tenant_id: row.tenant_id,
      meta: { error_class: e instanceof ExpectedToolError ? e.code : "unexpected" },
    });
    return { outcome: "deferred" };
  }

  const ad = ads.find((a) => String(a.ad_id ?? "") === row.meta_ad_id);
  if (!ad) {
    const settleDeadline = row.meta_auto_paused_at
      ? Date.parse(row.meta_auto_paused_at) + SETTLE_AFTER_PAUSE_MS
      : null;
    if (settleDeadline !== null && now.getTime() >= settleDeadline) {
      const sbGone = fleetSweepClient("creator library ad-metrics settle-missing-ad");
      await sbGone
        .from("creator_library_assets")
        .update({ metrics_read_at: now.toISOString() })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);
    }
    return { outcome: "ad_not_in_set" };
  }

  const metrics = projectMetrics(ad);
  const sb = fleetSweepClient("creator library ad-metrics readback");
  const { error } = await sb
    .from("creator_library_assets")
    .update({ metrics, metrics_read_at: now.toISOString() })
    .eq("id", row.id)
    .eq("tenant_id", row.tenant_id);
  if (error) {
    console.error(`[creator-library-metrics] write failed for ${row.id}: ${error.message}`);
    return { outcome: "deferred" };
  }
  return { outcome: "written", metrics };
}
