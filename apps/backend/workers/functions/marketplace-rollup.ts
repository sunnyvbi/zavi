
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting, setTenantSetting } from "@/services/settings";
import { withReadSession } from "@/services/data-gateway";
import { mongoDbAdapter } from "@/services/tools/operator-db/session-attach";
import { resolveMarketplaceConfig } from "@/services/marketplace-intel/self-serve";
import { computeSqlRollup, isSqlDialect } from "@/services/marketplace-intel/aggregate-sql";
import { WINDOW_WEEKS_DEFAULT } from "@/services/marketplace-intel/contract";
import { GatewayRefusal } from "@/services/data-gateway/types";
import {
  computeMongoRollup,
  regionKeyOf,
  type MarketplaceIntelMongoDb,
} from "@/services/marketplace-intel/aggregate";

type ConfigTenantRow = {
  tenant_id: string;
};

type RollupRow = {
  tenant_id: string;
  state: string | null;
  geo_label: string;
  week_start: string;
  bookings_n: number;
  active_supply_n: number;
  total_listings: number | null;
  completed_listings: number | null;
  gmv_proxy_n: number | null;
  demand_basis: string;
  supply_basis: string;
  confidence: string;
  suppressed: boolean;
  computed_at: string;
};

const ROLLUP_WINDOW_WEEKS = WINDOW_WEEKS_DEFAULT;

type RollupResult =
  | { status: "processed"; rows: number }
  | { status: "skipped"; reason: string };

export type RollupFailureCode = "bad_date_field" | "too_much_data" | "too_slow" | "connection" | "refused" | "other";

function gatewayRefusalOf(e: unknown): { refused_by: string; reason: string } | null {
  if (e instanceof GatewayRefusal) return { refused_by: e.refused_by, reason: e.reason };
  if (!e || typeof e !== "object") return null;
  const x = e as { code?: unknown; refused_by?: unknown; reason?: unknown };
  if (x.code !== "data_access_refused") return null;
  return { refused_by: typeof x.refused_by === "string" ? x.refused_by : "unknown", reason: typeof x.reason === "string" ? x.reason : "" };
}

export function refusalReasonCode(reason: string): string {
  return /^(mongo_read_[a-z0-9_]{2,60}):/.exec(reason)?.[1] ?? "unlisted";
}

export function classifyRollupError(e: unknown): RollupFailureCode {
  if (gatewayRefusalOf(e)) return "refused";
  const msg = e instanceof Error ? e.message : String(e);
  if (/row cap/i.test(msg)) return "too_much_data";
  if (/(statement timeout|max_execution_time|maximum statement execution time|exceeded time limit|operation exceeded time limit|MaxTimeMSExpired)/i.test(msg)) {
    return "too_slow";
  }
  if (/(timestamp|datetime|date\b|time zone|invalid input syntax|incorrect .*value|can't convert|cast)/i.test(msg)) {
    return "bad_date_field";
  }
  if (/(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed? ?out|authentication|password|connect)/i.test(msg)) {
    return "connection";
  }
  return "other";
}

export function isoMondayUtc(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - day + 1);
  return x.toISOString().slice(0, 10);
}

class StatusWriteError extends Error {}

async function recordLastRun(
  tenant_id: string,
  value: {
    status: "ok" | "failed";
    at: string;
    code?: RollupFailureCode;
    refused_by?: string;
    reason_code?: string;
    setup_id?: string;
  },
): Promise<void> {
  try {
    await setTenantSetting(tenant_id, "marketplace_rollup_last_run", value, "marketplace-rollup");
  } catch (e) {
    console.warn(`[marketplace-rollup] last-run status write failed for ${tenant_id}: ${(e as Error).message}`);
  }
}

export async function rollupTenant(tenant_id: string): Promise<RollupResult> {
  const enabled = await getBoolSetting("marketplace_intel_enabled", tenant_id);
  if (!enabled) {
    return { status: "skipped", reason: "marketplace_intel_enabled=false" };
  }

  const marketplaceConfig = await resolveMarketplaceConfig(tenant_id);
  if (!marketplaceConfig) {
    return { status: "skipped", reason: "no confirmed Supply & Demand setup" };
  }

  const startedAt = new Date().toISOString();
  try {
    return await runRollup(tenant_id, marketplaceConfig, startedAt);
  } catch (e) {
    if (e instanceof StatusWriteError) throw e;
    const code = classifyRollupError(e);
    const refusal = gatewayRefusalOf(e);
    const detail = refusal ? { refused_by: refusal.refused_by, reason_code: refusalReasonCode(refusal.reason) } : {};
    console.warn(JSON.stringify({ evt: "marketplace_rollup.failed", tenant_id, code, ...detail, setup_id: marketplaceConfig.provenance.setup_id ?? null }));
    await recordLastRun(tenant_id, {
      status: "failed",
      at: startedAt,
      code,
      ...detail,
      setup_id: marketplaceConfig.provenance.setup_id,
    });
    throw e;
  }
}

async function runRollup(
  tenant_id: string,
  marketplaceConfig: NonNullable<Awaited<ReturnType<typeof resolveMarketplaceConfig>>>,
  computed_at: string,
): Promise<RollupResult> {
  const read = await withReadSession({ tenant_id, caller: { kind: "background", feature: "Marketplace rollup" } }, async (session, access) => {
    const dbType = access.dialect;
    if (dbType !== marketplaceConfig.dialect) {
      return { skip: `operator DB type ${dbType} != setup dialect ${marketplaceConfig.dialect}` } as const;
    }
    if (isSqlDialect(dbType)) return computeSqlRollup(dbType, session, marketplaceConfig);
    if (dbType === "mongodb") {
      return computeMongoRollup(mongoDbAdapter(session.mongo()) as unknown as MarketplaceIntelMongoDb, marketplaceConfig);
    }
    return { skip: `operator DB type is ${dbType}` } as const;
  });
  if ("skip" in read) return { status: "skipped", reason: read.skip };
  const { cells, supply } = read;

  const supplyByRegion = new Map(supply.map((snapshot) => [regionKeyOf(snapshot), snapshot]));
  const rollupRows: RollupRow[] = cells.map((cell) => {
    const snapshot = supplyByRegion.get(regionKeyOf(cell)) ?? null;
    return {
      tenant_id,
      state: cell.state,
      geo_label: cell.geo_label,
      week_start: cell.week_start,
      bookings_n: cell.bookings_n,
      active_supply_n: cell.active_supply_n,
      total_listings: snapshot?.total_listings ?? null,
      completed_listings: snapshot?.completed_listings ?? null,
      gmv_proxy_n: cell.gmv_proxy_n,
      demand_basis: cell.demand_basis,
      supply_basis: cell.supply_basis,
      confidence: cell.confidence,
      suppressed: cell.suppressed,
      computed_at,
    };
  });

  const regionsWithRows = new Set(rollupRows.map((r) => regionKeyOf(r)));
  const currentWeek = isoMondayUtc(new Date(computed_at));
  for (const [region, snapshot] of supplyByRegion) {
    if (regionsWithRows.has(region)) continue;
    rollupRows.push({
      tenant_id,
      state: snapshot.state,
      geo_label: snapshot.geo_label,
      week_start: currentWeek,
      bookings_n: 0,
      active_supply_n: 0,
      total_listings: snapshot.total_listings,
      completed_listings: snapshot.completed_listings,
      gmv_proxy_n: null,
      demand_basis: "bookings",
      supply_basis: "booked_listings",
      confidence: snapshot.confidence,
      suppressed: true,
      computed_at,
    });
  }

  const { error: rpcError } = await serviceClient().rpc("upsert_marketplace_rollup", {
    p_tenant: tenant_id,
    p_rows: rollupRows,
  });
  if (rpcError) {
    throw new Error(`upsert_marketplace_rollup failed: ${rpcError.message}`);
  }

  const windowFrom = isoMondayUtc(
    new Date(new Date(computed_at).getTime() - ROLLUP_WINDOW_WEEKS * 7 * 24 * 3600 * 1000),
  );
  const { error: pruneError } = await serviceClient()
    .from("marketplace_geo_category_weekly")
    .delete()
    .eq("tenant_id", tenant_id)
    .gte("week_start", windowFrom)
    .lt("computed_at", computed_at);
  if (pruneError) {
    throw new Error(`marketplace rollup prune failed: ${pruneError.message}`);
  }
  const confirmedAt = marketplaceConfig.provenance.confirmed_at;
  if (confirmedAt) {
    const { error: setupPruneError } = await serviceClient()
      .from("marketplace_geo_category_weekly")
      .delete()
      .eq("tenant_id", tenant_id)
      .lt("computed_at", confirmedAt);
    if (setupPruneError) {
      throw new Error(`marketplace rollup setup prune failed: ${setupPruneError.message}`);
    }
  }

  try {
    await setTenantSetting(
      tenant_id,
      "marketplace_rollup_last_run",
      { status: "ok", at: computed_at, setup_id: marketplaceConfig.provenance.setup_id },
      "marketplace-rollup",
    );
  } catch (e) {
    throw new StatusWriteError((e as Error).message);
  }
  return { status: "processed", rows: rollupRows.length };
}

export const marketplaceRollupFn = inngest.createFunction(
  { id: "marketplace-rollup", concurrency: 1 },
  { cron: "30 8 * * *" },
  async ({ logger, step }) => {
    const svc = serviceClient();

    const { data: confirmedRows, error: confirmedError } = await svc
      .from("mapping_confirmed")
      .select("tenant_id");
    if (confirmedError) {
      throw new Error(`marketplace-rollup confirmed-mapping scan failed: ${confirmedError.message}`);
    }

    const tenants = [
      ...new Set(((confirmedRows ?? []) as ConfigTenantRow[]).map((row) => row.tenant_id)),
    ];
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const tenant_id of tenants) {
      try {
        const result = await step.run(`marketplace-rollup:${tenant_id}`, () =>
          rollupTenant(tenant_id),
        );

        if (result.status === "processed") {
          processed += 1;
        } else {
          skipped += 1;
          logger.info(`marketplace-rollup skipped tenant ${tenant_id}: ${result.reason}`);
        }
      } catch (e) {
        failed += 1;
        logger.error(`marketplace-rollup tenant ${tenant_id} failed: ${classifyRollupError(e)}`);
      }
    }

    return { tenants: tenants.length, processed, skipped, failed };
  },
);

export const marketplaceRollupRequestedFn = inngest.createFunction(
  {
    id: "marketplace-rollup-requested",
    concurrency: { limit: 1, key: "event.data.tenant_id" },
    debounce: { period: "30s", key: "event.data.tenant_id" },
  },
  { event: "marketplace.rollup.requested" },
  async ({ event, logger, step }) => {
    const tenant_id = event.data.tenant_id;
    if (typeof tenant_id !== "string" || !tenant_id) {
      return { status: "skipped" as const, reason: "missing tenant_id" };
    }
    const { data: tenantRow, error: tenantError } = await serviceClient()
      .from("tenants")
      .select("id")
      .eq("id", tenant_id)
      .maybeSingle();
    if (tenantError) {
      throw new Error(`marketplace-rollup-requested tenant check failed: ${tenantError.message}`);
    }
    if (!tenantRow) {
      logger.warn(`marketplace-rollup-requested: unknown tenant ${tenant_id}, skipping`);
      return { status: "skipped" as const, reason: "unknown tenant" };
    }
    const result = await step.run(`marketplace-rollup:${tenant_id}`, () =>
      rollupTenant(tenant_id),
    );
    if (result.status === "skipped") {
      logger.info(`marketplace-rollup-requested skipped tenant ${tenant_id}: ${result.reason}`);
    }
    return result;
  },
);
