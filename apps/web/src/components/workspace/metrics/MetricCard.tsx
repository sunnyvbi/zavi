"use client";

import { AccountMetricCard } from "./AccountMetricCard";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { formatMetricValue, humanizeMetricKey, metricDelta } from "./format";

const tileShape = "rounded-2xl bg-cream px-4 py-3 [container-type:inline-size]";

export const metricTileClass = `${tileShape} border border-rule`;

export type TileSelect = {
  selected: boolean;
  onSelect: () => void;
  controls: string;
  mode?: "tab" | "disclosure";
};

function Tile({
  metricKey,
  extraClass,
  select,
  children,
}: {
  metricKey: string;
  extraClass?: string;
  select?: TileSelect;
  children: ReactNode;
}) {
  const extra = extraClass ? ` ${extraClass}` : "";
  if (!select) {
    return (
      <div className={`${metricTileClass}${extra}`} data-metric={metricKey}>
        {children}
      </div>
    );
  }
  const edge = select.selected
    ? "border-ink compact:border-ink/30 compact:bg-bone"
    : "border-rule hover:border-ink/40 compact:hover:border-ink/20 hover:bg-creamDeep";
  return (
    <button
      type="button"
      {...(select.mode === "disclosure"
        ? { "aria-expanded": select.selected, "aria-controls": select.selected ? select.controls : undefined }
        : { role: "tab", "aria-selected": select.selected, "aria-controls": select.controls })}
      onClick={select.onSelect}
      data-metric={metricKey}
      className={`${tileShape} border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-cream ${edge}${extra}`}
    >
      {children}
    </button>
  );
}

function shortDay(ymd: string | null): string | null {
  if (!ymd) return null;
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function Unverified() {
  return (
    <span
      data-testid="metric-unverified"
      title="Zavi could not match this number to what it read from the platform on this run."
      className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[12px] font-medium text-amber-600"
    >
      unverified
    </span>
  );
}

export function MetricCard({
  metric: m,
  label,
  icon: Icon,
  variant = "compact",
  sub,
  select,
}: {
  metric: ChannelMetric;
  label?: string;
  icon?: LucideIcon;
  variant?: "compact" | "detail" | "account" | "score";
  sub?: string;
  select?: TileSelect;
}) {
  const delta = metricDelta(m);
  const name = label ?? humanizeMetricKey(m.key);
  const deltaTone = delta ? (delta.good ? "text-emerald-600" : "text-red-500") : "";

  if (variant === "account") return <AccountMetricCard metricKey={m.key} tone={m.unmeasured ? undefined : m.tone} icon={Icon} label={name} value={m.unmeasured ? "-" : formatMetricValue(m)} select={select} help={<>{m.unmeasured === true ? null : m.unmeasured ?? sub ?? m.note}{!m.grounded && !m.unmeasured && <span className="block">unverified</span>}{delta && <span className="block">{delta.text}</span>}</>} />;

  if (variant === "score") {
    const scale = m.unmeasured ? undefined : m.outOf;
    const caption = captionOf(m, sub ?? m.note);
    return (
      <Tile metricKey={m.key} select={select} extraClass="flex min-h-[172px] flex-col !p-5">
        <div data-metric-head="" className="flex items-center gap-2.5">
          {Icon && (
            <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-rule">
              <Icon className="size-4 text-ca-secondary" aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1 text-ca-label font-medium text-ca-xdark">{name}</span>
          {!m.grounded && !m.unmeasured && <Unverified />}
        </div>
        <div data-metric-value-row="" className="mt-4 flex min-w-0 items-baseline gap-1.5">
          <span
            data-testid={`value-${m.key}`}
            className={`text-[32px] font-bold leading-10 tabular-nums ${m.unmeasured ? "text-inkMuted/60" : m.tone ? TONE_TEXT[m.tone] : "text-ink"}`}
          >
            {m.unmeasured ? "-" : formatMetricValue(m)}
          </span>
          {scale && (
            <span className="text-ca-title text-ca-secondary">
              {scale.of ? `of ${scale.max}` : `/${scale.max}`}
              {scale.tail ? ` ${scale.tail}` : ""}
            </span>
          )}
          {delta && !m.unmeasured && (
            <span
              data-testid={`delta-${m.key}`}
              data-good={String(delta.good)}
              className={`ml-auto text-ca-action font-medium ${deltaTone}`}
            >
              {delta.text}
            </span>
          )}
        </div>
        {scale && <ScoreBar metric={m} track="mt-3 h-2" fills={TONE_FILL} />}
        {caption && <p className="mt-auto pt-3 text-ca-action text-ca-secondary">{caption}</p>}
      </Tile>
    );
  }

  if (variant === "detail") {
    const prevDay = shortDay(m.prev_day);
    const subText =
      m.unmeasured === true
        ? null
        : (m.unmeasured ??
          sub ??
          m.note ??
          (m.prev_value !== null && m.prev_value !== undefined
            ? `Previous run${prevDay ? ` (${prevDay})` : ""}: ${formatMetricValue({ value: m.prev_value, unit: m.unit })}`
            : "No earlier run to compare"));
    return (
      <Tile metricKey={m.key} extraClass="flex flex-col" select={select}>
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-inkSoft" aria-hidden />}
          <span className="min-w-0 flex-1 text-[16px] font-semibold leading-tight text-inkSoft">{name}</span>
          {!m.grounded && !m.unmeasured && <Unverified />}
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
          <p
            data-testid={`value-${m.key}`}
            className={`whitespace-nowrap text-[26px] font-bold tabular-nums ${m.unmeasured ? "text-inkMuted/60" : m.tone ? TONE_TEXT[m.tone] : "text-ink"}`}
          >
            {m.unmeasured ? "-" : formatMetricValue(m)}
          </p>
          {delta && (
            <span
              data-testid={`delta-${m.key}`}
              data-good={String(delta.good)}
              className={`rounded-md px-2 py-0.5 text-[13px] font-medium ${delta.good ? "bg-emerald-500/15 text-emerald-600" : "bg-red-500/15 text-red-500"}`}
            >
              {delta.direction === "up" ? "▲" : "▼"} {delta.text.replace(/^[+-]/, "")}
            </span>
          )}
        </div>
        <p className="mt-auto pt-3 text-[13px] leading-snug text-inkMuted">{subText}</p>
      </Tile>
    );
  }

  const quiet = m.value === 0 || m.value === null || m.value === undefined;
  const scored = !m.unmeasured && (m.outOf || m.tone || m.note);
  if (m.unmeasured || scored) {
    return (
      <Tile metricKey={m.key} select={select} extraClass="flex flex-col">
        <div data-metric-head="" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex min-w-0 flex-[1_1_auto] items-center gap-2">
            {Icon && (
              <Icon
                className="h-[18px] w-[18px] shrink-0 text-inkSoft compact:h-[15px] compact:w-[15px] [@container(max-width:96px)]:hidden"
                aria-hidden
              />
            )}
            <span className="min-w-0 text-[14px] font-semibold leading-tight text-ink break-normal [hyphens:none] [@container(max-width:120px)]:text-[13px] compact:text-[13px] compact:font-medium">
              {name}
            </span>
          </span>
          {!m.grounded && !m.unmeasured && <Unverified />}
        </div>
        {}
        <div data-metric-value-row="" className="mt-auto flex min-w-0 items-baseline gap-2">
          <ScoredValue metric={m} />
          {delta && !m.unmeasured && (
            <span
              data-testid={`delta-${m.key}`}
              data-good={String(delta.good)}
              className={`ml-auto text-[16px] font-medium compact:text-[13px] ${deltaTone}`}
            >
              {delta.text}
            </span>
          )}
        </div>
        {m.outOf && !m.unmeasured && <ScoreBar metric={m} />}
        {captionOf(m, m.note) && <p className="mt-2 text-[13px] leading-snug text-inkMuted">{captionOf(m, m.note)}</p>}
      </Tile>
    );
  }
  return (
    <Tile metricKey={m.key} select={select} extraClass="flex flex-col">
      <div className="flex items-center gap-2">
        {Icon && (
          <Icon
            className="h-[18px] w-[18px] shrink-0 text-inkSoft compact:h-[15px] compact:w-[15px] [@container(max-width:96px)]:hidden"
            aria-hidden
          />
        )}
        <span
          className={`min-w-0 flex-1 break-normal [hyphens:none] text-[14px] font-semibold leading-tight text-ink [@container(max-width:120px)]:text-[13px] compact:line-clamp-2 compact:text-[13px] compact:font-medium ${select?.selected ? "" : "compact:text-inkMuted"}`}
        >
          {name}
        </span>
        {!m.grounded && !m.unmeasured && <Unverified />}
      </div>
      <div data-metric-value-row="" className="mt-auto flex min-w-0 items-baseline gap-2 pt-1.5 compact:pt-2">
        <p
          className={`min-w-0 truncate text-[22px] font-bold tabular-nums text-ink compact:font-semibold ${quiet ? "compact:text-inkMuted" : ""}`}
        >
          {formatMetricValue(m)}
        </p>
        {delta && (
          <span data-testid={`delta-${m.key}`} data-good={String(delta.good)} className={`ml-auto text-[16px] font-medium compact:text-[13px] ${deltaTone}`}>
            {delta.text}
          </span>
        )}
      </div>
    </Tile>
  );
}

const captionOf = (m: ChannelMetric, fallback: string | undefined): string | undefined => (m.unmeasured === true ? undefined : (m.unmeasured ?? fallback));
const TONE_TEXT = { good: "text-success", warn: "text-warn", bad: "text-danger" } as const;
const TONE_BAR = { good: "bg-success", warn: "bg-amber-500", bad: "bg-danger" } as const;
const TONE_FILL = { good: "bg-success", warn: "bg-warn", bad: "bg-danger" } as const;

function ScoredValue({ metric: m }: { metric: ChannelMetric }) {
  if (m.unmeasured) {
    return <p className="mt-1.5 text-[22px] font-bold text-inkMuted/60">-</p>;
  }
  const tone = m.tone ? TONE_TEXT[m.tone] : "text-ink";
  const out = m.outOf;
  return (
    <p className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-1">
      <span data-testid={`value-${m.key}`} className={`text-[22px] font-bold tabular-nums ${tone}`}>
        {formatMetricValue(m)}
      </span>
      {out && (
        <span className="text-[13px] font-semibold text-inkMuted">
          {out.of ? `of ${out.max}` : `/${out.max}`}
          {out.tail ? ` ${out.tail}` : ""}
        </span>
      )}
    </p>
  );
}

function ScoreBar({ metric: m, track = "mt-2 h-1.5", fills = TONE_BAR }: { metric: ChannelMetric; track?: string; fills?: Record<NonNullable<ChannelMetric["tone"]>, string> }) {
  const max = m.outOf?.max ?? 0;
  const pct = max > 0 && Number.isFinite(m.value) ? Math.max(0, Math.min(100, (m.value / max) * 100)) : 0;
  return (
    <div className={`${track} w-full overflow-hidden rounded-full bg-bone`} aria-hidden>
      <div
        className={`h-full rounded-full ${m.tone ? fills[m.tone] : "bg-ink/30"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function PacingCard({ metric: m, label = "Spend vs budget", icon: Icon, sub }: { metric: ChannelMetric; label?: string; icon?: LucideIcon; sub?: string }) {
  const pctValue = Number.isFinite(m.value) ? m.value : 0;
  const width = Math.max(0, Math.min(100, pctValue));
  return (
    <div className={`${metricTileClass} flex flex-col`} data-metric={m.key}>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-inkSoft" aria-hidden />}
        <span className="min-w-0 flex-1 text-[16px] font-semibold leading-tight text-inkSoft">{label}</span>
        {!m.grounded && !m.unmeasured && <Unverified />}
      </div>
      {}
      <p
        data-testid={`value-${m.key}`}
        className={`mt-1.5 whitespace-nowrap text-[26px] font-bold tabular-nums ${m.unmeasured ? "text-inkMuted/60" : m.tone ? TONE_TEXT[m.tone] : "text-ink"}`}
      >
        {}
        {m.unmeasured ? "-" : `${Math.round(pctValue)}%`}
      </p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bone"
        role="progressbar"
        aria-valuenow={Math.round(pctValue)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full ${m.tone ? TONE_BAR[m.tone] : pctValue > 110 ? "bg-red-500" : "bg-amber-500"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      {captionOf(m, sub ?? m.note) && <p className="mt-2 text-[13px] leading-snug text-inkMuted">{captionOf(m, sub ?? m.note)}</p>}
    </div>
  );
}
