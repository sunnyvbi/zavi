
import type Stripe from "stripe";
import { stripeClient } from "@/services/tools/stripe/_client";
import { readTenantStripeMrr } from "@/services/analytics/stripe-mrr";
import { localDateOf, windowUtcRange, type ResolvedWindow } from "@/services/analytics/metric-time";
import { failFrom, fromMinor, sumByDate } from "./shared";
import type { FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

const PAGE_LIMIT = 100;
export const STRIPE_MAX_PAGES = 50;

const REVENUE_CATEGORIES = new Set([
  "charge",
  "refund",
  "refund_failure",
  "dispute",
  "dispute_reversal",
  "partial_capture_reversal",
]);

async function listAll<T extends { id: string }>(
  page: (starting_after?: string) => Promise<{ data: T[]; has_more: boolean }>,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < STRIPE_MAX_PAGES; i++) {
    const res = await page(after);
    rows.push(...res.data);
    if (!res.has_more) return { rows, complete: true };
    after = res.data[res.data.length - 1]?.id;
    if (!after) return { rows, complete: false };
  }
  return { rows, complete: false };
}

function created(w: ResolvedWindow): { gte: number; lt: number } {
  const r = windowUtcRange(w);
  return { gte: Math.floor(r.since.getTime() / 1000), lt: Math.floor(r.until.getTime() / 1000) };
}

async function fetchBalance(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  let stripe: Stripe;
  try {
    stripe = await stripeClient(ctx.tenant_id);
  } catch (e) {
    return failFrom(e, "Stripe");
  }
  const range = created(w);
  let listed: { rows: Stripe.BalanceTransaction[]; complete: boolean };
  try {
    listed = await listAll((starting_after) =>
      stripe.balanceTransactions.list({
        created: range,
        limit: PAGE_LIMIT,
        ...(starting_after ? { starting_after } : {}),
      }),
    );
  } catch (e) {
    return failFrom(e, "Stripe");
  }
  if (!listed.complete) {
    return {
      ok: false,
      reason: "too_many_rows",
      message: `More than ${STRIPE_MAX_PAGES * PAGE_LIMIT} Stripe balance transactions in this window. Pick a shorter window; a partial sum would understate revenue.`,
    };
  }

  let currency: string | null = null;
  const rows: Array<{ date: string; parts: Parts }> = [];
  for (const t of listed.rows) {
    const cat = String(t.reporting_category ?? "");
    if (!REVENUE_CATEGORIES.has(cat)) continue;
    const cur = String(t.currency ?? "").toUpperCase();
    if (!cur) return { ok: false, reason: "read_failed", message: "A Stripe balance transaction had no currency." };
    if (currency === null) currency = cur;
    else if (currency !== cur) {
      return {
        ok: false,
        reason: "currency_mismatch",
        message: `Stripe balance holds more than one currency (${currency}, ${cur}). No FX conversion is done, so no single revenue figure is given.`,
      };
    }
    const amount = fromMinor(Number(t.amount ?? 0), cur);
    const net = fromMinor(Number(t.net ?? 0), cur);
    rows.push({
      date: localDateOf(new Date(Number(t.created) * 1000), w.tz),
      parts: {
        gross: cat === "charge" ? amount : 0,
        refunds: cat === "refund" || cat === "refund_failure" ? -amount : 0,
        net,
      },
    });
  }
  return {
    ok: true,
    daily: sumByDate(rows),
    currency,
    row_count: listed.rows.length,
    truncated: false,
    caveats: [],
    params: { source: "stripe.balance_transactions", created_gte: range.gte, created_lt: range.lt },
  };
}

async function fetchNewCustomers(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  let stripe: Stripe;
  try {
    stripe = await stripeClient(ctx.tenant_id);
  } catch (e) {
    return failFrom(e, "Stripe");
  }
  const range = created(w);
  let listed: { rows: Stripe.Customer[]; complete: boolean };
  try {
    listed = await listAll((starting_after) =>
      stripe.customers.list({ created: range, limit: PAGE_LIMIT, ...(starting_after ? { starting_after } : {}) }),
    );
  } catch (e) {
    return failFrom(e, "Stripe");
  }
  if (!listed.complete) {
    return {
      ok: false,
      reason: "too_many_rows",
      message: `More than ${STRIPE_MAX_PAGES * PAGE_LIMIT} new Stripe customers in this window. Pick a shorter window.`,
    };
  }
  return {
    ok: true,
    daily: sumByDate(
      listed.rows.map((c) => ({ date: localDateOf(new Date(Number(c.created) * 1000), w.tz), parts: { customers: 1 } })),
    ),
    currency: null,
    row_count: listed.rows.length,
    truncated: false,
    caveats: [],
    params: { source: "stripe.customers", created_gte: range.gte, created_lt: range.lt },
  };
}

function mrrValue(res: Record<string, unknown>): number | null {
  for (const k of ["mrr", "mrr_usd", "mrr_amount"]) {
    const v = res[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

async function fetchMrr(ctx: MetricFetchCtx): Promise<FetchResult> {
  const res = (await readTenantStripeMrr(ctx.tenant_id)) as unknown as Record<string, unknown>;
  if (res.available !== true) {
    const reason = String(res.reason ?? "read_failed");
    if (reason === "not_connected") return { ok: false, reason: "not_connected", message: "Stripe is not connected." };
    if (reason === "multi_currency") {
      return { ok: false, reason: "currency_mismatch", message: "Active subscriptions are billed in more than one currency, so no single MRR is given." };
    }
    return { ok: false, reason: "read_failed", message: `Stripe MRR read failed (${reason}).` };
  }
  const v = mrrValue(res);
  if (v == null) return { ok: false, reason: "read_failed", message: "Stripe MRR read returned no value." };
  const meta = (res.meta ?? {}) as { sub_count?: number; currency?: string };
  const today = localDateOf(ctx.now, ctx.tz);
  return {
    ok: true,
    buckets: [{ start: today, parts: { mrr: v } }],
    total_parts: { mrr: v },
    currency: meta.currency ? String(meta.currency).toUpperCase() : null,
    row_count: Number(meta.sub_count ?? 0),
    truncated: false,
    caveats: [],
    params: { source: "stripe.subscriptions", status: "active" },
  };
}

export const stripeMetrics: Record<string, MetricImpl> = {
  net_revenue: { value: (p) => p.net ?? 0, fetch: fetchBalance },
  gross_revenue: { value: (p) => p.gross ?? 0, fetch: fetchBalance },
  refunds: { value: (p) => p.refunds ?? 0, fetch: fetchBalance },
  new_customers: { value: (p) => p.customers ?? 0, fetch: fetchNewCustomers },
  mrr: { value: (p) => (p.mrr == null ? null : p.mrr), fetch: (ctx) => fetchMrr(ctx) },
};
