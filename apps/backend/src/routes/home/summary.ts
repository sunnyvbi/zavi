
import { goalTrajectoryView } from "@/services/growth/goal-owner";
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { verifyBearer } from "@/services/auth/jwt";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { presentationStatus } from "@/services/agents/run-display-state";
import { getTenantDisabledSlugs } from "@/services/agents/visibility";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { METRIC_REGISTRY } from "@/services/analytics/metric-registry";
import { tenantDayStartIso } from "@/services/tenants/local-day";
import {
  countOpenChannelActions,
  totalWaitingOnYou,
} from "@/services/channels/open-actions-count";

const HOME_METRIC_KEYS = ["weekly_signups", "weekly_bookings", "stripe_mrr"] as const;

function formatMetricValue(value: number, unit: "count" | "usd" | "ratio"): string {
  if (unit === "usd") {
    return value >= 10000
      ? `$${(value / 1000).toFixed(1)}k`
      : `$${Math.round(value).toLocaleString()}`;
  }
  if (unit === "ratio") return `${value.toFixed(1)}x`;
  return Math.round(value).toLocaleString();
}

async function maybeBootstrapResponse(req: Request, res: Response): Promise<boolean> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Missing or invalid Bearer token." },
    });
    return true;
  }

  const userClient = serverClientFromBearer(verified.access_token);
  const { data: prof, error: pErr } = await userClient
    .from("profiles")
    .select("active_tenant_id")
    .eq("user_id", verified.user_id)
    .maybeSingle();
  if (pErr) {
    res.status(500).json({ error: { code: "auth_db_error", message: pErr.message } });
    return true;
  }

  if (prof && prof.active_tenant_id) {
    return false;
  }

  res.status(409).json({
    error: {
      code: "no_active_tenant",
      message: "No active workspace yet. Finish setup at /start.",
    },
  });
  return true;
}

export async function homeSummary(
  req: Request,
  res: Response,
): Promise<void> {
  if (await maybeBootstrapResponse(req, res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  let tenantTz: string | null = null;
  try {
    const { data: t } = await serviceClient()
      .from("tenants")
      .select("timezone")
      .eq("id", auth.tenant_id)
      .maybeSingle<{ timezone: string | null }>();
    tenantTz = t?.timezone ?? null;
  } catch {
    tenantTz = null;
  }
  const todayStartIso = tenantDayStartIso(tenantTz);

  const [
    activeRunsRes,
    spendRes,
    suggestedRes,
    companyRes,
    pendingApprovalsRes,
    openChannelActionsCount,
    recentActivityRes,
    goalsRes,
    metricsRes,
  ] = await Promise.all([
      supabase
        .from("agent_runs")
        .select("id, agent_slug, status, started_at, finished_at, outcome, output_text")
        .eq("tenant_id", auth.tenant_id)
        .neq("agent_definition_hash", "seed-synthetic")
        .gte("started_at", todayStartIso)
        .order("started_at", { ascending: false })
        .limit(3),
      supabase
        .from("agent_runs")
        .select("started_at, cost_usd")
        .eq("tenant_id", auth.tenant_id)
        .neq("agent_definition_hash", "seed-synthetic")
        .gte("started_at", sevenDaysAgo)
        .limit(5000),
      supabase
        .from("home_suggestions")
        .select("feedback_id, agent_slug, suggestion_text, created_at")
        .eq("tenant_id", auth.tenant_id)
        .limit(3),
      supabase
        .from("memory_note")
        .select("id, title, updated_at, source, metadata")
        .eq("tenant_id", auth.tenant_id)
        .eq("slug", "company")
        .is("superseded_by", null)
        .limit(1),
      supabase
        .from("customer_visible_pending_decisions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", auth.tenant_id),
      countOpenChannelActions(supabase, auth.tenant_id),
      supabase
        .from("agent_runs")
        .select("agent_slug, finished_at, cost_usd")
        .eq("tenant_id", auth.tenant_id)
        .neq("agent_definition_hash", "seed-synthetic")
        .eq("status", "success")
        .order("finished_at", { ascending: false })
        .limit(8),
      supabase
        .from("autopilot_goals")
        .select(
          "id, objective, target_metric, target_value, baseline_value, current_value, due_date, status, priority, source, measurement_mode, created_at, current_value_at, count_rule, value_kind, value_period_start",
        )
        .eq("tenant_id", auth.tenant_id)
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("tenant_metric_snapshots")
        .select("metric_key, value, status, window_end")
        .eq("tenant_id", auth.tenant_id)
        .in("metric_key", HOME_METRIC_KEYS as unknown as string[])
        .order("window_end", { ascending: false })
        .limit(60),
    ],
  );

  type RunCost = { started_at: string | null; cost_usd: number | null };
  const buckets: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  for (const r of (spendRes.data ?? []) as RunCost[]) {
    if (!r.started_at) continue;
    const day = r.started_at.slice(0, 10);
    if (day in buckets) buckets[day] += r.cost_usd ?? 0;
  }
  const spend_week = Object.entries(buckets).map(([date, usd]) => ({
    date,
    usd,
  }));
  const spend_total_usd = spend_week.reduce((s, b) => s + b.usd, 0);

  const disabled = await getTenantDisabledSlugs(auth.tenant_id);
  const suggestedRows = (suggestedRes.data ?? []) as Array<{
    agent_slug: string;
  }>;
  const suggested_next =
    disabled.size === 0
      ? suggestedRows
      : suggestedRows.filter((r) => !disabled.has(r.agent_slug));

  type KeyFact = { label: string; value: string };
  const safeKeyFacts = (m: unknown): KeyFact[] | undefined => {
    const kf = (m as { key_facts?: unknown } | null)?.key_facts;
    if (!Array.isArray(kf)) return undefined;
    const out = kf.filter(
      (x): x is KeyFact =>
        !!x &&
        typeof x === "object" &&
        typeof (x as KeyFact).label === "string" &&
        typeof (x as KeyFact).value === "string",
    );
    return out.length === kf.length ? out : undefined;
  };

  type ActivityRow = {
    agent_slug: string;
    finished_at: string | null;
    cost_usd: number | null;
  };
  const recent_activity = ((recentActivityRes.data ?? []) as ActivityRow[]).map(
    (r) => ({
      agent_slug: r.agent_slug,
      finished_at: r.finished_at,
      cost_usd: r.cost_usd ?? 0,
    }),
  );

  type GoalRow = {
    id: string;
    objective: string;
    target_metric: string;
    target_value: number | string;
    baseline_value: number | string | null;
    current_value: number | string | null;
    due_date: string | null;
    status: string;
    priority: number;
    source: string;
    measurement_mode?: string | null;
    created_at?: string | null;
    current_value_at?: string | null;
    count_rule?: unknown;
    value_kind?: string | null;
    value_period_start?: string | null;
  };
  const goals = ((goalsRes.data ?? []) as GoalRow[]).map((g) => ({
    id: g.id,
    objective: decodeXmlEntities(g.objective),
    target_metric: decodeXmlEntities(g.target_metric),
    target_value: Number(g.target_value),
    baseline_value: g.baseline_value === null ? null : Number(g.baseline_value),
    current_value: g.current_value === null ? null : Number(g.current_value),
    due_date: g.due_date,
    status: g.status,
    priority: g.priority,
    source: g.source,
    measurement_mode: g.measurement_mode ?? null,
    trajectory: goalTrajectoryView({
      id: g.id,
      target_metric: g.target_metric,
      target_value: Number(g.target_value),
      baseline_value: g.baseline_value === null ? null : Number(g.baseline_value),
      current_value: g.current_value === null ? null : Number(g.current_value),
      current_value_at: g.current_value_at ?? null,
      due_date: g.due_date,
      measurement_mode: g.measurement_mode ?? null,
      created_at: g.created_at ?? null,
      count_rule: g.count_rule,
      value_kind: g.value_kind ?? null,
      value_period_start: g.value_period_start ?? null,
    }),
  }));

  type MetricRow = {
    metric_key: string;
    value: number | string | null;
    status: string;
    window_end: string;
  };
  const latestByKey = new Map<string, MetricRow>();
  for (const row of (metricsRes.data ?? []) as MetricRow[]) {
    if (!latestByKey.has(row.metric_key)) latestByKey.set(row.metric_key, row);
  }
  const business_stats = HOME_METRIC_KEYS.flatMap((key) => {
    const row = latestByKey.get(key);
    if (!row) return [];
    const def = METRIC_REGISTRY[key];
    const measured = row.status === "measured" && row.value !== null;
    return [
      {
        label: def.label,
        value: measured ? formatMetricValue(Number(row.value), def.unit) : "—",
        status: row.status === "measured" ? ("measured" as const) : ("unavailable" as const),
        unit: def.unit,
        direction: def.direction,
        source: "metric" as const,
        metric_key: key,
        window_end: row.window_end,
      },
    ];
  });

  res.json({
    active_runs_today: ((activeRunsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      agent_slug: r.agent_slug,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
      presentation_status: presentationStatus({
        status: r.status as string | null,
        outcome: r.outcome as { deliverable?: string | null } | null,
        outputText: r.output_text as string | null,
      }),
    })),
    spend_week,
    spend_total_usd,
    suggested_next,
    pending_approvals_count: totalWaitingOnYou(pendingApprovalsRes.count, openChannelActionsCount),
    recent_activity,
    goals,
    business_stats,
    company_md_ref:
      companyRes.data && companyRes.data.length > 0
        ? (() => {
            const row = companyRes.data[0] as {
              id: string;
              title: string;
              updated_at: string;
              source: "human" | "agent_write" | string;
              metadata: unknown;
            };
            return {
              id: row.id,
              title: row.title,
              updated_at: row.updated_at,
              source: row.source,
              metadata: { key_facts: safeKeyFacts(row.metadata) },
            };
          })()
        : null,
  });
}
