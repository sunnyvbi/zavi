"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

const RANGE_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number]["days"];

type Usage = {
  totalCredits: number;
  periodStart: string;
  periodEnd: string;
  daily: { date: string; credits: number }[];
};

type UsageState =
  | { status: "loading" }
  | { status: "ready"; data: Usage }
  | { status: "error" };

function fmtCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return `${n}`;
}

function fmtDayLabel(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function UsageDetailsView({
  onBack,
  showBack = false,
}: {
  onBack: () => void;
  showBack?: boolean;
}) {
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [remaining, setRemaining] = useState<number | null>(null);
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const rangeRef = useRef<HTMLDivElement>(null);
  const rangeLabel =
    RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? "Last 30 days";

  useEffect(() => {
    if (!rangeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rangeRef.current && !rangeRef.current.contains(e.target as Node)) {
        setRangeMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRangeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [rangeMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    setUsage({ status: "loading" });
    (async () => {
      try {
        const res = await apiFetch(`/api/billing/usage-breakdown?days=${rangeDays}`);
        if (cancelled) return;
        if (!res.ok) {
          setUsage({ status: "error" });
          return;
        }
        const j = (await res.json()) as {
          total_credits?: unknown;
          period_start?: unknown;
          period_end?: unknown;
          daily?: unknown;
        };
        const daily = Array.isArray(j.daily)
          ? j.daily.map((d) => {
              const o = d as { date?: unknown; credits?: unknown };
              return {
                date: typeof o.date === "string" ? o.date : "",
                credits: typeof o.credits === "number" ? o.credits : 0,
              };
            })
          : [];
        setUsage({
          status: "ready",
          data: {
            totalCredits: typeof j.total_credits === "number" ? j.total_credits : 0,
            periodStart: typeof j.period_start === "string" ? j.period_start : "",
            periodEnd: typeof j.period_end === "string" ? j.period_end : "",
            daily,
          },
        });
      } catch {
        if (!cancelled) setUsage({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rangeDays]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/billing/credits");
        if (cancelled || !res.ok) return;
        const j = (await res.json()) as { effective_available_display?: unknown };
        const n = j.effective_available_display;
        if (typeof n === "number" && Number.isFinite(n)) setRemaining(n);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const usageData = usage.status === "ready" ? usage.data : null;

  return (
    <div className="max-w-[992px] font-sans">
      {}
      <div className="flex items-start">
        {showBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Billing & Credits"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f9f9f9] text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
        </button>
        )}
        <div className={`flex flex-col gap-2 ${showBack ? "pl-[22px]" : ""}`}>
          <h2 className="text-[20px] font-semibold leading-[27px] tracking-[-0.44px] text-[#030303]">
            Usage details
          </h2>
          <p className="text-[16px] leading-5 text-[#595959]">
            Credits your workspace used, day by day
          </p>
        </div>
      </div>

      {}
      <div className={`${showBack ? "ml-[54px]" : ""} mt-6 flex flex-col gap-[21px] rounded-[16px] border border-[#f0f0f0] bg-white px-4 py-[19px]`}>
        {}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-[20px] font-semibold leading-[25px] text-[#030303]">
                {usage.status === "loading" ? (
                  <Skel className="h-5 w-40 align-middle" />
                ) : (
                  `${remaining !== null ? Math.round(remaining).toLocaleString("en-US") : "-"} credits left`
                )}
              </span>
              <span className="text-[12px] font-medium leading-4 text-[#595959]">
                Right now
              </span>
            </div>
            {}
            <div ref={rangeRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setRangeMenuOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={rangeMenuOpen}
                className="flex h-10 items-center justify-center gap-2 rounded-cta border border-[#f0f0f0] bg-white pl-5 pr-4 text-[16px] font-semibold text-[#1f1f1f] transition-colors hover:border-[#d8d8d8]"
              >
                {rangeLabel}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden className="text-[#1f1f1f]">
                  <path
                    d="M8 9l4-4 4 4M16 15l-4 4-4-4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {rangeMenuOpen && (
                <ul
                  role="listbox"
                  aria-label="Usage time range"
                  className="absolute right-0 top-[calc(100%+6px)] z-10 min-w-[160px] overflow-hidden rounded-[12px] border border-[#f0f0f0] bg-white py-1 shadow-[0_8px_24px_rgba(16,18,20,0.12)]"
                >
                  {RANGE_OPTIONS.map((opt) => {
                    const active = opt.days === rangeDays;
                    return (
                      <li key={opt.days}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                            setRangeDays(opt.days);
                            setRangeMenuOpen(false);
                          }}
                          className={`flex w-full items-center px-3.5 py-2.5 text-left text-[16px] font-medium transition-colors hover:bg-[#f9f9f9] ${
                            active ? "bg-[#f9f9f9] text-[#0e0f11]" : "text-[#1f1f1f]"
                          }`}
                        >
                          {opt.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          <div className="h-px w-full bg-[#f0f0f0]" />
        </div>

        {}
        {usage.status === "loading" ? (
          <div className="h-[220px] w-full animate-pulse rounded-[8px] bg-[#f3f3f3]" />
        ) : (
          <UsageBarChart daily={usageData?.daily ?? []} />
        )}

        <div className="h-px w-full bg-[#f0f0f0]" />

        {}
        <div className="flex flex-col gap-2 pt-4">
          <div className="flex items-center justify-between">
            <span className="text-[16px] font-semibold leading-5 text-[#030303]">
              {rangeLabel}
            </span>
            <span className="text-[16px] font-semibold leading-5 text-[#030303]">
              {usage.status === "loading" ? (
                <Skel className="h-4 w-20 align-middle" />
              ) : usageData ? (
                `${usageData.totalCredits.toLocaleString("en-US")} credits used`
              ) : (
                "- credits used"
              )}
            </span>
          </div>

          {usageData && usageData.totalCredits === 0 && (
            <p className="px-1 py-3 text-[13px] leading-5 text-[#9a9a9a]">
              No usage recorded in the last {rangeDays} days yet.
            </p>
          )}

          {usage.status === "error" && (
            <p className="px-1 pt-2 text-[13px] leading-5 text-[#cb2029]" role="alert">
              Couldn&rsquo;t load usage. Please try again.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const CHART_PLOT_H = 194;
const CHART_AXIS_W = 26;

function UsageBarChart({ daily }: { daily: { date: string; credits: number }[] }) {
  const series = daily.length > 0 ? daily : [];
  const rawMax = Math.max(0, ...series.map((d) => d.credits));
  const max = niceCeil(rawMax);
  const ticksTopDown = [max, Math.round((max * 2) / 3), Math.round(max / 3), 0];

  const n = series.length;
  const labelEvery = Math.max(1, Math.ceil(n / 14));

  return (
    <div className="w-full">
      <div className="flex" style={{ height: CHART_PLOT_H }}>
        {}
        <div
          className="flex flex-col justify-between pr-1.5 text-right"
          style={{ width: CHART_AXIS_W }}
        >
          {ticksTopDown.map((t, i) => (
            <span key={i} className="text-[11px] leading-none text-[#636363]">
              {t}
            </span>
          ))}
        </div>

        {}
        <div className="relative min-w-0 flex-1">
          {}
          {ticksTopDown.map((_, i) => (
            <div
              key={i}
              className="absolute inset-x-0 border-t border-dashed border-[#ededed]"
              style={{ top: `${(i / (ticksTopDown.length - 1)) * 100}%` }}
            />
          ))}
          {}
          <div className="absolute inset-0 flex items-end">
            {series.map((d, i) => {
              const pct = max === 0 ? 0 : Math.max(0, d.credits) / max;
              return (
                <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
                  {}
                  {d.credits > 0 && (
                    <div
                      className="w-[5px] rounded-full bg-brand"
                      style={{ height: `${Math.max(pct * 100, 0.8)}%` }}
                      title={`${fmtDayLabel(d.date)}: ${fmtCredits(d.credits)} credits`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {}
      <div className="relative mt-2 flex h-3" style={{ paddingLeft: CHART_AXIS_W }}>
        {series.map((d, i) => (
          <span key={i} className="relative min-w-0 flex-1">
            {(n - 1 - i) % labelEvery === 0 && (
              <span className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap text-[11px] leading-none text-[#636363]">
                {fmtDayLabel(d.date)}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 6;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / pow;
  const rung = [1, 2, 3, 4, 5, 6, 8, 10].find((r) => norm <= r) ?? 10;
  return rung * pow;
}

function Skel({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-block animate-pulse rounded bg-[#ececec] ${className}`} aria-hidden />
  );
}
