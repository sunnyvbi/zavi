
import { serviceClient } from "@/services/supabase";
import { capCountedChangeUsd, type Cap } from "./_cap-evaluator";
import { getAdAccountCurrency } from "../_client";
import { assertWritableCurrency, capInAccountUnits, normalizeCurrency } from "./_currency";
import { unitsPerUsd } from "./_fx-rate";
import { DAILY_AGGREGATE_UNREADABLE } from "./_simulate";

export const BUDGET_DECISION_CLASSES = [
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget",
  "meta_ads.update_campaign_budget_review",
  "meta_ads.create_campaign",
  "meta_ads.create_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.duplicate_ad_set",
  "meta_ads.launch_campaign",
];

export const RESUME_CLASSES = ["meta_ads.set_status", "meta_ads.set_status_review"];

const COUNTED_CLASSES = [...BUDGET_DECISION_CLASSES, ...RESUME_CLASSES];

export const COUNTED_EXEC_STATUSES = ["executed", "dispatching", "failed"] as const;

export function isFailedAttempt(status: string | null | undefined): boolean {
  return status === "failed" || status === "dispatch_failed";
}

export const EXECUTED_DECISION_STATUSES = ["dispatching", "acted"] as const;

export const READ_DECISION_STATUSES = [...EXECUTED_DECISION_STATUSES, "dispatch_failed"] as const;

type BudgetDecisionBody = {
  ad_set_id?: string;
  campaign_id?: string;
  currency?: string;
  daily_budget_usd?: number;
  expected_current_daily_budget_usd?: number;
  campaign?: { daily_budget_usd?: number };
  object_id?: string;
  status?: string;
};

type CapCounted = { daily?: unknown; currency?: unknown } | null | undefined;

export function countedBody(execClass: string, body: BudgetDecisionBody | null | undefined, capCounted: CapCounted, failed = false): BudgetDecisionBody | null | "unknown" {
  if (!RESUME_CLASSES.includes(execClass)) return failed ? null : body ?? null;
  if (body?.status !== "ACTIVE") return null;
  if (failed && !capCounted) return null;
  const daily = capCounted?.daily;
  if (!capCounted || typeof daily !== "number" || !Number.isFinite(daily) || daily < 0) return "unknown";
  return {
    ad_set_id: body.object_id,
    daily_budget_usd: daily,
    expected_current_daily_budget_usd: 0,
    currency: typeof capCounted.currency === "string" ? capCounted.currency : undefined,
  };
}

function bodyDailyBudget(body: BudgetDecisionBody | null | undefined): number | undefined {
  return body?.daily_budget_usd ?? body?.campaign?.daily_budget_usd;
}

function budgetChangeKey(
  runId: string | null,
  execClass: string,
  body: BudgetDecisionBody | null | undefined,
): string {
  return [
    runId ?? "",
    execClass,
    body?.ad_set_id ?? body?.campaign_id ?? "",
    String(bodyDailyBudget(body) ?? ""),
    String(body?.expected_current_daily_budget_usd ?? ""),
  ].join("|");
}

function budgetChangeUsd(body: BudgetDecisionBody | null | undefined): number {
  const proposed = Number(bodyDailyBudget(body) ?? 0);
  const prior = Number(body?.expected_current_daily_budget_usd ?? 0);
  if (!Number.isFinite(proposed) || !Number.isFinite(prior)) return 0;
  return capCountedChangeUsd(proposed, prior);
}

export async function readTenantCapRowAndToday(
  tenant_id: string,
  excludeDecisionId?: string,
): Promise<RawCapRead> {
  const svc = serviceClient();

  let cap: Cap | null = null;
  let cap_row_absent = false;
  try {
    const { data, error } = await svc
      .from("tenant_ads_write_caps")
      .select(
        "enabled, max_daily_budget_usd, max_pct_change_per_run, max_daily_total_change_usd",
      )
      .eq("tenant_id", tenant_id)
      .eq("platform", "meta_ads")
      .maybeSingle();
    if (error) {
      console.warn(
        `[meta-ads cap-reader] tenant_ads_write_caps read failed for ${tenant_id}: ${error.message}`,
      );
    } else if (data) {
      cap = data as Cap;
    } else {
      cap_row_absent = true;
    }
  } catch (e) {
    console.warn(
      `[meta-ads cap-reader] tenant_ads_write_caps read threw for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  let today_total_change_usd = 0;
  const today_by_currency: Record<string, number> = {};

  let aggregateComplete = true;
  const seen = new Map<string, { body: BudgetDecisionBody | null | undefined; n: [number, number] }>();
  const credit = (
    table: 0 | 1,
    runId: string | null,
    execClass: string,
    raw: BudgetDecisionBody | null | undefined,
    capCounted: CapCounted,
    failed: boolean,
  ): void => {
    const body = countedBody(execClass, raw, capCounted, failed);
    if (body === "unknown") {
      aggregateComplete = false;
      return;
    }
    if (body === null) return;
    const key = budgetChangeKey(runId, execClass, body);
    const e = seen.get(key) ?? { body, n: [0, 0] as [number, number] };
    e.n[table] += 1;
    seen.set(key, e);
  };
  const settle = (): void => {
    for (const { body, n } of seen.values()) {
      const change = budgetChangeUsd(body) * Math.max(n[0], n[1]);
      today_total_change_usd += change;
      const c = normalizeCurrency(body?.currency);
      today_by_currency[c] = (today_by_currency[c] ?? 0) + change;
    }
  };

  try {
    const day = todayStart.toISOString();
    let q = svc
      .from("channel_actions")
      .select("run_id, exec_class, exec_payload, cap_counted, exec_status")
      .eq("tenant_id", tenant_id)
      .in("exec_class", COUNTED_CLASSES)
      .in("exec_status", COUNTED_EXEC_STATUSES)
      .or(`executed_at.gte.${day},exec_claimed_at.gte.${day}`);
    if (excludeDecisionId) q = q.neq("id", excludeDecisionId);
    const { data, error } = await q;
    if (error) {
      aggregateComplete = false;
      console.warn(
        `[meta-ads cap-reader] today aggregate read failed for ${tenant_id}: ${error.message}`,
      );
    } else {
      for (const row of (data ?? []) as Array<{
        run_id: string | null;
        exec_class: string | null;
        exec_payload: BudgetDecisionBody | null;
        cap_counted?: CapCounted;
        exec_status?: string | null;
      }>) {
        credit(0, row.run_id ?? null, row.exec_class ?? "", row.exec_payload, row.cap_counted, isFailedAttempt(row.exec_status));
      }
    }
  } catch (e) {
    aggregateComplete = false;
    console.warn(
      `[meta-ads cap-reader] today aggregate read threw for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  try {
    let q = svc
      .from("decisions")
      .select("agent_run_id, decision_class, body, cap_counted, status")
      .eq("tenant_id", tenant_id)
      .in("decision_class", COUNTED_CLASSES)
      .in("status", READ_DECISION_STATUSES)
      .gte("dispatched_at", todayStart.toISOString());
    if (excludeDecisionId) q = q.neq("id", excludeDecisionId);
    const { data, error } = await q;
    if (error) {
      aggregateComplete = false;
      console.warn(
        `[meta-ads cap-reader] today legacy aggregate read failed for ${tenant_id}: ${error.message}`,
      );
    } else {
      for (const row of (data ?? []) as Array<{
        agent_run_id: string | null;
        decision_class: string | null;
        body: BudgetDecisionBody | null;
        cap_counted?: CapCounted;
        status?: string | null;
      }>) {
        credit(1, row.agent_run_id ?? null, row.decision_class ?? "", row.body, row.cap_counted, isFailedAttempt(row.status));
      }
    }
  } catch (e) {
    aggregateComplete = false;
    console.warn(
      `[meta-ads cap-reader] today legacy aggregate read threw for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  settle();

  if (!aggregateComplete) {
    return { cap, today_total_change_usd: DAILY_AGGREGATE_UNREADABLE, today_by_currency: {}, cap_row_absent };
  }

  return { cap, today_total_change_usd, today_by_currency, cap_row_absent };
}

export type RawCapRead = {
  cap: Cap | null;
  today_total_change_usd: number;
  today_by_currency: Record<string, number>;
  cap_row_absent: boolean;
};

export async function readTenantCapAndToday(
  tenant_id: string,
  excludeDecisionId?: string,
): Promise<{
  cap: Cap | null;
  today_total_change_usd: number;
  cap_row_absent: boolean;
  currency: string;
  units_per_usd: number;
}> {
  const currency = assertWritableCurrency(await getAdAccountCurrency(tenant_id));
  const rate = await unitsPerUsd(currency);
  const raw = await readTenantCapRowAndToday(tenant_id, excludeDecisionId);

  let today = raw.today_total_change_usd;
  if (today !== DAILY_AGGREGATE_UNREADABLE) {
    today = 0;
    for (const [c, amount] of Object.entries(raw.today_by_currency)) {
      today += c === currency ? amount : (amount / (await unitsPerUsd(c))) * rate;
    }
  }
  return {
    cap: raw.cap ? capInAccountUnits(raw.cap, rate) : null,
    today_total_change_usd: today,
    cap_row_absent: raw.cap_row_absent,
    currency,
    units_per_usd: rate,
  };
}
