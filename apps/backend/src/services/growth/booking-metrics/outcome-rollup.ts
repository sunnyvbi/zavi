
import { withReadSession } from "@/services/data-gateway";
import type { GatewayContext } from "@/services/data-gateway/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { addDays, localDateOf, localDayStartUtc } from "@/services/analytics/metric-time";
import {
  readSourceWatermark,
  getOutcomeMap,
  readFirstCompletions,
  readUnplacedByDay,
  type OutcomeMap,
  type UnplacedDay,
} from "./outcomes";

export type RollupDay = { d: string; first: number; u_cac: number; u_roas: number; pos: number; neg: number; unr: number };

export type OutcomeRollup = {
  basis: string;
  through_day: string;
  first_seen_floor: string | null;
  source_watermark: string;
  days: RollupDay[];
  refreshed_at: string;
};

export function outcomeFingerprint(map: OutcomeMap, tz: string): string {
  return JSON.stringify([
    map.engine,
    map.booking_source,
    map.date_field,
    map.status_field,
    [...map.terminal_statuses].sort(),
    map.completed_at_field,
    map.customer_ref_field,
    map.revenue_field,
    map.refund_field,
    map.refund_basis,
    map.amount_unit,
    map.outcome_confirmed_at,
    tz,
  ]);
}

export function mergeRollupDays(first: Array<{ date: string; customers: number }>, unplaced: UnplacedDay[]): RollupDay[] {
  const by = new Map<string, RollupDay>();
  const get = (d: string) => by.get(d) ?? { d, first: 0, u_cac: 0, u_roas: 0, pos: 0, neg: 0, unr: 0 };
  for (const f of first) by.set(f.date, { ...get(f.date), first: f.customers });
  for (const u of unplaced) {
    const cur = get(u.d);
    by.set(u.d, { ...cur, u_cac: u.u_cac, u_roas: u.u_roas, pos: u.pos, neg: u.neg, unr: u.unr });
  }
  return [...by.values()].sort((a, b) => a.d.localeCompare(b.d));
}

const BACKGROUND = { kind: "background" as const, feature: "Finished-outcome metrics" };

export type RefreshDeps = {
  getOutcomeMap: typeof getOutcomeMap;
  compute: (
    tenant_id: string,
    map: OutcomeMap,
    tz: string,
    throughUntil: Date,
  ) => Promise<{ first: Array<{ date: string; customers: number }>; unplaced: UnplacedDay[]; floor: string | null; source_watermark: string }>;
  write: (tenant_id: string, row: OutcomeRollup) => Promise<void>;
  now: () => Date;
};

const realDeps: RefreshDeps = {
  getOutcomeMap: (t) => getOutcomeMap(t),
  async compute(tenant_id, map, tz, throughUntil) {
    const ctx: GatewayContext = { tenant_id, caller: BACKGROUND };
    return withReadSession(ctx, async (session) => {
      const source_watermark = await readSourceWatermark(session, map);
      const fc = await readFirstCompletions(session, map, { since: new Date(0), until: throughUntil, tz });
      const unplaced = await readUnplacedByDay(session, map, tz);
      return { first: fc.days, unplaced, floor: fc.first_seen_floor, source_watermark };
    });
  },
  async write(tenant_id, row) {
    const { error } = await tenantClient(asTenantId(tenant_id))
      .from("outcome_rollup")
      .upsert({ tenant_id, ...row }, { onConflict: "tenant_id" });
    if (error) throw new Error(`outcome_rollup write failed: ${error.message}`);
  },
  now: () => new Date(),
};

export async function refreshOutcomeRollup(tenant_id: string, tz: string, deps: RefreshDeps = realDeps): Promise<OutcomeRollup | null> {
  const res = await deps.getOutcomeMap(tenant_id);
  if (!res.ok) return null;
  const now = deps.now();
  const through_day = addDays(localDateOf(now, tz), -1);
  const throughUntil = localDayStartUtc(addDays(through_day, 1), tz);
  const out = await deps.compute(tenant_id, res.map, tz, throughUntil);
  const row: OutcomeRollup = {
    basis: outcomeFingerprint(res.map, tz),
    through_day,
    first_seen_floor: out.floor,
    source_watermark: out.source_watermark,
    days: mergeRollupDays(
      out.first.filter((f) => f.date <= through_day),
      out.unplaced,
    ),
    refreshed_at: now.toISOString(),
  };
  await deps.write(tenant_id, row);
  return row;
}

export async function readOutcomeRollup(tenant_id: string): Promise<OutcomeRollup | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("outcome_rollup")
    .select("basis, through_day, first_seen_floor, source_watermark, days, refreshed_at")
    .maybeSingle();
  if (error) throw new Error(`outcome_rollup read failed: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    basis: String(r.basis ?? ""),
    through_day: String(r.through_day ?? "").slice(0, 10),
    first_seen_floor: (r.first_seen_floor as string | null) ?? null,
    source_watermark: String(r.source_watermark ?? ""),
    days: Array.isArray(r.days) ? (r.days as RollupDay[]) : [],
    refreshed_at: String(r.refreshed_at ?? ""),
  };
}

export function usableRollup(
  rollup: OutcomeRollup | null,
  map: OutcomeMap,
  tz: string,
  until: string,
  liveWatermark: string,
  now: Date = new Date(),
): OutcomeRollup | null {
  if (!rollup) return null;
  if (rollupOlderThanMaxAge(rollup, now)) return null;
  if (!rollup.source_watermark || rollup.source_watermark !== liveWatermark) return null;
  if (rollup.basis !== outcomeFingerprint(map, tz)) return null;
  if (rollup.through_day < until) return null;
  return rollup;
}

export function rollupIsStale(rollup: OutcomeRollup | null, map: OutcomeMap, tz: string, now: Date): boolean {
  if (!rollup || rollup.basis !== outcomeFingerprint(map, tz)) return true;
  if (rollupOlderThanMaxAge(rollup, now)) return true;
  return rollup.through_day < addDays(localDateOf(now, tz), -1);
}

export const ROLLUP_MAX_AGE_MS = 6 * 3600_000;

function rollupOlderThanMaxAge(rollup: OutcomeRollup, now: Date): boolean {
  const t = Date.parse(rollup.refreshed_at);
  return !Number.isFinite(t) || now.getTime() - t > ROLLUP_MAX_AGE_MS;
}

export async function rollupNeedsRebuild(
  tenant_id: string,
  tz: string,
  now: Date,
  deps: {
    getOutcomeMap: typeof getOutcomeMap;
    readRollup: typeof readOutcomeRollup;
    liveWatermark: (map: OutcomeMap) => Promise<string>;
  } = {
    getOutcomeMap: (t) => getOutcomeMap(t),
    readRollup: readOutcomeRollup,
    liveWatermark: (map) => withReadSession({ tenant_id, caller: BACKGROUND }, (s) => readSourceWatermark(s, map)),
  },
): Promise<boolean> {
  const res = await deps.getOutcomeMap(tenant_id);
  if (!res.ok) return false;
  const stored = await deps.readRollup(tenant_id);
  if (rollupIsStale(stored, res.map, tz, now)) return true;
  return stored!.source_watermark !== (await deps.liveWatermark(res.map));
}
