"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";
import { SITE_FUNCTIONS_TIMEOUT_MESSAGE, SITE_FUNCTIONS_TIMEOUT_MS, withDeadline } from "./SiteFunctionsSettings";
import { agoText } from "./siteDashboardFormat";

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export type SiteAnalyticsPayload = {
  state: "ready" | "no_database";
  range: { days: number; tz: string; from: string; to: string };
  total: number;
  previous_total: number;
  all_time: number;
  daily: Array<{ day: string; count: number }>;
  forms: Array<{
    collection: string;
    label: string;
    kind: "form" | "booking";
    count: number;
    previous: number;
    all_time: number;
    last_at: string | null;
  }>;
  traffic: SiteTrafficPayload;
};

export type SiteTrafficPayload = {
  visits: number;
  previous_visits: number;
  pageviews: number;
  conversion: number | null;
  daily: Array<{ day: string; visits: number; pageviews: number }>;
  pages: Array<{ path: string; pageviews: number; visits: number }>;
  sources: Array<{ source: string | null; visits: number }>;
};

export const ANALYTICS_TITLE = "Analytics";
export const ANALYTICS_INTRO = "Who visits your live site, where they come from, and what they send you.";
export const ANALYTICS_NOT_LIVE =
  "Publish your site to start counting. Visits, the pages people read and every form, booking and request they send will show up here.";
export const ANALYTICS_NO_VISITS = "No visits yet in this period. Share your site's address and they show up here within a minute.";
export const ANALYTICS_NO_FORMS_TITLE = "No forms on this site yet";
export const ANALYTICS_NO_FORMS =
  "Ask Zavi in the chat to add a contact form, a booking page or a quote request. Submissions show up here as they come in.";
export const ANALYTICS_FOOTNOTE =
  "Counted without cookies and without storing anyone's IP address. A visit is one person on one day. Submissions are the ones your site holds now, so one you delete drops out.";

type Load =
  | { phase: "loading" }
  | { phase: "ready"; data: SiteAnalyticsPayload }
  | { phase: "error"; message: string };

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function analyticsUrl(buildSessionId: string, days: AnalyticsRange, tz: string): string {
  const q = new URLSearchParams({ build_session_id: buildSessionId, days: String(days), tz });
  return `/api/website/site-analytics?${q.toString()}`;
}

export function conversionText(rate: number | null): string {
  if (rate === null) return "No visits yet";
  const pct = rate * 100;
  return pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function sourceLabel(source: string | null): string {
  if (!source) return "Direct";
  return source.replace(/^(?:www|m|l|lm)\./, "");
}

export function changeText(total: number, previous: number, days: number): string {
  const period = `the previous ${days} days`;
  if (total === previous) return total === 0 ? `None in ${period} either` : `Same as ${period}`;
  if (previous === 0) return `None in ${period}`;
  const diff = total - previous;
  return `${Math.abs(diff)} ${diff > 0 ? "more" : "fewer"} than ${period}`;
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function messageFor(status: number, body: { error?: { code?: string; message?: string } } | null): string {
  if (status === 409) return "Analytics are available on sites made with the new builder.";
  const m = body?.error?.message;
  return typeof m === "string" && m ? m : "We couldn't load your numbers. Try again.";
}

const card = "rounded-xl border border-[#f0f0f0] bg-white";
const btn = "inline-flex h-8 items-center rounded-cta border border-[#e5e5e5] px-3 text-[13px] font-medium text-[#0e0f11] hover:bg-[#f9f9f9] disabled:opacity-50";

function Shell({ children, range = 30, onRange }: { children: ReactNode; range?: AnalyticsRange; onRange?: ((r: AnalyticsRange) => void) | null }) {
  return (
    <div className="mx-auto flex max-w-[840px] flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">{ANALYTICS_TITLE}</h2>
          <p className="mt-0.5 max-w-[560px] text-[13px] text-[#8c8c8c]">{ANALYTICS_INTRO}</p>
        </div>
        {onRange !== null && (
          <div role="group" aria-label="Date range" className="flex shrink-0 rounded-cta border border-[#e5e5e5] p-0.5">
            {ANALYTICS_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={r === range}
                disabled={!onRange}
                onClick={() => onRange?.(r)}
                className={`h-7 rounded-cta px-2.5 text-[12px] font-medium transition-colors ${r === range ? "bg-[#0e0f11] text-white" : "text-[#595959] hover:bg-[#f4f4f4]"}`}
              >
                {r} days
              </button>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

export function SiteAnalyticsSkeleton({ range = 30, onRange }: { range?: AnalyticsRange; onRange?: (r: AnalyticsRange) => void } = {}) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading analytics" data-section-skeleton="analytics">
      <Shell range={range} onRange={onRange}>
        <div aria-hidden className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton-row className={`${card} p-4`}>
              <Skeleton className="h-3 w-24" delayMs={i * 120} />
              <Skeleton className="mt-3 h-7 w-16" delayMs={i * 120} />
              <Skeleton className="mt-2 h-3 w-40" delayMs={i * 120} />
            </div>
          ))}
        </div>
        <div aria-hidden data-skeleton-row className={`${card} p-4`}>
          <Skeleton className="h-[120px] w-full" delayMs={240} />
        </div>
      </Shell>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className={`${card} p-4`}>
      <p className="text-[12px] font-medium text-[#8c8c8c]">{label}</p>
      <p className="mt-1 text-[28px] font-semibold leading-9 tabular-nums text-[#0e0f11]">{value.toLocaleString()}</p>
      <p className="mt-0.5 text-[12px] text-[#595959]">{note}</p>
    </div>
  );
}

function DailyBars({ daily, title }: { daily: Array<{ day: string; count: number }>; title: string }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  const first = daily[0]?.day;
  const last = daily[daily.length - 1]?.day;
  return (
    <figure className={`${card} p-4`}>
      <figcaption className="text-[13px] font-medium text-[#0e0f11]">{title}</figcaption>
      <ol className="mt-3 flex h-[120px] items-end gap-[2px]" aria-label={title}>
        {daily.map((d) => (
          <li
            key={d.day}
            className="group relative flex h-full min-w-0 flex-1 items-end"
            aria-label={`${dayLabel(d.day)}: ${d.count}`}
            title={`${dayLabel(d.day)}: ${d.count}`}
          >
            <span
              className={`block w-full rounded-t-[3px] ${d.count > 0 ? "bg-[#0e0f11] group-hover:bg-[#454545]" : "bg-[#f0f0f0]"}`}
              style={{ height: d.count > 0 ? `${Math.max(6, (d.count / max) * 100)}%` : "3px" }}
            />
          </li>
        ))}
      </ol>
      {first && last && (
        <div aria-hidden className="mt-2 flex justify-between text-[11px] text-[#8c8c8c]">
          <span>{dayLabel(first)}</span>
          <span>{dayLabel(last)}</span>
        </div>
      )}
    </figure>
  );
}

function TopList({ title, rows, unit }: { title: string; rows: Array<{ key: string; label: string; value: number }>; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={card}>
      <p className="border-b border-[#f0f0f0] px-4 py-3 text-[13px] font-medium text-[#0e0f11]">{title}</p>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-[#8c8c8c]">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 p-2">
          {rows.map((r) => (
            <li key={r.key} className="relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-2 py-1.5 text-[13px]" aria-label={`${r.label}: ${r.value} ${unit}`}>
              <span aria-hidden className="absolute inset-y-0 left-0 rounded-md bg-[#f4f4f4]" style={{ width: `${(r.value / max) * 100}%` }} />
              <span className="relative min-w-0 truncate text-[#0e0f11]">{r.label}</span>
              <span className="relative shrink-0 tabular-nums text-[#595959]">{r.value.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SiteAnalyticsReady({
  data,
  deployedUrl,
  nowMs,
}: {
  data: SiteAnalyticsPayload;
  deployedUrl: string | null;
  nowMs: number;
}) {
  const days = data.range.days;
  const t = data.traffic;
  const hasForms = data.state !== "no_database" && data.forms.length > 0;
  const adminUrl = deployedUrl ? `${deployedUrl.replace(/\/+$/, "")}/admin` : null;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Visits" value={t.visits} note={changeText(t.visits, t.previous_visits, days)} />
        <Stat label="Page views" value={t.pageviews} note={t.visits > 0 ? `${(t.pageviews / t.visits).toFixed(1)} per visit` : "No visits yet"} />
        <Stat label="Submissions" value={data.total} note={changeText(data.total, data.previous_total, days)} />
        <div className={`${card} p-4`}>
          <p className="text-[12px] font-medium text-[#8c8c8c]">Conversion</p>
          <p className="mt-1 text-[28px] font-semibold leading-9 tabular-nums text-[#0e0f11]">{t.conversion === null ? "–" : conversionText(t.conversion)}</p>
          <p className="mt-0.5 text-[12px] text-[#595959]">{t.conversion === null ? "No visits yet" : "Submissions per visit"}</p>
        </div>
      </div>
      {t.visits === 0 ? (
        <div className={`${card} p-4 text-[13px] text-[#595959]`} data-analytics-empty="no-visits">{ANALYTICS_NO_VISITS}</div>
      ) : (
        <>
          <DailyBars title="Visits per day" daily={t.daily.map((d) => ({ day: d.day, count: d.visits }))} />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TopList title="Top pages" unit="page views" rows={t.pages.map((p) => ({ key: p.path, label: p.path, value: p.pageviews }))} />
            <TopList title="Where visits come from" unit="visits" rows={t.sources.map((x) => ({ key: x.source ?? "(direct)", label: sourceLabel(x.source), value: x.visits }))} />
          </div>
        </>
      )}
      {hasForms ? (
        <>
          {data.total > 0 && <DailyBars title="Submissions per day" daily={data.daily} />}
          <div className={card}>
            <div className="flex items-center justify-between gap-3 border-b border-[#f0f0f0] px-4 py-3">
              <p className="text-[13px] font-medium text-[#0e0f11]">By form</p>
              {adminUrl && (
                <a href={adminUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-[#0e0f11] underline-offset-2 hover:underline">
                  See the messages
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              )}
            </div>
            <ul className="divide-y divide-[#f0f0f0]">
              {data.forms.map((f) => (
                <li key={f.collection} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-[#0e0f11]">{f.label}</p>
                    <p className="text-[12px] text-[#8c8c8c]">
                      {f.kind === "booking" ? "Booking" : "Form"} · last one {agoText(f.last_at, nowMs).toLowerCase()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[15px] font-semibold tabular-nums text-[#0e0f11]">{f.count.toLocaleString()}</p>
                    <p className="text-[11px] text-[#8c8c8c]">{f.all_time.toLocaleString()} all time</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : (
        <div className={`${card} p-6 text-center`} data-analytics-empty="no-forms">
          <p className="text-[14px] font-semibold text-[#0e0f11]">{ANALYTICS_NO_FORMS_TITLE}</p>
          <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-5 text-[#595959]">{ANALYTICS_NO_FORMS}</p>
        </div>
      )}
      <p className="text-[12px] leading-5 text-[#8c8c8c]">{ANALYTICS_FOOTNOTE}</p>
    </>
  );
}

export function SiteAnalyticsView({ buildSessionId, deployedUrl }: { buildSessionId: string; deployedUrl: string | null }) {
  const [range, setRange] = useState<AnalyticsRange>(30);
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const live = !!deployedUrl;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const deadline = withDeadline(SITE_FUNCTIONS_TIMEOUT_MS);
    setLoad({ phase: "loading" });
    void (async () => {
      try {
        const res = await apiFetch(analyticsUrl(buildSessionId, range, browserTimeZone()), { signal: deadline.signal });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (deadline.timedOut()) setLoad({ phase: "error", message: SITE_FUNCTIONS_TIMEOUT_MESSAGE });
        else if (!res.ok) setLoad({ phase: "error", message: messageFor(res.status, body) });
        else setLoad({ phase: "ready", data: body as SiteAnalyticsPayload });
      } catch {
        if (!cancelled) setLoad({ phase: "error", message: deadline.timedOut() ? SITE_FUNCTIONS_TIMEOUT_MESSAGE : "We couldn't load your numbers. Try again." });
      } finally {
        deadline.dispose();
      }
    })();
    return () => {
      cancelled = true;
      deadline.dispose();
    };
  }, [buildSessionId, range, nonce, live]);

  if (!live) {
    return (
      <Shell onRange={null}>
        <div className={`${card} p-6 text-center`} data-analytics-empty="not-live">
          <p className="text-[14px] font-semibold text-[#0e0f11]">Not live yet</p>
          <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-5 text-[#595959]">{ANALYTICS_NOT_LIVE}</p>
        </div>
      </Shell>
    );
  }
  if (load.phase === "loading") return <SiteAnalyticsSkeleton range={range} onRange={setRange} />;
  return (
    <Shell range={range} onRange={setRange}>
      {load.phase === "error" ? (
        <div role="alert" className="rounded-xl border border-[#f5c2c0] bg-[#fdf3f2] p-4 text-[13px] text-[#a8332c]">
          <p>{load.message}</p>
          <button type="button" className={`${btn} mt-3`} onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <SiteAnalyticsReady data={load.data} deployedUrl={deployedUrl} nowMs={Date.now()} />
      )}
    </Shell>
  );
}
