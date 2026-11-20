
import { withReadSession } from "@/services/data-gateway";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { addDays, localDayStartUtc, type ResolvedWindow } from "@/services/analytics/metric-time";
import {
  describeMissing,
  fieldsMissingFromCatalog,
  getOutcomeMap,
  readCompletedRevenue,
  readFirstCompletions,
  readUnplacedByDay,
  unplacedThrough,
  readSourceWatermark,
  pgZonelessTimeFields,
  UnsupportedEngineError,
  type OutcomeMap,
  type OutcomeWindow,
  type UnplacedDay,
} from "@/services/growth/booking-metrics/outcomes";
import { readOutcomeRollup, usableRollup, type OutcomeRollup } from "@/services/growth/booking-metrics/outcome-rollup";
import type { ReadSession } from "@/services/data-gateway/session";
import { fetchAdSpendTotal } from "./ads";
import { div, sumByDate } from "./shared";
import type { Bounds, Estimate, FetchOk, FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

export type OutcomeKind = "cac" | "roas";

export type LedgerSeen = { platform: string; usd: number; first_day: string; last_day: string };

export type OutcomeDeps = {
  getOutcomeMap: typeof getOutcomeMap;
  catalogColumns: (tenant_id: string, table: string) => Promise<Array<{ name: string; type: string; nullable: boolean }> | null>;
  spend: typeof fetchAdSpendTotal;
  connectedSlugs: (tenant_id: string) => Promise<string[]>;
  ledgerSeen: (tenant_id: string, since: string, until: string) => Promise<LedgerSeen[]>;
  withSession: <T>(ctx: MetricFetchCtx, fn: (s: ReadSession) => Promise<T>) => Promise<T>;
  readRollup: (tenant_id: string) => Promise<OutcomeRollup | null>;
  requestRefresh: (tenant_id: string) => Promise<void>;
};

export function isOtherPaidSlug(slug: string): boolean {
  const last = slug.split(".").pop() ?? slug;
  return /_ads$/.test(last) && last !== "meta_ads" && last !== "google_ads";
}

const PAGE = 1000;
const MAX_LEDGER_ROWS = 20_000;

async function realLedgerSeen(tenant_id: string, since: string, until: string): Promise<LedgerSeen[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const perObjectDay = new Map<string, { platform: string; day: string; usd: number }>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("ad_spend_daily")
      .select("platform, account_id, object_id, spend_date, amount_usd")
      .not("platform", "in", "(meta,google)")
      .gte("spend_date", since)
      .lte("spend_date", until)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`ad ledger read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ platform: string; account_id: string; object_id: string; spend_date: string; amount_usd: unknown }>;
    for (const r of rows) {
      const day = String(r.spend_date).slice(0, 10);
      const key = `${r.platform}:${r.account_id}:${r.object_id}:${day}`;
      const usd = Math.max(0, Number(r.amount_usd) || 0);
      const prev = perObjectDay.get(key);
      if (!prev || usd > prev.usd) perObjectDay.set(key, { platform: r.platform, day, usd });
    }
    if (rows.length < PAGE) break;
    if (from + PAGE >= MAX_LEDGER_ROWS) throw new Error("ad ledger read is too large");
  }
  const by = new Map<string, LedgerSeen>();
  for (const v of perObjectDay.values()) {
    if (v.usd <= 0) continue;
    const cur = by.get(v.platform) ?? { platform: v.platform, usd: 0, first_day: v.day, last_day: v.day };
    cur.usd = Math.round((cur.usd + v.usd) * 100) / 100;
    if (v.day < cur.first_day) cur.first_day = v.day;
    if (v.day > cur.last_day) cur.last_day = v.day;
    by.set(v.platform, cur);
  }
  return [...by.values()].sort((a, b) => b.usd - a.usd);
}

async function realConnectedSlugs(tenant_id: string): Promise<string[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("connector_metadata").select("slug");
  if (error) throw new Error(`connector list read failed: ${error.message}`);
  return ((data ?? []) as Array<{ slug?: unknown }>).map((r) => String(r.slug ?? "")).filter(Boolean);
}

export const realOutcomeDeps: OutcomeDeps = {
  getOutcomeMap: (t) => getOutcomeMap(t),
  async catalogColumns(tenant_id, table) {
    const cat = await getCatalog(tenant_id);
    return cat?.catalog.tables.find((t) => t.name === table)?.columns ?? null;
  },
  spend: (ctx, w) => fetchAdSpendTotal(ctx, w),
  connectedSlugs: realConnectedSlugs,
  ledgerSeen: realLedgerSeen,
  withSession: (ctx, fn) => withReadSession(ctx.gateway, fn),
  readRollup: readOutcomeRollup,
  async requestRefresh(tenant_id) {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ name: "outcome-rollup.refresh.requested", data: { tenant_id } });
  },
};

const unsupported = (message: string): FetchResult => ({ ok: false, reason: "unsupported_definition", message });

export function sharedAccountZone(spend: FetchOk): string | null {
  const platforms = (spend.params.platforms as Array<{ account_timezone?: unknown }> | undefined) ?? [];
  const zones = platforms.map((p) => (typeof p.account_timezone === "string" && p.account_timezone ? p.account_timezone : null));
  if (zones.length === 0 || zones.some((z) => z === null)) return null;
  return new Set(zones).size === 1 ? zones[0] : null;
}

export async function fetchOutcomeMetric(
  ctx: MetricFetchCtx,
  w: ResolvedWindow,
  kind: OutcomeKind,
  deps: OutcomeDeps = realOutcomeDeps,
): Promise<FetchResult> {
  if (ctx.breakdown) {
    return unsupported(
      `A per-${ctx.breakdown} split needs an attribution mapping (which orders each channel or campaign brought in), and none is set up. The blended number for all channels together is available without a breakdown.`,
    );
  }

  let mapRes;
  try {
    mapRes = await deps.getOutcomeMap(ctx.tenant_id);
  } catch (e) {
    return { ok: false, reason: "read_failed", message: `The confirmed order map could not be read: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  if (!mapRes.ok) return unsupported(mapRes.message);
  const map = mapRes.map;
  if (map.engine !== "mongodb" && map.engine !== "postgres") {
    return { ok: false, reason: "unsupported", message: new UnsupportedEngineError(map.engine).message };
  }
  if (kind === "roas") {
    const missing: string[] = [];
    if (!map.revenue_field) missing.push("revenue_field");
    if (!map.currency) missing.push("currency");
    if (missing.length) return unsupported(`Not confirmed in the booking mapping: ${missing.map(describeMissing).join("; ")}.`);
    if (map.refund_basis === "refund_event_day") {
      return unsupported("The booking mapping dates refunds by the day of the refund, and Zavi cannot read refund days yet, so net revenue is not computed.");
    }
  }
  let columns;
  try {
    columns = await deps.catalogColumns(ctx.tenant_id, map.booking_source);
  } catch (e) {
    return { ok: false, reason: "read_failed", message: `The database catalog could not be read: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  if (!columns) {
    return unsupported(`The confirmed orders table "${map.booking_source}" is not in the current database catalog. Re-run discovery, then confirm the order map again.`);
  }
  const fields = [map.date_field, map.status_field, map.completed_at_field, map.customer_ref_field];
  if (kind === "roas") fields.push(map.revenue_field!, ...(map.refund_field && map.refund_basis === "booking_created_net" ? [map.refund_field] : []));
  const gone = fieldsMissingFromCatalog(map, columns, fields);
  if (gone.length) {
    return unsupported(`These confirmed fields are no longer in the current catalog of "${map.booking_source}": ${gone.join(", ")}. Confirm the order map again.`);
  }
  const zoneless = pgZonelessTimeFields(map, columns, [map.completed_at_field, map.date_field]);
  if (zoneless.length) {
    return unsupported(
      `These time fields store no time zone (${zoneless.join(", ")}), so which day an order finished on cannot be told exactly. A timestamp-with-time-zone field is needed.`,
    );
  }

  const spend = await deps.spend({ ...ctx, breakdown: undefined }, w);
  if (!spend.ok) return { ok: false, reason: spend.reason, message: `Ad spend: ${spend.message}` };
  if (kind === "roas" && spend.currency && spend.currency !== map.currency) {
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `Order revenue is in ${map.currency} and ad spend is in ${spend.currency}. No FX conversion is done, so no ROAS is given.`,
    };
  }

  let otherConnected: string[] = [];
  let ledger: LedgerSeen[] = [];
  const coverageNotes: string[] = [];
  try {
    otherConnected = (await deps.connectedSlugs(ctx.tenant_id)).filter(isOtherPaidSlug);
  } catch {
    coverageNotes.push("Which other ad platforms are connected could not be checked, so spend may be only partly counted.");
  }
  try {
    ledger = await deps.ledgerSeen(ctx.tenant_id, w.since, w.until);
  } catch {
    coverageNotes.push("Zavi's ad ledger could not be read for the other ad platforms.");
  }
  const spendPartial = otherConnected.length > 0 || ledger.length > 0 || coverageNotes.length > 0;

  const zone = sharedAccountZone(spend);
  const aligned = zone === w.tz;
  const ow: OutcomeWindow = {
    since: localDayStartUtc(w.since, w.tz),
    until: localDayStartUtc(addDays(w.until, 1), w.tz),
    tz: w.tz,
  };

  let rows: Array<{ date: string; parts: Parts }>;
  const inputs: Parts = {};
  const coverage: Record<string, unknown> = {
    spend_counted: "Meta + Google Ads (live)",
    other_ad_platforms_connected: otherConnected,
    ledger_spend_not_counted: ledger,
    days_in_zone: w.tz,
    ad_account_zone: zone,
  };
  const assumptions: string[] = [];
  try {
    let rollup: OutcomeRollup | null = null;
    try {
      const stored = await deps.readRollup(ctx.tenant_id);
      if (usableRollup(stored, map, w.tz, w.until, stored?.source_watermark ?? "", ctx.now)) {
        const live = await deps.withSession(ctx, (s) => readSourceWatermark(s, map));
        rollup = usableRollup(stored, map, w.tz, w.until, live, ctx.now);
        if (!rollup) coverage.rollup_skipped = "orders changed since it was computed";
      }
    } catch {
      rollup = null;
    }
    let unplacedDays: UnplacedDay[];
    let firstDays: Array<{ date: string; customers: number }> = [];
    let floor: string | null = null;
    if (rollup) {
      coverage.computed = `precomputed through ${rollup.through_day} (refreshed ${rollup.refreshed_at.slice(0, 16)}Z)`;
      assumptions.push(
        `New-customer counts are as of ${rollup.refreshed_at.slice(0, 16)}Z; an order moved to another customer since then shows within 6 hours.`,
      );
      unplacedDays = rollup.days.map((d) => ({ d: d.d, u_cac: d.u_cac, u_roas: d.u_roas, pos: d.pos, neg: d.neg, unr: d.unr }));
      firstDays = rollup.days.filter((d) => d.d >= w.since && d.d <= w.until && d.first > 0).map((d) => ({ date: d.d, customers: d.first }));
      floor = rollup.first_seen_floor;
    } else {
      coverage.computed = "live";
      deps.requestRefresh(ctx.tenant_id).catch(() => undefined);
      const live = await deps.withSession(ctx, async (s) => ({
        unplaced: await readUnplacedByDay(s, map, w.tz),
        first: kind === "cac" ? await readFirstCompletions(s, map, ow) : null,
      }));
      unplacedDays = live.unplaced;
      if (live.first) {
        firstDays = live.first.days;
        floor = live.first.first_seen_floor;
      }
    }
    const u = unplacedThrough(unplacedDays, w.until);
    if (kind === "cac") {
      rows = firstDays.map((d) => ({ date: d.date, parts: { customers: d.customers } }));
      inputs.unplaced = u.u_cac;
      coverage.first_seen_floor = floor;
      coverage.unplaced_finished_orders = u.u_cac;
      if (u.u_cac > 0) {
        assumptions.push(
          `${u.u_cac} finished orders created on or before ${w.until} have no usable finish date or customer. Assuming an order finishes after it is created, each can add or remove at most one new customer in any period; the bounds allow for that.`,
        );
      }
    } else {
      const rv = await deps.withSession(ctx, (s) => readCompletedRevenue(s, map, ow));
      rows = rv.days.map((d) => ({ date: d.date, parts: { gross: d.gross, refund: d.refund, orders: d.orders, unreadable: d.unreadable } }));
      inputs.unplaced_pos = u.pos;
      inputs.unplaced_neg = u.neg;
      inputs.unplaced_unreadable = u.unr;
      coverage.unplaced_finished_orders = u.u_roas;
      const unreadable = rv.days.reduce((n, d) => n + d.unreadable, 0) + u.unr;
      coverage.orders_with_unreadable_revenue = unreadable;
      if (u.u_roas > 0) {
        assumptions.push(
          `${u.u_roas} finished orders created on or before ${w.until} have no usable finish date; each could add its own net revenue to one period. The bounds allow for that.`,
        );
      }
      if (unreadable > 0) assumptions.push(`${unreadable} finished orders have a revenue value that is missing or not a number; no bound is given where they count.`);
    }
  } catch (e) {
    const code = e instanceof ExpectedToolError ? e.code : null;
    return {
      ok: false,
      reason: "read_failed",
      message: `The order database read failed${code ? ` (${code})` : ""}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    };
  }

  for (const d of spend.daily ?? []) rows.push({ date: d.date, parts: { spend: d.parts.spend ?? 0 } });
  if (spendPartial) {
    inputs.spend_partial = 1;
    const names = [...new Set([...otherConnected, ...ledger.map((l) => l.platform)])];
    assumptions.push(
      `Only Meta + Google Ads spend is counted${names.length ? `; ${names.join(", ")} spend is not` : ""}. Real spend is at least the counted spend, so only the bound that holds for higher spend is given.`,
      ...coverageNotes,
    );
  }
  if (!aligned) {
    inputs.misaligned = 1;
    assumptions.push(
      zone
        ? `The ad accounts report days in ${zone}, the reporting time zone is ${w.tz}: ad days and order days cover different hours, so no value or bound is given. Setting the reporting time zone to ${zone} (Settings) fixes it.`
        : "The ad accounts did not report one shared time zone, so ad days and order days cannot be lined up. No value or bound is given.",
    );
  }
  const exact =
    !spendPartial && aligned && Number(coverage.unplaced_finished_orders ?? 0) === 0 && Number(coverage.orders_with_unreadable_revenue ?? 0) === 0;
  const estimate: Estimate = { exact, assumptions, inputs, coverage };

  const caveats = [...spend.caveats];
  caveats.push(`Order map confirmed on ${map.outcome_confirmed_at.slice(0, 10)} (finished statuses: ${map.terminal_statuses.join(", ")}).`);
  if (kind === "cac" && coverage.first_seen_floor) {
    caveats.push(`New customers are first seen in your connected data, which starts ${String(coverage.first_seen_floor).slice(0, 10)}.`);
  }
  if (kind === "roas") {
    caveats.push(
      map.refund_field && map.refund_basis === "booking_created_net"
        ? `Net revenue = ${map.revenue_field} minus ${map.refund_field}, per order.`
        : `Revenue is ${map.revenue_field}, not net of refunds (the booking mapping has no refund adjustment).`,
    );
  }

  return {
    ok: true,
    daily: sumByDate(rows),
    currency: kind === "cac" ? spend.currency : null,
    row_count: rows.length,
    truncated: false,
    caveats,
    params: {
      spend: spend.params,
      orders: {
        source: "operator_db",
        table: map.booking_source,
        finished_statuses: map.terminal_statuses,
        finish_field: map.completed_at_field,
        customer_field: map.customer_ref_field,
        ...(kind === "roas" ? { revenue_field: map.revenue_field, refund_field: map.refund_field, amount_unit: map.amount_unit } : {}),
      },
    },
    estimate,
  };
}

export function cacBounds(p: Parts, win: Parts): Bounds {
  if (win.misaligned) return { low: null, high: null };
  const S = p.spend ?? 0;
  const C = p.customers ?? 0;
  const U = win.unplaced ?? 0;
  const low = div(S, C + U);
  const high = win.spend_partial ? null : C - U > 0 ? div(S, C - U) : null;
  return { low, high };
}

export function roasBounds(p: Parts, win: Parts): Bounds {
  if (win.misaligned) return { low: null, high: null };
  const S = p.spend ?? 0;
  const R = (p.gross ?? 0) - (p.refund ?? 0);
  const unreadable = (p.unreadable ?? 0) > 0 || (win.unplaced_unreadable ?? 0) > 0;
  if (unreadable) {
    return { low: null, high: null };
  }
  const lowN = R + (win.unplaced_neg ?? 0);
  const highN = R + (win.unplaced_pos ?? 0);
  const low = div(lowN, S);
  const high = div(highN, S);
  if (!win.spend_partial || low === null || high === null) return { low, high };
  return { low: Math.min(0, low), high: Math.max(0, high) };
}

export const outcomeMetrics: Record<string, MetricImpl> = {
  first_completed_cac: {
    value: (p) => div(p.spend, p.customers),
    bounds: cacBounds,
    fetch: (ctx, w) => fetchOutcomeMetric(ctx, w, "cac"),
  },
  completed_net_roas: {
    value: (p) => ((p.unreadable ?? 0) > 0 ? null : div((p.gross ?? 0) - (p.refund ?? 0), p.spend)),
    bounds: roasBounds,
    fetch: (ctx, w) => fetchOutcomeMetric(ctx, w, "roas"),
  },
};

export type { OutcomeMap };
