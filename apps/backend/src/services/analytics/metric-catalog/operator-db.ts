
import {
  resolveConfirmedOperatorDb,
  type ConfirmedDbDeps,
  type OperatorRole,
} from "@/services/analytics/confirmed-operator-db";
import { bucketsFor, localDayStartUtc, addDays, type LocalDate, type ResolvedWindow } from "@/services/analytics/metric-time";
import type { FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

export const MAX_DB_BUCKETS = 120;

export async function fetchOperatorCount(
  ctx: MetricFetchCtx,
  w: ResolvedWindow,
  role: OperatorRole,
  deps?: ConfirmedDbDeps,
): Promise<FetchResult> {
  const db = await resolveConfirmedOperatorDb(ctx.gateway, role, deps);
  if (!db.ok) return { ok: false, reason: db.reason, message: db.message };
  try {
    return await countBuckets(ctx, w, role, db);
  } finally {
    await db.close();
  }
}

async function countBuckets(
  ctx: MetricFetchCtx,
  w: ResolvedWindow,
  role: OperatorRole,
  db: Extract<Awaited<ReturnType<typeof resolveConfirmedOperatorDb>>, { ok: true }>,
): Promise<FetchResult> {

  const fn =
    role === "users" ? db.driver.query_new_users_in_range?.bind(db.driver) : db.driver.query_new_bookings_in_range?.bind(db.driver);
  if (typeof fn !== "function") {
    return {
      ok: false,
      reason: "unsupported",
      message: "This database type cannot count rows over a date range yet (MySQL and DynamoDB are not supported).",
    };
  }

  const buckets = bucketsFor(w, ctx.grain);
  if (buckets.length > MAX_DB_BUCKETS) {
    return {
      ok: false,
      reason: "unsupported",
      message: `That is ${buckets.length} ${ctx.grain} buckets; the limit is ${MAX_DB_BUCKETS}. Use a coarser grain.`,
    };
  }

  const out: Array<{ start: LocalDate; parts: Parts }> = [];
  let total = 0;
  for (const b of buckets) {
    const from = b.start < w.since ? w.since : b.start;
    const to = b.end > w.until ? w.until : b.end;
    const since = localDayStartUtc(from, w.tz).toISOString();
    const until = localDayStartUtc(addDays(to, 1), w.tz).toISOString();
    let res: Awaited<ReturnType<typeof fn>>;
    try {
      res = await fn({ since, until }, db.cfg);
    } catch (e) {
      return { ok: false, reason: "read_failed", message: `The database count failed: ${((e as Error)?.message ?? String(e)).slice(0, 160)}` };
    }
    if (!res?.ok || !res.data?.available || !Number.isFinite(Number(res.data.count))) {
      return {
        ok: false,
        reason: "read_failed",
        message: `The confirmed ${role} table or its created-at field could not be counted. Re-check the confirmed mapping; no number is given rather than a false zero.`,
      };
    }
    const n = Number(res.data.count);
    total += n;
    out.push({ start: b.start, parts: { count: n } });
  }

  return {
    ok: true,
    buckets: out,
    total_parts: { count: total },
    currency: null,
    row_count: total,
    truncated: false,
    caveats: [`Mapping confirmed by the founder on ${db.confirmed_at.slice(0, 10)}.`],
    params: {
      source: "operator_db",
      table: db.table,
      created_at_field: db.created_at_field ?? "(driver default)",
      queries: out.length,
    },
  };
}

export const operatorDbMetrics: Record<string, MetricImpl> = {
  signups: { value: (p) => p.count ?? 0, fetch: (ctx, w) => fetchOperatorCount(ctx, w, "users") },
  bookings: { value: (p) => p.count ?? 0, fetch: (ctx, w) => fetchOperatorCount(ctx, w, "bookings") },
};
