
import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import { fbGet } from "@/services/tools/meta-ads/_client";
import { metaSetStatus } from "@/services/tools/meta-ads/write/set_status";
import { ExpectedToolError } from "@/services/tools/types";
import { isRetryableMetaReadError } from "@/services/tools/meta-ads/_retryable";
import { logEvent } from "@/services/logging/logEvent";

const SWEEP_LIMIT = 50;

const NOT_RUNNING = new Set(["PAUSED", "DELETED", "ARCHIVED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"]);

const CONNECTION_ERROR_CODES = new Set([
  "meta_ads_not_connected",
  "meta_ads_token_expired",
  "meta_ads_permission_revoked",
  "meta_ads_timeout",
]);

function isMetaObjectGone(e: unknown): boolean {
  if (!(e instanceof ExpectedToolError)) return false;
  if (e.code !== "meta_ads_query_failed" && e.code !== "meta_ads_write_failed") return false;
  const m = (e.meta ?? {}) as Record<string, unknown>;
  const subcode = typeof m.graph_subcode === "number" ? m.graph_subcode : m.subcode;
  return m.graph_code === 100 && subcode === 33;
}

export type LibraryAdRow = {
  id: string;
  tenant_id: string;
  meta_ad_id: string | null;
  meta_auto_paused_at: string | null;
  rights_end_at: string;
};

export type PauseOutcome = "paused" | "already_paused" | "gone" | "nothing_to_pause" | "deferred";

const ROW_COLUMNS = "id, tenant_id, meta_ad_id, meta_auto_paused_at, rights_end_at";

export async function pauseExpiredLibraryAd(row: LibraryAdRow): Promise<PauseOutcome> {
  if (row.meta_auto_paused_at) return "already_paused";
  if (!row.meta_ad_id) return "nothing_to_pause";

  let outcome: PauseOutcome;
  try {
    const node = (await fbGet(row.tenant_id, row.meta_ad_id, { fields: "id,status" }, { safety: true })) as {
      status?: string;
    };
    if (node.status && NOT_RUNNING.has(node.status)) {
      outcome = "already_paused";
    } else {
      await metaSetStatus(row.tenant_id, {
        object_id: row.meta_ad_id,
        level: "ad",
        status: "PAUSED",
      });
      outcome = "paused";
    }
  } catch (e) {
    if (!isMetaObjectGone(e)) {
      const retryable = isRetryableMetaReadError(e);
      const expected = retryable || (e instanceof ExpectedToolError && CONNECTION_ERROR_CODES.has(e.code));
      await logEvent({
        level: expected ? "warn" : "error",
        source: "creator.rights_expiry",
        code: "pause_deferred",
        tenant_id: row.tenant_id,
        meta: {
          error_class: e instanceof ExpectedToolError ? e.code : ((e as { code?: unknown })?.code ?? (e as Error)?.name ?? "unknown"),
          retryable,
          asset_id: row.id,
        },
      }).catch(() => undefined);
      return "deferred";
    }
    outcome = "gone";
  }

  await stamp(row.id);
  return outcome;
}

async function stamp(asset_id: string): Promise<void> {
  const sb = fleetSweepClient("creator library rights-expiry auto-pause stamp");
  const { error } = await sb
    .from("creator_library_assets")
    .update({ meta_auto_paused_at: new Date().toISOString() })
    .eq("id", asset_id)
    .is("meta_auto_paused_at", null);
  if (error) {
    console.error(`[creator-rights-expiry] stamp failed for ${asset_id}: ${error.message}`);
  }
}

export async function readLibraryAdRow(asset_id: string): Promise<LibraryAdRow | null> {
  const sb = fleetSweepClient("creator library rights-expiry single-row read");
  const { data } = await sb
    .from("creator_library_assets")
    .select(ROW_COLUMNS)
    .eq("id", asset_id)
    .maybeSingle();
  return (data as LibraryAdRow | null) ?? null;
}

export async function runRightsExpiryWaitHandler(
  asset_id: string,
  logger: { info: (m: string) => void },
): Promise<{ outcome: PauseOutcome }> {
  const row = await readLibraryAdRow(asset_id);
  if (!row) return { outcome: "nothing_to_pause" };
  if (Date.parse(row.rights_end_at) > Date.now()) {
    return { outcome: "deferred" };
  }
  const outcome = await pauseExpiredLibraryAd(row);
  logger.info(`creator-rights-expiry: ${asset_id} -> ${outcome}`);
  return { outcome };
}

export async function runRightsExpirySweepHandler(logger: {
  info: (m: string) => void;
  error?: (m: string) => void;
}): Promise<{ claimed: number; paused: number; quiet: number; deferred: number }> {
  const sb = fleetSweepClient("creator library rights-expiry due sweep");
  const { data, error } = await sb
    .from("creator_library_assets")
    .select(ROW_COLUMNS)
    .not("meta_ad_id", "is", null)
    .is("meta_auto_paused_at", null)
    .lte("rights_end_at", new Date().toISOString())
    .order("rights_end_at", { ascending: true })
    .limit(SWEEP_LIMIT);

  if (error) {
    logger.error?.(`creator-rights-expiry sweep: read failed — ${error.message}`);
    return { claimed: 0, paused: 0, quiet: 0, deferred: 0 };
  }

  const rows = (data ?? []) as LibraryAdRow[];
  let paused = 0;
  let quiet = 0;
  let deferred = 0;
  for (const row of rows) {
    const outcome = await pauseExpiredLibraryAd(row);
    if (outcome === "paused") paused += 1;
    else if (outcome === "deferred") deferred += 1;
    else quiet += 1;
  }

  if (rows.length > 0) {
    logger.info(
      `creator-rights-expiry sweep: claimed=${rows.length} paused=${paused} quiet=${quiet} deferred=${deferred}`,
    );
  }
  return { claimed: rows.length, paused, quiet, deferred };
}

export const creatorRightsExpiryWaitFn = inngest.createFunction(
  { id: "creator-rights-expiry-wait", concurrency: 20 },
  { event: "creator/rights_expiry.scheduled" },
  async ({ event, step, logger }) => {
    const { asset_id, rights_end_at } = event.data as { asset_id: string; rights_end_at: string };
    await step.sleepUntil("until-rights-end", new Date(rights_end_at));
    return step.run("pause", () => runRightsExpiryWaitHandler(asset_id, logger));
  },
);

export const creatorRightsExpirySweepFn = inngest.createFunction(
  { id: "creator-rights-expiry-sweep", concurrency: 1 },
  { cron: "45 * * * *" },
  async ({ logger }) => runRightsExpirySweepHandler(logger),
);
