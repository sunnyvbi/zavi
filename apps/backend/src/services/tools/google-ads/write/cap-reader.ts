
import { serviceClient } from "@/services/supabase";
import { capCountedChangeUsd, type Cap } from "@/services/tools/meta-ads/write/_cap-evaluator";
import { DAILY_AGGREGATE_UNREADABLE } from "@/services/tools/meta-ads/write/_simulate";
import { COUNTED_EXEC_STATUSES, READ_DECISION_STATUSES, isFailedAttempt } from "@/services/tools/meta-ads/write/cap-reader";

export const BUDGET_DECISION_CLASSES = [
  "google_ads.update_campaign_budget",
  "google_ads.update_campaign_budget_review",
  "google_ads.create_campaign",
];

export const RESUME_CLASSES = ["google_ads.set_status", "google_ads.set_status_review"];

const COUNTED_CLASSES = [...BUDGET_DECISION_CLASSES, ...RESUME_CLASSES];

type BudgetDecisionBody = {
  campaign_id?: string;
  daily_budget_usd?: number;
  expected_current_daily_budget_usd?: number;
  status?: string;
  ad_group_id?: string;
  ad_id?: string;
};

type CapCounted = { daily?: unknown } | null | undefined;

export function countedBody(execClass: string, body: BudgetDecisionBody | null | undefined, capCounted: CapCounted, failed = false): BudgetDecisionBody | null | "unknown" {
  if (!RESUME_CLASSES.includes(execClass)) return failed ? null : body ?? null;
  if (body?.status !== "ENABLED") return null;
  if (failed && !capCounted) return null;
  const daily = capCounted?.daily;
  if (!capCounted || typeof daily !== "number" || !Number.isFinite(daily) || daily < 0) return "unknown";
  return { campaign_id: body.ad_id ?? body.ad_group_id ?? body.campaign_id, daily_budget_usd: daily, expected_current_daily_budget_usd: 0 };
}

function budgetChangeKey(
  runId: string | null,
  execClass: string,
  body: BudgetDecisionBody | null | undefined,
): string {
  return [
    runId ?? "",
    execClass,
    body?.campaign_id ?? "",
    String(body?.daily_budget_usd ?? ""),
    String(body?.expected_current_daily_budget_usd ?? ""),
  ].join("|");
}

export async function readTenantGoogleCapAndToday(
  tenant_id: string,
  excludeDecisionId?: string,
): Promise<{ cap: Cap | null; today_total_change_usd: number; cap_row_absent: boolean }> {
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
      .eq("platform", "google_ads")
      .maybeSingle();
    if (error) {
      console.warn(
        `[google-ads cap-reader] tenant_ads_write_caps read failed for ${tenant_id}: ${error.message}`,
      );
    } else if (data) {
      cap = data as Cap;
    } else {
      cap_row_absent = true;
    }
  } catch (e) {
    console.warn(
      `[google-ads cap-reader] tenant_ads_write_caps read threw for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  let today_total_change_usd = 0;
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
        `[google-ads cap-reader] today aggregate read failed for ${tenant_id}: ${error.message}`,
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
      `[google-ads cap-reader] today aggregate read threw for ${tenant_id}: ${(e as Error).message}`,
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
        `[google-ads cap-reader] today legacy aggregate read failed for ${tenant_id}: ${error.message}`,
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
      `[google-ads cap-reader] today legacy aggregate read threw for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  for (const { body, n } of seen.values()) today_total_change_usd += budgetChangeUsd(body) * Math.max(n[0], n[1]);

  if (!aggregateComplete) return { cap, today_total_change_usd: DAILY_AGGREGATE_UNREADABLE, cap_row_absent };

  return { cap, today_total_change_usd, cap_row_absent };
}

export function budgetChangeUsd(body: BudgetDecisionBody | null | undefined): number {
  const proposed = Number(body?.daily_budget_usd ?? 0);
  const prior = Number(body?.expected_current_daily_budget_usd ?? 0);
  if (!Number.isFinite(proposed) || !Number.isFinite(prior)) return 0;
  return capCountedChangeUsd(proposed, prior);
}
