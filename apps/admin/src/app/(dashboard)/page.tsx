"use client";

import { useEffect } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  CheckCircle2,
  Clock,
  Flame,
  GitPullRequestArrow,
  TimerReset,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { useOverview } from "@/components/admin/OverviewProvider";
import {
  activityText,
  dayLabel,
  deltaTone,
  netScore,
  relTime,
  signedPct,
  sparkPoints,
  usd,
  type DeltaMode,
  type DeltaTone,
  type NeedsRow,
  type Overview,
} from "@/lib/overview";

export default function AdminDashboardPage() {
  const { data, error, loading, refresh } = useOverview();

  useEffect(() => {
    refresh({ ifOlderThanMs: 60_000 });
  }, [refresh]);

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-7 sm:pt-7">
      <PageHeader title="Overview" subtitle={`${today} · What needs you first, then how the fleet is doing.`} />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          Could not load the overview: {error}
        </div>
      )}

      {!data ? (
        loading && !error ? <div className="text-[15px] text-slate-600">Loading…</div> : null
      ) : (
        <Body o={data} />
      )}
    </div>
  );
}

function Body({ o }: { o: Overview }) {
  return (
    <>
      {o.truncated && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Run history hit the read limit, so the 14-day numbers below are partial.
        </div>
      )}
      <NeedsYouNow rows={o.needs_you_now} />
      <Kpis o={o} />
      <div className="mb-4 grid gap-[18px] xl:grid-cols-[1.6fr_1fr]">
        <RunsChart daily={o.runs.daily} />
        <Feedback f={o.feedback_7d} />
      </div>
      <div className="grid gap-[18px] xl:grid-cols-3">
        <CronHealth c={o.crons} />
        <TopSpend rows={o.spend.top_today} />
        <RecentActivity rows={o.activity} />
      </div>
    </>
  );
}

const SEV: Record<NeedsRow["severity"], string> = {
  red: "bg-rose-100 text-rose-700",
  amber: "bg-amber-100 text-amber-700",
  blue: "bg-sky-100 text-sky-700",
};
const KIND_ICON: Record<NeedsRow["kind"], LucideIcon> = {
  failed_runs: AlertTriangle,
  crons: Clock,
  decisions: GitPullRequestArrow,
  stuck_runs: TimerReset,
  cost_spike: Flame,
};

function NeedsYouNow({ rows }: { rows: NeedsRow[] }) {
  return (
    <section className="glass-card mb-4">
      <div className="flex items-center gap-2 px-5 pt-5 text-base font-semibold text-slate-900">
        <BellRing className={"h-[17px] w-[17px] " + (rows.length ? "text-rose-700" : "text-emerald-700")} strokeWidth={1.9} />
        Needs you now
        {rows.length > 0 && (
          <span className="ml-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">{rows.length}</span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 p-5 font-semibold text-emerald-700">
          <CheckCircle2 className="h-5 w-5" strokeWidth={1.9} />
          All clear. No failed runs, failing crons, pending decisions, stuck runs or cost spikes.
        </div>
      ) : (
        <div className="mt-2">
          {rows.map((r, i) => {
            const Icon = KIND_ICON[r.kind];
            return (
              <div key={r.kind} className={"flex flex-wrap items-center gap-3.5 px-5 py-4 sm:flex-nowrap " + (i ? "border-t border-slate-200" : "")}>
                <div className={"flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg " + SEV[r.severity]}>
                  <Icon className="h-4 w-4" strokeWidth={1.9} />
                </div>
                <div className="min-w-[200px] flex-1">
                  <div className="font-semibold text-slate-900">{r.title}</div>
                  {r.detail && <div className="mt-0.5 text-[14px] text-slate-600">{r.detail}</div>}
                </div>
                <Link
                  href={r.href}
                  className="ml-11 inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border sm:ml-0 border-slate-200 bg-white px-3 text-[14px] font-semibold text-slate-900 hover:border-slate-600"
                >
                  {r.cta}
                  <ArrowRight className="h-[15px] w-[15px]" strokeWidth={1.9} />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Spark({ values, color, caption }: { values: number[]; color: string; caption: string }) {
  return (
    <svg className="mt-2.5 block h-7 w-full" viewBox="0 0 200 28" preserveAspectRatio="none" role="img" aria-label={caption}>
      <title>{caption}</title>
      <polyline fill="none" stroke={color} strokeWidth={2} points={sparkPoints(values)} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Kpi({
  label,
  value,
  sub,
  href,
  spark,
  sparkColor,
  sparkCaption,
  tone,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
  href: string;
  spark: number[];
  sparkColor: string;
  sparkCaption: string;
  tone?: "red" | "amber";
}) {
  const valueCls = tone === "red" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <Link href={href} className="glass-card block p-5 transition-transform hover:-translate-y-px">
      <div className="admin-label">{label}</div>
      <div className={"mt-1.5 text-[30px] font-bold leading-tight tracking-[-0.02em] tabular-nums sm:text-[36px] " + valueCls}>{value}</div>
      <div className="mt-0.5 text-[14px] font-medium text-slate-600">{sub}</div>
      <Spark values={spark} color={sparkColor} caption={sparkCaption} />
    </Link>
  );
}

const ACCENT = "#0369A1";
const DANGER = "#BE123C";
const WARN = "#B45309";

const DELTA_CLS: Record<DeltaTone, string> = {
  good: "text-emerald-700",
  bad: "text-rose-700",
  neutral: "text-slate-600",
};

function Delta({ pct, mode }: { pct: number | null; mode: DeltaMode }) {
  if (pct == null) return null;
  return <span className={DELTA_CLS[deltaTone(pct, mode)]}>{signedPct(pct)}</span>;
}

function Kpis({ o }: { o: Overview }) {
  const runsTotals = o.runs.daily.map((d) => d.ok + d.failed + d.other);
  const failedDaily = o.runs.daily.map((d) => d.failed);
  const rate = o.runs.failure_rate_24h;
  return (
    <div className="mb-4 grid grid-cols-2 gap-[18px] md:grid-cols-[repeat(auto-fit,minmax(195px,1fr))]">
      <Kpi
        label="Tenants"
        value={o.tenants.total.toLocaleString()}
        sub={
          o.tenants.new_7d > 0 ? (
            <>
              <span className="text-emerald-700">+{o.tenants.new_7d}</span> in the last 7 days
            </>
          ) : (
            "No new tenants in 7 days"
          )
        }
        href="/tenants"
        spark={o.tenants.daily_total}
        sparkCaption="Total tenants per day, 14 days"
        sparkColor={ACCENT}
      />
      <Kpi
        label="Runs · 24h"
        value={o.runs.last_24h.toLocaleString()}
        sub={
          o.runs.delta_pct == null ? (
            "No runs in the same window last week"
          ) : (
            <>
              <Delta pct={o.runs.delta_pct} mode="neutral" /> vs same time last week
            </>
          )
        }
        href="/runs"
        spark={runsTotals}
        sparkCaption="Runs per day, 14 days"
        sparkColor={ACCENT}
      />
      <Kpi
        label="Failed · 24h"
        value={o.runs.failed_24h.toLocaleString()}
        sub={o.runs.failed_24h > 0 && rate != null ? `${(rate * 100).toFixed(1)}% failure rate` : "No failures"}
        href="/errors"
        spark={failedDaily}
        sparkCaption="Failed runs per day, 14 days"
        sparkColor={DANGER}
        tone={o.runs.failed_24h > 0 ? "red" : undefined}
      />
      <Kpi
        label="Decisions pending"
        value={o.decisions.pending.toLocaleString()}
        sub={o.decisions.pending_older_48h > 0 ? `${o.decisions.pending_older_48h} older than 48h` : "None older than 48h"}
        href="/decisions?status=proposed"
        spark={o.decisions.daily_new}
        sparkCaption="New decisions per day, 14 days"
        sparkColor={WARN}
        tone={o.decisions.pending > 0 ? "amber" : undefined}
      />
      <Kpi
        label="Spend today"
        value={usd(o.spend.today_usd)}
        sub={
          o.spend.delta_pct == null ? (
            "No spend in the prior 7 days"
          ) : (
            <>
              <Delta pct={o.spend.delta_pct} mode="up-is-bad" /> vs 7-day pace so far (avg {usd(o.spend.avg_daily_7d_usd)}/day)
            </>
          )
        }
        href="/costs"
        spark={o.spend.daily_usd}
        sparkCaption="Spend per day, 14 days"
        sparkColor={ACCENT}
      />
    </div>
  );
}

function RunsChart({ daily }: { daily: Overview["runs"]["daily"] }) {
  const totals = daily.map((d) => d.ok + d.failed + d.other);
  const max = Math.max(1, ...totals);
  const sum = totals.reduce((a, b) => a + b, 0);
  const failed = daily.reduce((a, d) => a + d.failed, 0);
  const anyOther = daily.some((d) => d.other > 0);
  return (
    <section className="glass-card p-5">
      <div className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
        Runs per day
        <span className="admin-label ml-auto">
          {sum.toLocaleString()} runs · {failed.toLocaleString()} failed · 14 days (UTC)
        </span>
      </div>
      {sum === 0 ? (
        <div className="py-12 text-center text-[15px] text-slate-600">No runs in the last 14 days.</div>
      ) : (
        <>
          <div className="mt-2 flex h-[150px] items-end gap-1 sm:gap-1.5">
            {daily.map((d, i) => (
              <div
                key={d.day}
                className="group relative flex h-full flex-1 items-end outline-none"
                tabIndex={0}
                aria-label={`${d.day}: ${d.ok} succeeded, ${d.failed} failed${d.other ? `, ${d.other} other` : ""}`}
              >
                <div
                  className="flex w-full flex-col-reverse overflow-hidden rounded-t-[4px]"
                  style={{ height: `${totals[i] ? Math.max(2, (totals[i] / max) * 100) : 0}%` }}
                >
                  <div className="w-full bg-sky-700/85 group-hover:bg-sky-700" style={{ flex: d.ok }} />
                  {d.other > 0 && <div className="w-full bg-slate-300" style={{ flex: d.other }} />}
                  {d.failed > 0 && <div className="w-full bg-rose-700" style={{ flex: d.failed }} />}
                </div>
                <div className="pointer-events-none absolute left-1/2 top-0 z-10 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white group-hover:block group-focus:block">
                  {dayLabel(d.day, true)}: {d.ok} ok, {d.failed} failed{d.other ? `, ${d.other} other` : ""}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1 sm:gap-1.5">
            {daily.map((d, i) => (
              <span
                key={d.day}
                className={"flex-1 whitespace-nowrap text-center text-[11px] text-slate-600 " + (i % 2 ? "invisible sm:visible" : "")}
              >
                {dayLabel(d.day, i === 0)}
              </span>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-3.5 text-[14px] text-slate-600">
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-sky-700" />
              Succeeded
            </span>
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-rose-700" />
              Failed
            </span>
            {anyOther && (
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-slate-300" />
                Other (queued, running, cancelled)
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function FeedbackRow({ who, up, down }: { who: string; up: number; down: number }) {
  const total = up + down;
  const net = netScore(up, down);
  return (
    <div className="mt-3.5">
      <div className="flex items-baseline gap-2.5">
        <span className="font-semibold text-slate-900">{who}</span>
        <span className="text-[14px] text-slate-600">
          {total} {total === 1 ? "vote" : "votes"}
        </span>
        <span
          className={
            "ml-auto text-xl font-semibold tabular-nums " +
            (net == null ? "text-slate-600" : net >= 0 ? "text-emerald-700" : "text-rose-700")
          }
        >
          {net == null ? "n/a" : `${net > 0 ? "+" : ""}${net}`}
        </span>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-200">
        {total > 0 && (
          <>
            <div className="bg-emerald-700" style={{ flex: up }} />
            <div className="bg-rose-700" style={{ flex: down }} />
          </>
        )}
      </div>
      <div className="mt-1.5 text-[14px] text-slate-600">
        {total === 0
          ? "No votes this week."
          : `${up} helpful, ${down} not helpful. Net score = helpful minus not helpful, as % of votes.`}
      </div>
    </div>
  );
}

function Feedback({ f }: { f: Overview["feedback_7d"] }) {
  return (
    <section className="glass-card p-5">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
        Feedback on agent replies
        <span className="admin-label ml-auto">Last 7 days</span>
      </div>
      <FeedbackRow who="Operators" up={f.operator_up} down={f.operator_down} />
      <FeedbackRow who="Staff" up={f.staff_up} down={f.staff_down} />
      <div className="mt-3.5">
        <Link href="/feedback" className="text-[14px] font-semibold text-sky-700 hover:underline">
          See all feedback →
        </Link>
      </div>
    </section>
  );
}

function CronHealth({ c }: { c: Overview["crons"] }) {
  const total = c.healthy + c.degraded + c.down;
  return (
    <section className="glass-card p-5">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
        Cron health
        <span className="admin-label ml-auto">24h</span>
        <Link href="/crons" className="text-[14px] font-semibold text-sky-700 hover:underline">
          All →
        </Link>
      </div>
      {total === 0 ? (
        <div className="py-6 text-[15px] text-slate-600">No enabled schedules.</div>
      ) : (
        <div className="mt-2.5 flex gap-2.5">
          <Stat label="Healthy" n={c.healthy} cls="bg-emerald-100 text-emerald-700" />
          <Stat label="Degraded" n={c.degraded} cls={c.degraded ? "bg-amber-100 text-amber-700" : "border border-slate-200 text-slate-900"} />
          <Stat label="Down" n={c.down} cls={c.down ? "bg-rose-100 text-rose-700" : "border border-slate-200 text-slate-900"} />
        </div>
      )}
      {c.recent_failures.map((f, i) => (
        <div key={i} className={"flex gap-2.5 border-t border-slate-200 py-2.5 " + (i === 0 ? "mt-2.5" : "")}>
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-700" />
          <div className="min-w-0">
            <div className="truncate font-semibold text-slate-900">{f.name}</div>
            <div className="text-[14px] text-slate-600">
              {relTime(f.at)}
              {f.error ? ` · ${f.error}` : ""}
            </div>
          </div>
        </div>
      ))}
      {total > 0 && c.recent_failures.length === 0 && (
        <div className="mt-3 text-[14px] text-slate-600">No cron failures in the last 24h.</div>
      )}
    </section>
  );
}

function Stat({ label, n, cls }: { label: string; n: number; cls: string }) {
  return (
    <div className={"flex-1 rounded-[10px] px-3 py-2.5 " + cls}>
      <div className="admin-label">{label}</div>
      <div className="text-[22px] font-semibold tabular-nums">{n}</div>
    </div>
  );
}

function TopSpend({ rows }: { rows: Overview["spend"]["top_today"] }) {
  return (
    <section className="glass-card p-5">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
        Top spend today
        <span className="admin-label ml-auto">UTC day</span>
        <Link href="/tenant-costs" className="text-[14px] font-semibold text-sky-700 hover:underline">
          All →
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-[15px] text-slate-600">No spend recorded today.</div>
      ) : (
        <div className="mt-1.5">
          {rows.map((r, i) => (
            <div key={r.tenant_id} className={"flex items-center gap-3 py-3 text-slate-700 " + (i ? "border-t border-slate-200" : "")}>
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="font-semibold tabular-nums text-slate-900">{usd(r.usd)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentActivity({ rows }: { rows: Overview["activity"] }) {
  return (
    <section className="glass-card p-5">
      <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
        Recent activity
        <Link href="/activity" className="ml-auto text-[14px] font-semibold text-sky-700 hover:underline">
          All →
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-[15px] text-slate-600">No activity yet.</div>
      ) : (
        <div className="mt-1.5">
          {rows.map((r, i) => (
            <div key={r.id} className={"flex gap-2.5 py-2.5 text-[14px] text-slate-700 " + (i ? "border-t border-slate-200" : "")}>
              <span className="w-16 shrink-0 text-slate-600">{relTime(r.at)}</span>
              <span className="min-w-0">
                {r.tenant_slug && <b className="font-semibold text-slate-900">{r.tenant_slug}</b>}
                {r.tenant_slug ? ": " : ""}
                {activityText(r.verb, r.detail)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
