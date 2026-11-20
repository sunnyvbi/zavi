"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BookingConfigConfirm } from "./BookingConfigConfirm";
import {
  MAX_SELECTED_METRICS,
  METRICS,
  MIN_COVERAGE_GAP_DAYS,
  MIN_SELECTED_METRICS,
  baselineFor,
  buildRows,
  clampSelection,
  coverageShortfallDays,
  defaultSelectionFor,
  fmtAxisDate,
  latestValue,
  missingDaysFor,
  stalenessDays,
  tileDomain,
  toChartRows,
  type ChartRow,
  type MetricDef,
  type MetricKey,
  type Row,
} from "./perfMarketerTrend";

export type TrendPoint = {
  date: string;
  spend_usd: number;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  maturing: boolean;
  bookings?: number;
  revenue_usd?: number;
};

export type DailySeries = {
  points: TrendPoint[];
  meta_truncated: boolean;
  channels: { meta: boolean; google: boolean };
};

export type BookingTrendState = "confirmed_money" | "unconfirmed" | "none";
export type BookingTrend = {
  state: BookingTrendState;
  points: Array<{
    date: string;
    bookings: number | null;
    revenue_usd: number | null;
    mer: number | null;
    cost_per_booking_usd: number | null;
  }>;
  currency: string | null;
  mer_available: boolean;
  refreshed_at: string | null;
};

type ViewMode = "tiles" | "overlay";

export function PerfMarketerTrendChart({
  series,
  booking,
  requestedEnd,
  channel,
}: {
  series: DailySeries;
  booking?: BookingTrend | null;
  requestedEnd?: string | null;
  channel?: "meta" | "google";
}) {
  const moneyOn = booking?.state === "confirmed_money" && (booking.points?.length ?? 0) > 0;
  const availableMetrics = useMemo(
    () =>
      METRICS.filter((m) => {
        if (!m.money) return true;
        if (!moneyOn) return false;
        if ((m.key === "mer" || m.key === "revenue_usd") && !booking?.mer_available) return false;
        return true;
      }),
    [moneyOn, booking?.mer_available],
  );

  const [wanted, setWanted] = useState<MetricKey[]>(() =>
    defaultSelectionFor(channel, availableMetrics),
  );
  const [view, setView] = useState<ViewMode>("tiles");

  const rows: Row[] = useMemo(
    () => buildRows(series.points, booking?.points ?? [], moneyOn),
    [series.points, booking?.points, moneyOn],
  );

  const selectedKeys = clampSelection(wanted, availableMetrics);
  const selected = new Set(selectedKeys);
  const selectedMetrics = availableMetrics.filter((m) => selected.has(m.key));
  const selectedKeysSig = selectedKeys.join(",");
  const atFloor = selectedKeys.length <= MIN_SELECTED_METRICS;
  const atCeiling = selectedKeys.length >= MAX_SELECTED_METRICS;

  const chartRows = useMemo(
    () => toChartRows(rows, selectedKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key list compared by value
    [rows, selectedKeysSig],
  );

  const maturingDates = rows.filter((r) => r.maturing).map((r) => r.date);
  const maturingStart = maturingDates[0] ?? null;
  const lastDate = rows.length ? rows[rows.length - 1].date : null;
  const staleDays = moneyOn ? stalenessDays(booking?.refreshed_at ?? null, lastDate) : 0;
  const missingMoneyDays = moneyOn ? missingDaysFor(rows, "bookings") : 0;
  const shortfallDays = coverageShortfallDays(lastDate, requestedEnd ?? null);
  const firstDate = rows.length ? rows[0].date : null;

  if (series.points.length < 2) {
    return (
      <section className="rounded-2xl border border-[#e5e7eb] bg-white px-[22px] py-4">
        <ChartHeader channels={series.channels} truncated={series.meta_truncated} booking={booking} />
        <p className="text-[13px] text-[#5f6368]">
          Not enough daily data yet to chart a trend for this window.
        </p>
      </section>
    );
  }

  const toggle = (key: MetricKey) => {
    if (selected.has(key)) {
      if (!atFloor) setWanted(selectedKeys.filter((k) => k !== key));
    } else if (!atCeiling) {
      setWanted([...selectedKeys, key]);
    }
  };

  return (
    <section className="rounded-2xl border border-[#e5e7eb] bg-white px-[22px] py-4">
      <ChartHeader channels={series.channels} truncated={series.meta_truncated} booking={booking} />

      {booking?.state === "unconfirmed" && <ConfirmBookingsAffordance />}

      <CoverageBanner
        shortfallDays={shortfallDays}
        firstDate={firstDate}
        lastDate={lastDate}
        requestedEnd={requestedEnd ?? null}
      />

      <DataHealthBanner
        staleDays={staleDays}
        refreshedAt={booking?.refreshed_at ?? null}
        missingDays={missingMoneyDays}
        totalDays={rows.length}
      />

      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        role="group"
        aria-label={`Chart metrics, pick ${MIN_SELECTED_METRICS} to ${MAX_SELECTED_METRICS}`}
      >
        {availableMetrics.map((m) => {
          const on = selected.has(m.key);
          const locked = on ? atFloor : atCeiling;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => toggle(m.key)}
              aria-pressed={on}
              aria-disabled={locked || undefined}
              title={
                locked
                  ? on
                    ? `Keep at least ${MIN_SELECTED_METRICS} metrics`
                    : `Up to ${MAX_SELECTED_METRICS} metrics at a time`
                  : undefined
              }
              className={`inline-flex items-center gap-2 rounded-full border py-1 pl-1.5 pr-2.5 text-[13px] transition-colors ${
                locked ? "cursor-not-allowed" : "cursor-pointer"
              } ${!on && locked ? "opacity-50" : ""} ${
                on ? "font-semibold text-[#1f1f1f]" : "border-[#e5e7eb] bg-white font-medium text-[#5f6368] hover:bg-[#fafafa]"
              }`}
              style={on ? { backgroundColor: `${m.color}1f`, borderColor: m.color } : undefined}
            >
              <span
                aria-hidden
                className="inline-block size-[7px] rounded-full"
                style={{ backgroundColor: on ? m.color : "#9aa0a6" }}
              />
              {m.label}
            </button>
          );
        })}

        <span className="text-[12px] text-[#6b7280]" aria-live="polite">
          {selectedKeys.length} of {MAX_SELECTED_METRICS}
        </span>

        <div
          className="ml-auto flex shrink-0 items-center rounded-full border border-[#e5e7eb] p-0.5"
          role="group"
          aria-label="Chart view"
        >
          {(
            [
              ["tiles", "Per metric"],
              ["overlay", "Overlay"],
            ] as Array<[ViewMode, string]>
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-pressed={view === mode}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-[13px] transition-colors ${
                view === mode
                  ? "bg-[#1f1f1f] font-semibold text-white"
                  : "font-medium text-[#5f6368] hover:bg-[#fafafa]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "tiles" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {selectedMetrics.map((m) => (
            <MetricTile
              key={m.key}
              metric={m}
              rows={rows}
              chartRows={chartRows}
              maturingStart={maturingStart}
              lastDate={lastDate}
            />
          ))}
        </div>
      ) : (
        <>
          <OverlayChart
            chartRows={chartRows}
            rows={rows}
            metrics={selectedMetrics}
            maturingStart={maturingStart}
            lastDate={lastDate}
          />
          <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Legend">
            {selectedMetrics.map((m) => (
              <li
                key={m.key}
                className="flex items-center gap-2 text-[13px] font-medium text-[#3c4043]"
              >
                <span
                  aria-hidden
                  className="inline-block h-0.5 w-3.5 rounded-full"
                  style={{ backgroundColor: m.color }}
                />
                {m.label}
              </li>
            ))}
          </ul>
        </>
      )}

      <Footnote
        view={view}
        rows={rows}
        metrics={selectedMetrics}
        moneyOn={moneyOn}
        maturingCount={maturingDates.length}
        snapshotIsStale={shortfallDays >= MIN_COVERAGE_GAP_DAYS}
      />
    </section>
  );
}

function MetricTile({
  metric,
  rows,
  chartRows,
  maturingStart,
  lastDate,
}: {
  metric: MetricDef;
  rows: Row[];
  chartRows: ChartRow[];
  maturingStart: string | null;
  lastDate: string | null;
}) {
  const values = rows
    .map((r) => r[metric.key])
    .filter((v): v is number => typeof v === "number");
  const domain = tileDomain(values, metric.kind);
  const latest = latestValue(rows, metric.key);
  const missing = missingDaysFor(rows, metric.key);

  return (
    <div className="rounded-xl border border-[#f0f0f0] px-3 pb-2 pt-2.5">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-[#3c4043]">
          <span
            aria-hidden
            className="inline-block size-[7px] rounded-full"
            style={{ backgroundColor: metric.color }}
          />
          {metric.label}
          {}
          {latest && (
            <span className="font-normal text-[#6b7280]">as of {fmtAxisDate(latest.date)}</span>
          )}
        </span>
        <span className="text-[14px] font-semibold text-[#0e0f11]">
          {latest ? metric.fmt(latest.value) : "-"}
        </span>
      </div>
      <div className="h-[74px]">
        {values.length === 0 ? (
          <div className="flex h-full items-center text-[12px] text-[#6b7280]">
            No data in this window
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <YAxis domain={domain} hide />
              <XAxis dataKey="date" hide />
              {maturingStart && lastDate && (
                <ReferenceArea
                  x1={maturingStart}
                  x2={lastDate}
                  fill="currentColor"
                  fillOpacity={0.04}
                  ifOverflow="extendDomain"
                />
              )}
              <Tooltip
                content={({ active, payload, label }) => (
                  <PointTooltip
                    active={active}
                    payload={payload}
                    label={label}
                    metrics={[metric]}
                    rows={rows}
                    showIndex={false}
                  />
                )}
              />
              <Line
                type="monotone"
                dataKey={`raw_${metric.key}`}
                name={metric.label}
                stroke={metric.color}
                strokeWidth={2}
                dot={{ r: 1.6, fill: metric.color, strokeWidth: 0 }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-0.5 flex items-baseline justify-between text-[12px] text-[#6b7280]">
        <span>{rows.length ? fmtAxisDate(rows[0].date) : ""}</span>
        {missing > 0 && (
          <span className="text-[#8a6414]">
            {missing} day{missing === 1 ? "" : "s"} missing
          </span>
        )}
        <span>{lastDate ? fmtAxisDate(lastDate) : ""}</span>
      </div>
    </div>
  );
}

function OverlayChart({
  chartRows,
  rows,
  metrics,
  maturingStart,
  lastDate,
}: {
  chartRows: ChartRow[];
  rows: Row[];
  metrics: MetricDef[];
  maturingStart: string | null;
  lastDate: string | null;
}) {
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartRows} margin={{ top: 8, right: 14, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={fmtAxisDate}
            tick={{ fill: "#6b7280", fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: "currentColor", strokeOpacity: 0.12 }}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "#6b7280", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={54}
            label={{
              value: "% of baseline",
              angle: -90,
              position: "insideLeft",
              style: { fill: "#6b7280", fontSize: 11.5, textAnchor: "middle" },
            }}
          />
          {maturingStart && lastDate && (
            <ReferenceArea
              x1={maturingStart}
              x2={lastDate}
              fill="currentColor"
              fillOpacity={0.04}
              ifOverflow="extendDomain"
            />
          )}
          <Tooltip
            content={({ active, payload, label }) => (
              <PointTooltip
                active={active}
                payload={payload}
                label={label}
                metrics={metrics}
                rows={rows}
                showIndex
              />
            )}
          />
          {metrics.map((m) => (
            <Line
              key={m.key}
              type="monotone"
              dataKey={`idx_${m.key}`}
              name={m.label}
              stroke={m.color}
              strokeWidth={2}
              dot={{ r: 1.6, fill: m.color, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartHeader({
  channels,
  truncated,
  booking,
}: {
  channels: { meta: boolean; google: boolean };
  truncated: boolean;
  booking?: BookingTrend | null;
}) {
  const parts: string[] = [];
  if (channels.meta) parts.push("Meta");
  if (channels.google) parts.push("Google");
  const label = parts.length ? parts.join(" + ") : "No channel";
  const money = booking?.state === "confirmed_money";
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
      <h3 className="text-[16px] font-semibold text-[#0e0f11]">Key metrics over time</h3>
      <span className="text-[13px] text-[#5f6368]">
        Spend {label}
        {money ? " · bookings from your DB" : ""}
        {truncated ? " · partial (hit data cap)" : ""}
      </span>
    </div>
  );
}

function CoverageBanner({
  shortfallDays,
  firstDate,
  lastDate,
  requestedEnd,
}: {
  shortfallDays: number;
  firstDate: string | null;
  lastDate: string | null;
  requestedEnd: string | null;
}) {
  if (shortfallDays < MIN_COVERAGE_GAP_DAYS || !firstDate || !lastDate || !requestedEnd) {
    return null;
  }
  return (
    <div className="mb-3 rounded-xl border border-[#e9dfca] bg-[#fbf7ee] px-3.5 py-2 text-[13px] text-[#6b5518]">
      <b className="text-[#5c4a12]">
        These numbers stop at {fmtAxisDate(lastDate)}, not {fmtAxisDate(requestedEnd)}.
      </b>{" "}
      You picked {fmtAxisDate(firstDate)}–{fmtAxisDate(requestedEnd)}, but your ad data
      hasn&apos;t refreshed in {shortfallDays} days, so the last {shortfallDays} days aren&apos;t
      here yet. Hit Refresh above to pull them.
    </div>
  );
}

function DataHealthBanner({
  staleDays,
  refreshedAt,
  missingDays,
  totalDays,
}: {
  staleDays: number;
  refreshedAt: string | null;
  missingDays: number;
  totalDays: number;
}) {
  if (staleDays <= 0 && missingDays <= 0) return null;
  const bits: string[] = [];
  if (staleDays > 0) {
    bits.push(
      `Your bookings data is ${staleDays} day${staleDays === 1 ? "" : "s"} behind this window${
        refreshedAt ? ` (last refreshed ${refreshedAt.slice(0, 10)})` : ""
      }.`,
    );
  }
  if (missingDays > 0) {
    bits.push(
      `${missingDays} of ${totalDays} days have no bookings data cached. Those days are drawn as gaps, not as zero.`,
    );
  }
  return (
    <div className="mb-3 rounded-xl border border-[#e9dfca] bg-[#fbf7ee] px-3.5 py-2 text-[13px] text-[#6b5518]">
      <b className="text-[#5c4a12]">Bookings &amp; revenue may be incomplete.</b> {bits.join(" ")}
    </div>
  );
}

function ConfirmBookingsAffordance() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 rounded-xl border border-[#e9dfca] bg-[#fbf7ee] px-3.5 py-2.5 text-[13px] text-[#7a6320]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <b className="text-[#5c4a12]">See your real bookings &amp; MER.</b> Confirm which table in
          your connected database holds completed bookings, and we&apos;ll chart true bookings,
          revenue, and marketing efficiency, not just ad-platform numbers.
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 cursor-pointer rounded-cta border border-[#d9c9a0] bg-white px-3 py-1 text-[12px] font-semibold text-[#5c4a12] transition-colors hover:bg-[#f3ead6]"
        >
          {open ? "Hide" : "Confirm now"}
        </button>
      </div>
      {open && (
        <div className="mt-3 border-t border-[#e9dfca] pt-3">
          <BookingConfigConfirm />
        </div>
      )}
    </div>
  );
}

function Footnote({
  view,
  rows,
  metrics,
  moneyOn,
  maturingCount,
  snapshotIsStale,
}: {
  view: ViewMode;
  rows: Row[];
  metrics: MetricDef[];
  moneyOn: boolean;
  maturingCount: number;
  snapshotIsStale: boolean;
}) {
  const shaded =
    maturingCount === 0
      ? ""
      : snapshotIsStale
        ? ` Shaded band = the last ${maturingCount} day${
            maturingCount === 1 ? "" : "s"
          } of this snapshot, which were still settling when it was taken.`
        : ` Shaded band = the last ${maturingCount} day${
            maturingCount === 1 ? "" : "s"
          } (conversions still settling).`;
  const sourceNote = moneyOn ? (
    <>
      {" "}
      Bookings &amp; revenue come from your own system (not ad-platform conversions);
      <b> MER = your revenue ÷ ad spend</b> (marketing efficiency, not attributed ROAS). Ad spend is
      counted in your ad account&apos;s timezone and bookings in your own, so one day can straddle
      the two by a few hours.
    </>
  ) : null;

  if (view === "tiles") {
    return (
      <p className="mt-3 text-[13px] leading-5 text-[#5f6368]">
        Every metric is on its own real scale: the numbers on each card are the actual values, not
        an index. Days with no data are left as gaps rather than joined up.
        {shaded}
        {sourceNote}
      </p>
    );
  }

  const anchors = metrics
    .map((m) => ({ m, base: baselineFor(rows, m.key) }))
    .filter((x): x is { m: MetricDef; base: { value: number; date: string } } => x.base != null);
  const distinct = [...new Set(anchors.map((a) => a.base.date))];
  const anchorNote =
    distinct.length === 0
      ? "No line has a non-zero day to index against in this window."
      : distinct.length === 1
        ? `Every line is 100 at ${fmtAxisDate(distinct[0])}.`
        : `Lines anchor on different days (each on its first non-zero day): ${anchors
            .map((a) => `${a.m.label} ${fmtAxisDate(a.base.date)}`)
            .join(", ")}.`;
  const ratioNote = metrics.some((m) => m.kind === "ratio")
    ? " CTR, CPC, CPM, MER and cost/booking are already ratios. Indexing them shows how the ratio MOVED, not the ratio itself. Switch to Per metric for their real values."
    : "";

  return (
    <p className="mt-3 text-[13px] leading-5 text-[#5f6368]">
      Relative movement only: each line is a percentage of its own baseline, so different-scale
      metrics fit one chart. {anchorNote} Hover for the real value.
      {ratioNote}
      {shaded}
      {sourceNote}
    </p>
  );
}

function PointTooltip({
  active,
  payload,
  label,
  metrics,
  rows,
  showIndex,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
  label?: string | number;
  metrics: MetricDef[];
  rows: Row[];
  showIndex: boolean;
}) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload as Record<string, unknown> | undefined;
  if (!datum) return null;
  const maturing = datum.maturing === true;
  const date = typeof datum.date === "string" ? datum.date : String(label ?? "");
  const row = rows.find((r) => r.date === date);
  return (
    <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12px] shadow-[0_2px_8px_rgba(25,25,25,.1)]">
      <div className="mb-1 font-semibold text-[#1f1f1f]">
        {date}
        {maturing && <span className="ml-1 font-normal text-[#b0821e]">· still settling</span>}
      </div>
      {metrics.map((m) => {
        const raw = datum[`raw_${m.key}`];
        const idx = datum[`idx_${m.key}`];
        const has = typeof raw === "number";
        const inputs = has && row && m.inputs ? m.inputs(row) : null;
        return (
          <div key={m.key} className="mt-0.5">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2 text-[#595959]">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: m.color }}
                />
                {m.label}
              </span>
              <span className="font-medium text-[#1f1f1f]">
                {has ? m.fmt(raw as number) : "no data"}
                {showIndex && typeof idx === "number" && (
                  <span className="ml-1.5 font-normal text-[#8a8a8a]">({idx}%)</span>
                )}
              </span>
            </div>
            {inputs && <div className="pl-3.5 text-[12px] text-[#6b7280]">{inputs}</div>}
          </div>
        );
      })}
    </div>
  );
}
