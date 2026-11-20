
import { readNativeFunnel } from "@/services/tools/growth/native_funnel";
import { readTenantStripeMrr } from "@/services/analytics/stripe-mrr";
import { readTenantStripeGrossRevenue } from "@/services/analytics/stripe-gross-revenue";
import {
  queryFunnelByGeoCategoryTool,
  queryNewUsersTool,
} from "@/services/tools/operator-db/aggregates";
import { ExpectedToolError } from "@/services/tools/types";
import type {
  FunnelWeekRow,
  NewUsersInWindowResult,
} from "@/services/tools/operator-db/types";
import { classifyTargetMetric } from "./goal-metric-vocab";

export { classifyTargetMetric, type MetricSource } from "./goal-metric-vocab";

export type MeasureOutcome =
  | {
      measured: true;
      value: number;
      source:
        | "native_funnel"
        | "operator_funnel"
        | "operator_db_signups"
        | "stripe_mrr"
        | "stripe_gross_revenue"
        | "booking_value";
      unit: "count" | "usd";
      basis?: "mrr" | "arr";
    }
  | {
      measured: false;
      reason: string;
      candidates?: MoneyCandidate[];
    };

export type MoneyCandidate = {
  source: "booking_value" | "stripe_gross_revenue";
  label: string;
  definition: string;
  value_30d_usd: number;
};

export const MONEY_CANDIDATE_TEXT: Record<MoneyCandidate["source"] | "booking_value_gross", { label: string; definition: string }> = {
  booking_value: {
    label: "Bookings database",
    definition: "Booking value from your bookings database, net of refunds",
  },
  booking_value_gross: {
    label: "Bookings database",
    definition: "Booking value from your bookings database, before refunds",
  },
  stripe_gross_revenue: {
    label: "Stripe",
    definition: "Gross charges in Stripe, incl. deposits and fees",
  },
};

export type MeasureDeps = {
  readNativeStep: (
    tenant_id: string,
    step: string,
    windowDays: number,
  ) => Promise<number | null>;
  readOperatorFunnelBookings: (
    tenant_id: string,
    lookbackWeeks: number,
  ) => Promise<number | null>;
  readOperatorNewUsers: (
    tenant_id: string,
    windowDays: number,
  ) => Promise<number | null>;
  readStripeMrr: (tenant_id: string) => Promise<number | null>;
  readStripeGrossRevenue?: (tenant_id: string) => Promise<number | null>;
  readBookingValue30d?: (tenant_id: string) => Promise<{ usd: number; net_of_refunds: boolean } | "unknown" | null>;
  readStripeGrossState?: (tenant_id: string) => Promise<number | "unknown" | null>;
};

export const realMeasureDeps: MeasureDeps = {
  async readBookingValue30d(tenant_id) {
    try {
      const { readBookingValue30d } = await import("./booking-value");
      const r = await readBookingValue30d(tenant_id);
      if (r.available) return { usd: r.usd, net_of_refunds: r.net_of_refunds };
      return r.reason === "no_confirmed_mapping" || r.reason === "no_revenue_field" || r.reason === "non_usd" || r.reason === "refunds_not_modelled"
        ? null
        : "unknown";
    } catch {
      return "unknown";
    }
  },
  async readStripeGrossState(tenant_id) {
    try {
      const res = await readTenantStripeGrossRevenue(tenant_id);
      if (res.available) {
        const v = Number(res.gross_usd);
        return Number.isFinite(v) ? v : "unknown";
      }
      return res.reason === "not_connected" || res.reason === "non_usd_currency" ? null : "unknown";
    } catch {
      return "unknown";
    }
  },
  async readNativeStep(tenant_id, step, windowDays) {
    const funnel = await readNativeFunnel(tenant_id, [step], windowDays);
    if (!funnel.has_data) return null;
    const row = funnel.steps.find((s) => s.event === step);
    return row ? row.count : null;
  },
  async readOperatorFunnelBookings(tenant_id, lookbackWeeks) {
    try {
      const res = (await queryFunnelByGeoCategoryTool.execute(
        { tenant_id, log: () => {} },
        { lookback_weeks: lookbackWeeks, top_n: 200 },
      )) as {
        ok?: boolean;
        data?: { rows?: FunnelWeekRow[]; truncated?: boolean };
      };
      const rows = res?.data?.rows;
      if (!res?.ok || !Array.isArray(rows)) return null;
      if (res.data?.truncated) return null;
      return rows.reduce((sum, r) => sum + (Number(r.book_n) || 0), 0);
    } catch (e) {
      if (e instanceof ExpectedToolError) return null;
      throw e;
    }
  },
  async readOperatorNewUsers(tenant_id, windowDays) {
    try {
      const res = (await queryNewUsersTool.execute(
        { tenant_id, log: () => {} },
        { window_days: windowDays },
      )) as { ok?: boolean; data?: NewUsersInWindowResult };
      const data = res?.data;
      if (!res?.ok || !data?.available) return null;
      const count = Number(data.count);
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  },
  async readStripeGrossRevenue(tenant_id) {
    try {
      const res = await readTenantStripeGrossRevenue(tenant_id);
      if (!res.available) return null;
      const v = Number(res.gross_usd);
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  },
  async readStripeMrr(tenant_id) {
    try {
      const res = await readTenantStripeMrr(tenant_id);
      if (!res.available || res.mrr_usd == null) return null;
      const mrr = Number(res.mrr_usd);
      return Number.isFinite(mrr) ? mrr : null;
    } catch {
      return null;
    }
  },
};

export const SIGNUP_DB_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeWindowDays(goal_created_at: string | null, now: Date): number {
  const start = goal_created_at ? Date.parse(goal_created_at) : NaN;
  if (!Number.isFinite(start)) return 30;
  const days = Math.ceil((now.getTime() - start) / MS_PER_DAY);
  return Math.min(Math.max(days, 1), 90);
}

export async function measureGoalMetric(args: {
  tenant_id: string;
  target_metric: string;
  goal_created_at: string | null;
  now?: Date;
  deps?: MeasureDeps;
  measure_source?: string | null;
}): Promise<MeasureOutcome> {
  const deps = args.deps ?? realMeasureDeps;
  const now = args.now ?? new Date();
  const source = classifyTargetMetric(args.target_metric);
  if (source.kind === "unresolved") {
    return { measured: false, reason: "unresolved_metric" };
  }
  if (source.kind === "booking_value") return measureMoneyGoal(args.tenant_id, deps, args.measure_source ?? null);
  if (source.kind === "stripe_gross_revenue") {
    const v = deps.readStripeGrossRevenue ? await deps.readStripeGrossRevenue(args.tenant_id) : null;
    if (v == null) return { measured: false, reason: "stripe_gross_revenue_unavailable" };
    return { measured: true, value: v, source: "stripe_gross_revenue", unit: "usd" };
  }
  if (source.kind === "stripe_mrr") {
    const mrr = await deps.readStripeMrr(args.tenant_id);
    if (mrr == null) return { measured: false, reason: "stripe_mrr_unavailable" };
    const value = source.basis === "arr" ? mrr * 12 : mrr;
    return { measured: true, value, source: "stripe_mrr", unit: "usd", basis: source.basis };
  }

  const windowDays = computeWindowDays(args.goal_created_at, now);
  if (source.kind === "native_funnel") {
    if (source.step === "signup") {
      const dbValue = await deps.readOperatorNewUsers(
        args.tenant_id,
        SIGNUP_DB_WINDOW_DAYS,
      );
      if (dbValue != null) {
        return { measured: true, value: dbValue, source: "operator_db_signups", unit: "count" };
      }
      const nativeValue = await deps.readNativeStep(
        args.tenant_id,
        source.step,
        SIGNUP_DB_WINDOW_DAYS,
      );
      if (nativeValue == null) return { measured: false, reason: "signup_no_source" };
      return { measured: true, value: nativeValue, source: "native_funnel", unit: "count" };
    }
    const value = await deps.readNativeStep(args.tenant_id, source.step, windowDays);
    if (value == null) return { measured: false, reason: "native_funnel_no_data" };
    return { measured: true, value, source: "native_funnel", unit: "count" };
  }
  const lookbackWeeks = Math.min(Math.max(Math.ceil(windowDays / 7), 1), 52);
  const value = await deps.readOperatorFunnelBookings(args.tenant_id, lookbackWeeks);
  if (value == null) return { measured: false, reason: "operator_funnel_unavailable" };
  return { measured: true, value, source: "operator_funnel", unit: "count" };
}

async function measureMoneyGoal(tenant_id: string, deps: MeasureDeps, pick: string | null): Promise<MeasureOutcome> {
  const readBv = () => (deps.readBookingValue30d ? deps.readBookingValue30d(tenant_id) : Promise.resolve(null));
  const readStripe = (): Promise<number | "unknown" | null> =>
    deps.readStripeGrossState
      ? deps.readStripeGrossState(tenant_id)
      : deps.readStripeGrossRevenue
        ? deps.readStripeGrossRevenue(tenant_id)
        : Promise.resolve(null);
  if (pick === "booking_value") {
    const v = await readBv();
    return v == null || v === "unknown" ? { measured: false, reason: "booking_value_unavailable" } : { measured: true, value: v.usd, source: "booking_value", unit: "usd" };
  }
  if (pick === "stripe_gross_revenue") {
    const v = await readStripe();
    return v == null || v === "unknown" ? { measured: false, reason: "stripe_gross_revenue_unavailable" } : { measured: true, value: v, source: "stripe_gross_revenue", unit: "usd" };
  }
  const [bv, stripe] = await Promise.all([readBv(), readStripe()]);
  if (bv === "unknown" || stripe === "unknown") return { measured: false, reason: "money_source_unknown" };
  if (bv != null && stripe != null) {
    return {
      measured: false,
      reason: "pick_money_source",
      candidates: [
        { source: "booking_value", ...MONEY_CANDIDATE_TEXT[bv.net_of_refunds ? "booking_value" : "booking_value_gross"], value_30d_usd: bv.usd },
        { source: "stripe_gross_revenue", ...MONEY_CANDIDATE_TEXT.stripe_gross_revenue, value_30d_usd: stripe },
      ],
    };
  }
  if (bv != null) return { measured: true, value: bv.usd, source: "booking_value", unit: "usd" };
  if (stripe != null) return { measured: true, value: stripe, source: "stripe_gross_revenue", unit: "usd" };
  return { measured: false, reason: "money_source_unavailable" };
}

export function isGoalOffTrack(args: {
  measured_value: number;
  target_value: number;
  baseline_value: number | null;
  goal_created_at: string | null;
  due_date: string | null;
  now?: Date;
}): boolean {
  const { measured_value, target_value, baseline_value } = args;
  if (measured_value >= target_value) return false;

  if (baseline_value != null && args.due_date && args.goal_created_at) {
    const start = Date.parse(args.goal_created_at);
    const end = Date.parse(args.due_date);
    const now = (args.now ?? new Date()).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const elapsed = Math.min(Math.max((now - start) / (end - start), 0), 1);
      const expectedProgress = (target_value - baseline_value) * elapsed;
      if (expectedProgress <= 0) return false;
      const actualProgress = measured_value - baseline_value;
      return actualProgress < 0.5 * expectedProgress;
    }
  }

  return measured_value < 0.5 * target_value;
}
