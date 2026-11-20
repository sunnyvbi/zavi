"use client";

import type { DailySeries } from "./PerfMarketerTrendChart";

export type KpiDelta = { text: string; good: boolean };
export type KpiCard = { label: string; value: string; delta: KpiDelta | null };

type Totals = {
  spend_usd: number;
  conversions: number;
  roas: number | null;
  cpa_usd: number | null;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
};

type HalfSums = {
  spend: number;
  impressions: number;
  clicks: number;
  bookings: number;
  revenue: number;
};

const MIN_DELTA_POINTS = 4;

function sumHalf(points: DailySeries["points"], from: number, to: number): HalfSums {
  const out: HalfSums = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    bookings: 0,
    revenue: 0,
  };
  for (let i = from; i < to; i++) {
    const p = points[i];
    out.spend += p.spend_usd;
    out.impressions += p.impressions;
    out.clicks += p.clicks;
    out.bookings += p.bookings ?? 0;
    out.revenue += p.revenue_usd ?? 0;
  }
  return out;
}

function pctChange(prev: number, cur: number): number | null {
  if (!(prev > 0)) return null;
  return ((cur - prev) / prev) * 100;
}

function fmtPctDelta(n: number | null, higherIsBetter: boolean): KpiDelta | null {
  if (n === null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 10) / 10;
  if (rounded === 0) return { text: "±0%", good: true };
  const sign = rounded > 0 ? "+" : "−";
  return {
    text: `${sign}${Math.abs(rounded).toFixed(1)}%`,
    good: rounded > 0 === higherIsBetter,
  };
}

function fmtPointDelta(n: number | null, higherIsBetter: boolean): KpiDelta | null {
  if (n === null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return { text: "±0.00", good: true };
  const sign = rounded > 0 ? "+" : "−";
  return {
    text: `${sign}${Math.abs(rounded).toFixed(2)}`,
    good: rounded > 0 === higherIsBetter,
  };
}

export type HalfDeltas = {
  spend: KpiDelta | null;
  impressions: KpiDelta | null;
  clicks: KpiDelta | null;
  ctr: KpiDelta | null;
  cpc: KpiDelta | null;
  cpm: KpiDelta | null;
  bookings: KpiDelta | null;
  cac: KpiDelta | null;
  roas: KpiDelta | null;
  convRate: KpiDelta | null;
};

export function computeHalfDeltas(series: DailySeries | null | undefined): HalfDeltas {
  const none: HalfDeltas = {
    spend: null,
    impressions: null,
    clicks: null,
    ctr: null,
    cpc: null,
    cpm: null,
    bookings: null,
    cac: null,
    roas: null,
    convRate: null,
  };
  const points = series?.points ?? [];
  if (points.length < MIN_DELTA_POINTS) return none;
  const mid = Math.floor(points.length / 2);
  const a = sumHalf(points, 0, mid);
  const b = sumHalf(points, mid, points.length);
  const ctrA = a.impressions > 0 ? (a.clicks / a.impressions) * 100 : null;
  const ctrB = b.impressions > 0 ? (b.clicks / b.impressions) * 100 : null;
  const cpcA = a.clicks > 0 ? a.spend / a.clicks : null;
  const cpcB = b.clicks > 0 ? b.spend / b.clicks : null;
  const cpmA = a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null;
  const cpmB = b.impressions > 0 ? (b.spend / b.impressions) * 1000 : null;
  const cacA = a.bookings > 0 ? a.spend / a.bookings : null;
  const cacB = b.bookings > 0 ? b.spend / b.bookings : null;
  const roasA = a.spend > 0 ? a.revenue / a.spend : null;
  const roasB = b.spend > 0 ? b.revenue / b.spend : null;
  const crA = a.clicks > 0 ? (a.bookings / a.clicks) * 100 : null;
  const crB = b.clicks > 0 ? (b.bookings / b.clicks) * 100 : null;
  return {
    spend: fmtPctDelta(pctChange(a.spend, b.spend), true),
    impressions: fmtPctDelta(pctChange(a.impressions, b.impressions), true),
    clicks: fmtPctDelta(pctChange(a.clicks, b.clicks), true),
    ctr:
      ctrA !== null && ctrB !== null
        ? fmtPointDelta(ctrB - ctrA, true)
        : null,
    cpc:
      cpcA !== null && cpcB !== null
        ? fmtPctDelta(pctChange(cpcA, cpcB), false)
        : null,
    cpm:
      cpmA !== null && cpmB !== null
        ? fmtPctDelta(pctChange(cpmA, cpmB), false)
        : null,
    bookings: fmtPctDelta(pctChange(a.bookings, b.bookings), true),
    cac:
      cacA !== null && cacB !== null
        ? fmtPctDelta(pctChange(cacA, cacB), false)
        : null,
    roas:
      roasA !== null && roasB !== null
        ? fmtPointDelta(roasB - roasA, true)
        : null,
    convRate:
      crA !== null && crB !== null ? fmtPointDelta(crB - crA, true) : null,
  };
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function money2(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
export function compactCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n < 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}
function pctValue(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${n.toFixed(2)}%`;
}
function ratioValue(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${n.toFixed(2)}×`;
}

export function buildChannelKpiCards(
  channel: "meta" | "google" | undefined,
  totals: Totals,
  deltas: HalfDeltas,
): KpiCard[] {
  const convRate =
    totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : null;
  const common: KpiCard[] = [
    { label: "Amount spent", value: money(totals.spend_usd), delta: deltas.spend },
    {
      label: "Bookings",
      value: compactCount(totals.conversions),
      delta: deltas.bookings,
    },
    { label: "CAC", value: money(totals.cpa_usd), delta: deltas.cac },
    { label: "ROAS (all)", value: ratioValue(totals.roas), delta: deltas.roas },
  ];
  if (channel === "google") {
    return [
      ...common,
      { label: "Clicks", value: compactCount(totals.clicks), delta: deltas.clicks },
      { label: "Avg. CPC", value: money2(totals.cpc_usd), delta: deltas.cpc },
      {
        label: "Impressions",
        value: compactCount(totals.impressions),
        delta: deltas.impressions,
      },
      { label: "Conv. rate", value: pctValue(convRate), delta: deltas.convRate },
    ];
  }
  return [
    ...common,
    { label: "Clicks", value: compactCount(totals.clicks), delta: deltas.clicks },
    {
      label: "Impressions",
      value: compactCount(totals.impressions),
      delta: deltas.impressions,
    },
    { label: "CTR", value: pctValue(totals.ctr_percent), delta: deltas.ctr },
    { label: "CPM", value: money2(totals.cpm_usd), delta: deltas.cpm },
  ];
}

export function ChannelKpiCards({
  channel,
  windowLabel,
  totals,
  series,
  statusLabel,
}: {
  channel?: "meta" | "google";
  windowLabel: string;
  totals: Totals;
  series: DailySeries | null | undefined;
  statusLabel?: string;
}) {
  const deltas = computeHalfDeltas(series);
  const cards = buildChannelKpiCards(channel, totals, deltas);
  const title = windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
          {title}
        </h3>
        {statusLabel && (
          <span className="shrink-0 text-[13px] text-[#5f6368]">
            {statusLabel}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="flex min-w-0 flex-col gap-1 rounded-2xl border border-[#f0f0f0] px-3.5 py-3"
          >
            <span className="truncate text-[13px] font-medium text-[#5f6368]">
              {c.label}
            </span>
            <span
              className={`truncate font-semibold leading-7 tracking-tight text-[#0e0f11] tabular-nums ${
                c.value.length > 8
                  ? "text-[14px]"
                  : c.value.length > 6
                    ? "text-[16px]"
                    : "text-[20px]"
              }`}
            >
              {c.value}
            </span>
            {c.delta ? (
              <span
                title="Second half of this range vs first half"
                className={`text-[13px] font-medium ${c.delta.good ? "text-[#167f50]" : "text-[#cb2029]"
                  }`}
              >
                {c.delta.text}
              </span>
            ) : (
              <span aria-hidden className="text-[13px]">
                &nbsp;
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
