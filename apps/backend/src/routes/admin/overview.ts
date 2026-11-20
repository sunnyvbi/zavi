
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { fetchAllPaged } from "./agent-performance";
import { tallyFeedback, type FeedbackRow, type FeedbackTally } from "./stats";
import { SLA_MINUTES } from "./stuck-runs";
import { SPIKE_MULTIPLE } from "./cost-anomaly";
import { PROP_WHITELIST } from "./activity";

export const DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const FAIL_STATUSES = ["failed", "parse_failed", "dispatch_error"];
export const OK_STATUSES = ["success", "completed", "succeeded"];
export const STALE_DECISION_HOURS = 48;

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function lastDays(nowMs: number, n = DAYS): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(utcDayKey(nowMs - i * DAY_MS));
  return out;
}

export function windowStartMs(nowMs: number, n = DAYS): number {
  const d = new Date(nowMs - (n - 1) * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function dayFraction(nowMs: number): number {
  const d = new Date(nowMs);
  return (nowMs - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / DAY_MS;
}

export function failureRate(failed: number, total: number): number | null {
  return total > 0 ? failed / total : null;
}

export function deltaPct(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

export function netScore(up: number, down: number): number | null {
  const total = up + down;
  return total === 0 ? null : Math.round(((up - down) / total) * 100);
}

export type RunRow = {
  id: string;
  tenant_id: string | null;
  agent_slug: string | null;
  status: string;
  enqueued_at: string | null;
  finished_at: string | null;
  cost_usd: number | null;
  cron_dedupe_key: string | null;
  error: string | null;
};

export type RunsSummary = {
  last_24h: number;
  failed_24h: number;
  prev_week_24h: number;
  failure_rate_24h: number | null;
  delta_pct: number | null;
  top_failing_agent: { agent_slug: string; count: number } | null;
  daily: Array<{ day: string; ok: number; failed: number; other: number }>;
};

export function summarizeRuns(rows: RunRow[], nowMs: number): RunsSummary {
  const days = lastDays(nowMs);
  const byDay = new Map(days.map((d) => [d, { day: d, ok: 0, failed: 0, other: 0 }]));
  const since24 = nowMs - DAY_MS;
  const prevStart = nowMs - 8 * DAY_MS;
  const prevEnd = nowMs - 7 * DAY_MS;
  let last24 = 0;
  let failed24 = 0;
  let prev = 0;
  const failByAgent = new Map<string, number>();
  for (const r of rows) {
    if (!r.enqueued_at) continue;
    const t = new Date(r.enqueued_at).getTime();
    const failed = FAIL_STATUSES.includes(r.status);
    const bucket = byDay.get(utcDayKey(t));
    if (bucket) {
      if (failed) bucket.failed++;
      else if (OK_STATUSES.includes(r.status)) bucket.ok++;
      else bucket.other++;
    }
    if (t >= since24 && t <= nowMs) {
      last24++;
      if (failed) {
        failed24++;
        const a = r.agent_slug ?? "unknown";
        failByAgent.set(a, (failByAgent.get(a) ?? 0) + 1);
      }
    } else if (t >= prevStart && t < prevEnd) {
      prev++;
    }
  }
  let top: RunsSummary["top_failing_agent"] = null;
  for (const [agent_slug, count] of failByAgent) {
    if (!top || count > top.count) top = { agent_slug, count };
  }
  return {
    last_24h: last24,
    failed_24h: failed24,
    prev_week_24h: prev,
    failure_rate_24h: failureRate(failed24, last24),
    delta_pct: deltaPct(last24, prev),
    top_failing_agent: top,
    daily: days.map((d) => byDay.get(d)!),
  };
}

export type TenantRow = { id: string; slug: string | null; display_name: string | null; created_at: string | null };

export function tenantLabel(t: { slug?: string | null; display_name?: string | null } | undefined, id: string): string {
  return t?.display_name || t?.slug || id.slice(0, 8);
}

export function summarizeTenants(rows: TenantRow[], nowMs: number): { total: number; new_7d: number; daily_total: number[] } {
  const days = lastDays(nowMs);
  const since7 = nowMs - 7 * DAY_MS;
  let new7 = 0;
  const daily_total = days.map(() => 0);
  for (const t of rows) {
    const created = t.created_at ? new Date(t.created_at).getTime() : 0;
    if (created >= since7) new7++;
    const key = utcDayKey(created);
    for (let i = 0; i < days.length; i++) if (key <= days[i]) daily_total[i]++;
  }
  return { total: rows.length, new_7d: new7, daily_total };
}

export type SpendSummary = {
  today_usd: number;
  avg_daily_7d_usd: number;
  delta_pct: number | null;
  daily_usd: number[];
  top_today: Array<{ tenant_id: string; label: string; usd: number }>;
  spikes: Array<{ tenant_id: string; label: string; cost_24h: number; avg_daily_7d: number; x_multiple: number }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeSpend(rows: RunRow[], nowMs: number, labels: Map<string, string>): SpendSummary {
  const days = lastDays(nowMs);
  const today = days[days.length - 1];
  const prior7 = new Set(days.slice(-8, -1));
  const daily = new Map(days.map((d) => [d, 0]));
  const todayByTenant = new Map<string, number>();
  const since24 = nowMs - DAY_MS;
  const since8d = nowMs - 8 * DAY_MS;
  const spikeAcc = new Map<string, { c24: number; prior: number }>();
  for (const r of rows) {
    const cost = Number(r.cost_usd) || 0;
    if (cost <= 0 || !r.enqueued_at) continue;
    const t = new Date(r.enqueued_at).getTime();
    const key = utcDayKey(t);
    if (daily.has(key)) daily.set(key, daily.get(key)! + cost);
    if (key === today && r.tenant_id) todayByTenant.set(r.tenant_id, (todayByTenant.get(r.tenant_id) ?? 0) + cost);
    if (r.tenant_id && t >= since8d) {
      const a = spikeAcc.get(r.tenant_id) ?? { c24: 0, prior: 0 };
      if (t >= since24) a.c24 += cost;
      else a.prior += cost;
      spikeAcc.set(r.tenant_id, a);
    }
  }
  let prior = 0;
  for (const d of prior7) prior += daily.get(d) ?? 0;
  const avg = prior / 7;
  const todayUsd = daily.get(today) ?? 0;
  const spikes: SpendSummary["spikes"] = [];
  for (const [tenant_id, a] of spikeAcc) {
    const avgDaily = a.prior / 7;
    if (avgDaily > 0 && a.c24 > 0 && a.c24 >= SPIKE_MULTIPLE * avgDaily) {
      spikes.push({
        tenant_id,
        label: labels.get(tenant_id) ?? tenant_id.slice(0, 8),
        cost_24h: round2(a.c24),
        avg_daily_7d: round2(avgDaily),
        x_multiple: Math.round((a.c24 / avgDaily) * 10) / 10,
      });
    }
  }
  spikes.sort((x, y) => y.cost_24h - x.cost_24h);
  const top_today = [...todayByTenant.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 4)
    .map(([tenant_id, usd]) => ({ tenant_id, label: labels.get(tenant_id) ?? tenant_id.slice(0, 8), usd: round2(usd) }));
  return {
    today_usd: round2(todayUsd),
    avg_daily_7d_usd: round2(avg),
    delta_pct: deltaPct(todayUsd, avg * dayFraction(nowMs)),
    daily_usd: days.map((d) => round2(daily.get(d) ?? 0)),
    top_today,
    spikes,
  };
}

export type ScheduleRow = { tenant_id: string; agent_slug: string; enabled: boolean };

export type CronSummary = {
  healthy: number;
  degraded: number;
  down: number;
  failing: Array<{ name: string; ok_24h: number; fail_24h: number }>;
  recent_failures: Array<{ name: string; at: string | null; error: string | null }>;
};

export function summarizeCrons(schedules: ScheduleRow[], rows: RunRow[], nowMs: number, labels: Map<string, string>): CronSummary {
  const since24 = nowMs - DAY_MS;
  const counts = new Map<string, { ok: number; fail: number }>();
  const failures: RunRow[] = [];
  for (const r of rows) {
    if (!r.cron_dedupe_key || !r.enqueued_at || !r.tenant_id) continue;
    if (new Date(r.enqueued_at).getTime() < since24) continue;
    const k = `${r.tenant_id}::${r.agent_slug}`;
    const c = counts.get(k) ?? { ok: 0, fail: 0 };
    if (FAIL_STATUSES.includes(r.status)) {
      c.fail++;
      failures.push(r);
    } else if (OK_STATUSES.includes(r.status)) c.ok++;
    counts.set(k, c);
  }
  const name = (tenantId: string, slug: string | null) => `${labels.get(tenantId) ?? tenantId.slice(0, 8)} · ${slug ?? "unknown"}`;
  const out: CronSummary = { healthy: 0, degraded: 0, down: 0, failing: [], recent_failures: [] };
  for (const s of schedules) {
    if (!s.enabled) continue;
    const c = counts.get(`${s.tenant_id}::${s.agent_slug}`) ?? { ok: 0, fail: 0 };
    if (c.fail > 0 && c.ok === 0) out.down++;
    else if (c.fail > 0) out.degraded++;
    else out.healthy++;
    if (c.fail > 0) out.failing.push({ name: name(s.tenant_id, s.agent_slug), ok_24h: c.ok, fail_24h: c.fail });
  }
  out.failing.sort((a, b) => b.fail_24h - a.fail_24h || a.ok_24h - b.ok_24h);
  const ts = (r: RunRow) => new Date(r.finished_at ?? r.enqueued_at ?? 0).getTime();
  out.recent_failures = failures
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, 2)
    .map((r) => ({ name: name(r.tenant_id!, r.agent_slug), at: r.finished_at ?? r.enqueued_at, error: r.error ? r.error.slice(0, 160) : null }));
  return out;
}

export type StuckRun = { tenant: string; agent_slug: string | null; age_min: number };

export type NeedsRow = {
  kind: "failed_runs" | "crons" | "decisions" | "stuck_runs" | "cost_spike";
  severity: "red" | "amber" | "blue";
  title: string;
  detail: string;
  href: string;
  cta: string;
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function buildNeedsYouNow(input: {
  runs: Pick<RunsSummary, "failed_24h" | "failure_rate_24h" | "top_failing_agent">;
  crons: Pick<CronSummary, "down" | "degraded" | "failing">;
  decisions: { pending: number; pending_older_48h: number };
  stuck: { count: number; sla_minutes: number; oldest: StuckRun[] };
  spikes: SpendSummary["spikes"];
}): NeedsRow[] {
  const rows: NeedsRow[] = [];
  const { runs, crons, decisions, stuck, spikes } = input;
  if (runs.failed_24h > 0) {
    const rate = runs.failure_rate_24h == null ? "" : `${(runs.failure_rate_24h * 100).toFixed(1)}% of runs. `;
    const top = runs.top_failing_agent ? `Most on ${runs.top_failing_agent.agent_slug} (${runs.top_failing_agent.count}).` : "";
    rows.push({ kind: "failed_runs", severity: "red", title: `${plural(runs.failed_24h, "failed run")} in the last 24h`, detail: (rate + top).trim(), href: "/errors", cta: "View errors" });
  }
  const failingCrons = crons.down + crons.degraded;
  if (failingCrons > 0) {
    const worst = crons.failing[0];
    const detail = worst ? `${worst.name} failed ${worst.fail_24h} of its last ${worst.fail_24h + worst.ok_24h} runs in 24h.` : "";
    rows.push({ kind: "crons", severity: "red", title: `${plural(failingCrons, "cron")} failing (${crons.down} down, ${crons.degraded} degraded)`, detail, href: "/crons", cta: "Open crons" });
  }
  if (decisions.pending > 0) {
    const detail = decisions.pending_older_48h > 0 ? `${decisions.pending_older_48h} older than ${STALE_DECISION_HOURS}h.` : `None older than ${STALE_DECISION_HOURS}h.`;
    rows.push({ kind: "decisions", severity: "amber", title: `${plural(decisions.pending, "decision")} waiting for approval`, detail, href: "/decisions?status=proposed", cta: "Review" });
  }
  if (stuck.count > 0) {
    const detail = stuck.oldest.map((s) => `${s.tenant} · ${s.agent_slug ?? "unknown"} (${s.age_min} min)`).join(", ");
    rows.push({ kind: "stuck_runs", severity: "amber", title: `${plural(stuck.count, "stuck run")} over ${stuck.sla_minutes} minutes`, detail, href: "/stuck-runs", cta: "Open" });
  }
  if (spikes.length > 0) {
    const s = spikes[0];
    const title = spikes.length === 1 ? `Cost spike on ${s.label}` : `Cost spikes on ${spikes.length} tenants`;
    rows.push({ kind: "cost_spike", severity: "blue", title, detail: `${s.label}: ${usd(s.cost_24h)} in 24h vs ${usd(s.avg_daily_7d)} daily average (${s.x_multiple}x).`, href: "/cost-anomaly", cta: "Investigate" });
  }
  return rows;
}

export type OverviewResponse = {
  generated_at: string;
  truncated: boolean;
  needs_you_now: NeedsRow[];
  tenants: { total: number; new_7d: number; daily_total: number[] };
  runs: RunsSummary;
  decisions: { pending: number; pending_older_48h: number; daily_new: number[] };
  stuck_runs: { count: number; sla_minutes: number; oldest: StuckRun[] };
  crons: CronSummary;
  spend: SpendSummary;
  feedback_7d: FeedbackTally;
  activity: Array<{ id: number; at: string; tenant_slug: string | null; verb: string; detail: Record<string, string | number | boolean> }>;
};

export async function staffOverview(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/overview: cross-tenant staff read-only dashboard home");
  const nowMs = Date.now();
  const since = new Date(windowStartMs(nowMs)).toISOString();
  const since7d = new Date(nowMs - 7 * DAY_MS).toISOString();
  const stale = new Date(nowMs - STALE_DECISION_HOURS * 60 * 60 * 1000).toISOString();
  const slaCutoff = new Date(nowMs - SLA_MINUTES * 60 * 1000).toISOString();

  try {
    const [runsRes, decRes, tenantsQ, pendingQ, staleQ, stuckQ, schedulesQ, feedbackQ, activityQ] = await Promise.all([
      fetchAllPaged<RunRow>((from, to) =>
        sb
          .from("agent_runs")
          .select("id, tenant_id, agent_slug, status, enqueued_at, finished_at, cost_usd, cron_dedupe_key, error")
          .gte("enqueued_at", since)
          .order("enqueued_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAllPaged<{ id: string; emitted_at: string | null }>((from, to) =>
        sb
          .from("decisions")
          .select("id, emitted_at")
          .gte("emitted_at", since)
          .order("emitted_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      sb.from("tenants").select("id, slug, display_name, created_at").limit(5000),
      sb.from("decisions").select("id", { head: true, count: "exact" }).eq("status", "proposed"),
      sb.from("decisions").select("id", { head: true, count: "exact" }).eq("status", "proposed").lt("emitted_at", stale),
      sb
        .from("agent_runs")
        .select("tenant_id, agent_slug, started_at", { count: "exact" })
        .eq("status", "running")
        .lt("started_at", slaCutoff)
        .order("started_at", { ascending: true })
        .limit(2),
      sb.from("tenant_agent_schedules").select("tenant_id, agent_slug, enabled").limit(5000),
      sb.from("agent_feedback").select("rating, created_by_role").gte("created_at", since7d).limit(1000),
      sb
        .from("activity_events")
        .select("id, tenant_id, occurred_at, verb, props")
        .order("occurred_at", { ascending: false })
        .limit(4),
    ]);

    for (const q of [tenantsQ, pendingQ, staleQ, stuckQ, schedulesQ, feedbackQ, activityQ]) {
      if (q.error) throw new Error(q.error.message);
    }

    const tenantRows = (tenantsQ.data ?? []) as TenantRow[];
    const byId = new Map(tenantRows.map((t) => [t.id, t]));
    const labels = new Map(tenantRows.map((t) => [t.id, tenantLabel(t, t.id)]));
    const slugById = new Map(tenantRows.map((t) => [t.id, t.slug]));

    const runs = summarizeRuns(runsRes.rows, nowMs);
    const spend = summarizeSpend(runsRes.rows, nowMs, labels);
    const crons = summarizeCrons((schedulesQ.data ?? []) as ScheduleRow[], runsRes.rows, nowMs, labels);

    const days = lastDays(nowMs);
    const decDaily = new Map(days.map((d) => [d, 0]));
    for (const d of decRes.rows) {
      if (!d.emitted_at) continue;
      const k = utcDayKey(new Date(d.emitted_at).getTime());
      if (decDaily.has(k)) decDaily.set(k, decDaily.get(k)! + 1);
    }
    const decisions = {
      pending: pendingQ.count ?? 0,
      pending_older_48h: staleQ.count ?? 0,
      daily_new: days.map((d) => decDaily.get(d) ?? 0),
    };

    const stuck = {
      count: stuckQ.count ?? 0,
      sla_minutes: SLA_MINUTES,
      oldest: ((stuckQ.data ?? []) as Array<{ tenant_id: string | null; agent_slug: string | null; started_at: string | null }>).map((r) => ({
        tenant: r.tenant_id ? tenantLabel(byId.get(r.tenant_id), r.tenant_id) : "unknown",
        agent_slug: r.agent_slug,
        age_min: r.started_at ? Math.round((nowMs - new Date(r.started_at).getTime()) / 60000) : 0,
      })),
    };

    const activity = ((activityQ.data ?? []) as Array<{ id: number; tenant_id: string; occurred_at: string; verb: string; props: Record<string, unknown> | null }>).map((r) => {
      const detail: Record<string, string | number | boolean> = {};
      for (const k of PROP_WHITELIST[r.verb] ?? []) {
        const v = r.props?.[k];
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") detail[k] = v;
      }
      return { id: r.id, at: r.occurred_at, tenant_slug: slugById.get(r.tenant_id) ?? null, verb: r.verb, detail };
    });

    const body: OverviewResponse = {
      generated_at: new Date(nowMs).toISOString(),
      truncated: runsRes.truncated || decRes.truncated,
      needs_you_now: buildNeedsYouNow({ runs, crons, decisions, stuck, spikes: spend.spikes }),
      tenants: summarizeTenants(tenantRows, nowMs),
      runs,
      decisions,
      stuck_runs: stuck,
      crons,
      spend,
      feedback_7d: tallyFeedback((feedbackQ.data ?? []) as FeedbackRow[]),
      activity,
    };
    res.json(body);
  } catch (e) {
    res.status(500).json({ error: { code: "overview_failed", message: (e as Error).message } });
  }
}
