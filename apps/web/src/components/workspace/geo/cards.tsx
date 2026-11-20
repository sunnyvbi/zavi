"use client";

import { useState, type ReactNode } from "react";
import {
  type LucideIcon,
  AtSign,
  Bot,
  Braces,
  CalendarDays,
  Check,
  ChevronDown,
  ChartPie,
  Code2,
  FileText,
  Gauge,
  Globe,
  Hash,
  Heading,
  History,
  Link2,
  ListChecks,
  Sparkles,
  TextQuote,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";
import { DomainIcon, EngineLogo } from "./logos";
import {
  BOT_CLASS_LABEL,
  BOT_CLASS_ORDER,
  blockedBots,
  checklistOf,
  crawlerSeries,
  dayLabel,
  dayOfMonth,
  deltaView,
  pctOf,
  progressRowsOf,
  siteFilesOf,
  sourceGroupsOf,
  type CheckKey,
  type CheckStatus,
  type CrawlerView,
  type DeltaView,
  type ProgressKey,
} from "./derive";
import type {
  BotClass,
  CrawlerHitsPanel,
  DeltaOr,
  ReadinessLane,
  VisibilityPanel,
} from "./types";

type Icon = LucideIcon;

export const GEO_CARD = "rounded-2xl border border-rule bg-white p-4";

export function CardTitle({
  icon: IconEl,
  children,
  right,
  sub,
}: {
  icon: Icon;
  children: ReactNode;
  right?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-[16px] font-semibold tracking-tight text-ink">
          <IconEl className="h-[18px] w-[18px] shrink-0 text-inkSoft" aria-hidden />
          {children}
        </h3>
        {sub ? <p className="mt-0.5 text-[13px] leading-5 text-inkMuted">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function CardNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-xl border border-dashed border-rule px-3 py-2.5 text-[13px] leading-[1.5] text-inkMuted">
      {children}
    </p>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cx(GEO_CARD, "min-h-[180px]", className)}>
      <div className="h-4 w-1/3 animate-pulse rounded bg-bone motion-reduce:animate-none" />
      <div className="mt-4 h-8 w-1/4 animate-pulse rounded bg-bone motion-reduce:animate-none" />
      <div className="mt-4 h-3 w-5/6 animate-pulse rounded bg-bone motion-reduce:animate-none" />
      <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-bone motion-reduce:animate-none" />
    </div>
  );
}

const CHIP_TONE: Record<DeltaView["tone"], string> = {
  up: "bg-successBg text-success",
  down: "bg-dangerBg text-danger",
  flat: "bg-bone text-inkMuted",
  note: "bg-bone text-inkMuted",
};

export function DeltaChip({ view }: { view: DeltaView | null }) {
  if (!view) return null;
  return (
    <span
      title={view.title}
      className={cx(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[13px] font-semibold tabular-nums",
        CHIP_TONE[view.tone],
      )}
    >
      {view.text}
      <span className="sr-only">. {view.title}</span>
    </span>
  );
}

export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-0.5 rounded-full bg-bone p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none",
              on ? "bg-white text-ink shadow-elev" : "text-inkMuted hover:text-ink",
              FOCUS_RING,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const RING_TONE = {
  blue: "#2563eb",
  good: "#167F50",
  warn: "#946300",
  bad: "#CB2029",
  none: "transparent",
} as const;

export function Ring({
  value,
  tone,
  size = 56,
}: {
  value: number | null;
  tone: keyof typeof RING_TONE;
  size?: number;
}) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={6} className="stroke-bone" />
      {value !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={RING_TONE[tone]}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-ink text-[14px] font-bold"
      >
        {value === null ? "-" : Math.round(value)}
      </text>
    </svg>
  );
}

function Bar({ value, fill }: { value: number | null; fill: string }) {
  return (
    <span aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bone">
      {value !== null && (
        <span
          className={cx("block h-full rounded-full", fill)}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      )}
    </span>
  );
}

const scoreFill = (score: number) =>
  score >= 70 ? "bg-success" : score >= 40 ? "bg-warn" : "bg-danger";

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <span aria-hidden className="block h-8" />;
  }
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = 120 / (points.length - 1);
  const coords = points
    .map((p, i) => `${(i * step).toFixed(1)},${(32 - ((p - min) / span) * 26 - 3).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 120 32" preserveAspectRatio="none" className="block h-8 w-full" aria-hidden>
      <polyline
        points={coords}
        fill="none"
        stroke="#2563eb"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function KpiCard({
  icon: IconEl,
  label,
  value,
  delta,
  sub,
}: {
  icon: Icon;
  label: string;
  value: string;
  delta?: DeltaOr | null;
  sub: string | null;
}) {
  return (
    <div className="rounded-2xl border border-rule bg-white px-4 py-3">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-inkMuted">
        <IconEl className="h-4 w-4 shrink-0 text-inkSoft" aria-hidden />
        {label}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-[26px] font-bold leading-9 tracking-tight text-ink tabular-nums">{value}</span>
        <DeltaChip view={deltaView(delta)} />
      </div>
      {sub ? <p className="text-[12px] leading-4 text-inkMuted">{sub}</p> : null}
    </div>
  );
}

export function VisibilityKpis({ panel }: { panel: VisibilityPanel | null }) {
  const m = panel?.metrics ?? null;
  const band = (margin: number | null, n: number) =>
    margin === null ? null : `±${margin} pts · ${n.toLocaleString()} answers`;
  const sov = m?.share_of_voice;
  const sovSub = !sov
    ? null
    : sov.state === "no_rivals"
      ? "Add rivals to measure this"
      : sov.state === "no_mentions"
        ? "No brand or rival named yet"
        : `${sov.brand_mentions} of ${sov.brand_mentions + sov.rival_mentions} brand mentions`;
  return (
    <>
      <KpiCard
        icon={AtSign}
        label="Mention rate"
        value={pctOf(m?.mention_rate.rate)}
        delta={panel?.deltas.mention_rate}
        sub={m ? band(m.mention_rate.margin_pp, m.mention_rate.denominator) : null}
      />
      <KpiCard
        icon={Link2}
        label="Citation rate"
        value={pctOf(m?.citation_rate.rate)}
        delta={panel?.deltas.citation_rate}
        sub={m ? band(m.citation_rate.margin_pp, m.citation_rate.denominator) : null}
      />
      <KpiCard
        icon={Users}
        label="Share of voice"
        value={pctOf(sov?.share)}
        delta={panel?.deltas.share_of_voice}
        sub={sovSub}
      />
    </>
  );
}

const CLASS_COLOR: Record<BotClass, string> = {
  search: "#1a8f5c",
  user: "#0f766e",
  training: "#e0653a",
};

const STACK_TOP_DOWN: readonly BotClass[] = ["training", "user", "search"];

const VIEW_OPTIONS = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
] as const;

export function CrawlerHitsCard({
  panel,
  view,
  onView,
}: {
  panel: CrawlerHitsPanel;
  view: CrawlerView;
  onView: (v: CrawlerView) => void;
}) {
  const series = panel.state === "ok" ? crawlerSeries(panel, view) : null;
  const blocked = blockedBots(panel).slice(0, 3);
  const callouts = panel.bots.map((b) => b.callout).filter((c): c is string => Boolean(c));

  let body: ReactNode;
  if (panel.state === "not_connected") {
    body = (
      <CardNote>
        Counted from your site&apos;s own logs, so nothing shows until they are
        connected. Connecting takes a Cloudflare Worker and a log token that a
        workspace admin creates.
      </CardNote>
    );
  } else if (panel.state === "awaiting_logs") {
    body = (
      <CardNote>
        Logs are connected and Zavi is waiting for the first batch. The chart
        fills in after the first AI bot visits a page.
      </CardNote>
    );
  } else if (!series) {
    body = <CardNote>This window has fewer days of logs than the chart needs.</CardNote>;
  } else {
    const max = Math.max(1, ...series.days.map((d) => d.hits));
    const labelEvery = view === 7 ? 1 : view === 14 ? 2 : 5;
    const classTotals = BOT_CLASS_ORDER.map((c) => ({
      c,
      n: series.days.reduce((s, d) => s + d.by_class[c], 0),
    }));
    body = (
      <>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[26px] font-bold leading-9 text-ink tabular-nums">
            {series.total.toLocaleString()}
          </span>
          {series.change?.kind === "pct" && (
            <DeltaChip
              view={{
                text: `${series.change.pct > 0 ? "▲" : series.change.pct < 0 ? "▼" : ""} ${Math.abs(series.change.pct)}%`.trim(),
                tone: series.change.pct > 0 ? "up" : series.change.pct < 0 ? "down" : "flat",
                title: `Versus the ${view} days before.`,
              }}
            />
          )}
          {series.change?.kind === "new" && (
            <DeltaChip view={{ text: "New", tone: "up", title: `No hits in the ${view} days before.` }} />
          )}
        </div>
        <p className="mt-1 text-[13px] leading-5 text-inkMuted">
          Fetches by AI bots across the selected window.
        </p>
        <div
          role="img"
          aria-label={`${series.total} AI bot fetches over the last ${view} days`}
          className={cx("mt-4 flex h-[150px] items-stretch", view === 30 ? "gap-[3px]" : "gap-2")}
        >
          {series.days.map((d, i) => {
            const classed = STACK_TOP_DOWN.reduce((s, c) => s + d.by_class[c], 0);
            const other = Math.max(0, d.hits - classed);
            return (
              <div
                key={d.day}
                className="flex min-w-0 flex-1 flex-col items-center"
                title={`${dayLabel(d.day)}: ${d.hits} ${d.hits === 1 ? "fetch" : "fetches"}`}
              >
                <div className="flex min-h-0 w-full flex-1 flex-col justify-end overflow-hidden rounded-[5px] bg-creamDeep">
                  {other > 0 && (
                    <div className="w-full bg-inkLight" style={{ height: `${(other / max) * 100}%` }} />
                  )}
                  {STACK_TOP_DOWN.map((c) =>
                    d.by_class[c] > 0 ? (
                      <div
                        key={c}
                        className="w-full"
                        style={{ height: `${(d.by_class[c] / max) * 100}%`, background: CLASS_COLOR[c] }}
                      />
                    ) : null,
                  )}
                </div>
                <span className="mt-1.5 h-4 whitespace-nowrap text-[11px] text-inkLight tabular-nums">
                  {i % labelEvery === 0 ? dayOfMonth(d.day) : ""}
                </span>
              </div>
            );
          })}
        </div>
        <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-inkMuted">
          {classTotals.map(({ c, n }) => (
            <li key={c} className="flex items-center gap-2">
              <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: CLASS_COLOR[c] }} />
              {BOT_CLASS_LABEL[c]}
              <span className="font-semibold text-ink tabular-nums">{n.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section className={GEO_CARD} aria-label="AI crawler hits">
      <CardTitle
        icon={Bot}
        right={
          panel.state === "ok" ? (
            <Segmented label="Window" options={VIEW_OPTIONS} value={view} onChange={onView} />
          ) : undefined
        }
      >
        AI crawler hits
      </CardTitle>
      {body}
      {blocked.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-inkMuted">
          {blocked.map((b) => (
            <li key={b.bot} className="flex items-center gap-2">
              <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-danger" />
              {b.bot}
              <span className="rounded-md bg-dangerBg px-1.5 py-0.5 text-[12px] font-medium text-danger">
                {b.reason === "robots" ? "blocked" : "turned away"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {callouts.slice(0, 2).map((c) => (
        <p key={c} className="mt-2 text-[13px] leading-[1.5] text-warn">
          {c}
        </p>
      ))}
    </section>
  );
}

const VISIBILITY_EMPTY: Record<Exclude<VisibilityPanel["state"], "ok">, string> = {
  not_configured: "Not switched on yet",
  no_prompts: "No prompts tracked yet",
  never_run: "Not sampled yet",
  no_data_in_window: "No sample in this window",
};

export function VisibilityCard({ panel }: { panel: VisibilityPanel }) {
  const m = panel.metrics;
  const rate = m?.mention_rate ?? null;
  const byEngine = new Map((m?.mention_rate.by_engine ?? []).map((e) => [e.engine, e]));
  return (
    <section className={GEO_CARD} aria-label="AI visibility">
      <CardTitle icon={Sparkles}>AI visibility</CardTitle>
      <div className="mt-3 flex items-center gap-3 border-b border-rule pb-4">
        <Ring
          value={rate?.rate === null || rate === null ? null : rate.rate * 100}
          tone="blue"
        />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold leading-5 text-ink">
            {panel.state === "ok" && rate
              ? `Named in ${rate.numerator} of ${rate.denominator} answers`
              : VISIBILITY_EMPTY[panel.state as Exclude<VisibilityPanel["state"], "ok">] ?? "Not sampled yet"}
          </p>
          <p className="text-[13px] leading-5 text-inkMuted">
            {m
              ? `${m.responses.engines} engines · ${m.responses.prompts} prompts`
              : `${panel.config.engines.length} engines tracked`}
          </p>
        </div>
      </div>
      <ul className="mt-1 divide-y divide-rule">
        {panel.config.engines.map((e) => {
          const r = byEngine.get(e.id);
          const v = r?.rate === null || r === undefined ? null : Math.round(r.rate * 100);
          return (
            <li
              key={e.id}
              className="flex items-center gap-3 py-2.5"
              title={r && r.denominator > 0 ? `${r.numerator} of ${r.denominator} answers` : undefined}
            >
              <EngineLogo engine={e.id} />
              <span className="w-[74px] shrink-0 truncate text-[16px] font-medium text-ink">{e.label}</span>
              <Bar value={v} fill="bg-[#2563eb]" />
              <span className="w-9 shrink-0 text-right text-[16px] font-semibold text-ink tabular-nums">
                {v === null ? "-" : `${v}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const GRADE_COPY: Record<ReadinessLane["grade"], { word: string; tone: "good" | "warn" | "bad" | "none" }> = {
  high: { word: "On track", tone: "good" },
  medium: { word: "Needs work", tone: "warn" },
  low: { word: "At risk", tone: "bad" },
  not_measured: { word: "Not measured", tone: "none" },
};

export function ReadinessCard({ readiness }: { readiness: ReadinessLane | null }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (!readiness) {
    return (
      <section className={GEO_CARD} aria-label="Readiness">
        <CardTitle icon={Gauge}>Readiness</CardTitle>
        <CardNote>
          Zavi has not read your site yet. Add your website in Settings and this
          fills in on the next read.
        </CardNote>
      </section>
    );
  }
  const grade = GRADE_COPY[readiness.grade] ?? GRADE_COPY.not_measured;
  const measured = readiness.grade !== "not_measured";
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section className={GEO_CARD} aria-label="Readiness">
      <CardTitle icon={Gauge}>Readiness</CardTitle>
      <div className="mt-3 flex items-center gap-3 border-b border-rule pb-4">
        <Ring value={measured ? readiness.score.total : null} tone={grade.tone} />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold leading-5 text-ink">{grade.word}</p>
          <p className="text-[13px] leading-5 text-inkMuted" title={readiness.disclosure}>
            Our heuristic · {readiness.pages_analyzed}{" "}
            {readiness.pages_analyzed === 1 ? "page" : "pages"} read
          </p>
        </div>
      </div>
      {measured ? (
        <ul className="mt-3 flex flex-col gap-1">
          {readiness.score.bands.map((b) => {
            const expanded = open.has(b.key);
            return (
              <li key={b.key}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(b.key)}
                  className={cx(
                    "flex w-full items-center gap-2 rounded-cta py-1.5 text-left hover:bg-creamDeep",
                    FOCUS_RING,
                  )}
                >
                  <ChevronDown
                    aria-hidden
                    className={cx(
                      "h-4 w-4 shrink-0 text-inkLight transition-transform duration-200 motion-reduce:transition-none",
                      !expanded && "-rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[16px] text-ink">{b.label}</span>
                  <span aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-bone">
                    <span className={cx("block h-full rounded-full", scoreFill(b.score))} style={{ width: `${b.score}%` }} />
                  </span>
                  <span className="w-7 shrink-0 text-right text-[16px] font-semibold text-ink tabular-nums">
                    {b.score}
                  </span>
                </button>
                {expanded && (
                  <p className="ml-6 border-l border-rule pb-1.5 pl-3 text-[13px] leading-[1.5] text-inkMuted">
                    {b.note} Weighted {b.weight}% of the score.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <CardNote>
          No page came back readable on the last read, so there is nothing to
          score. That is a gap in the read, not a failing grade.
        </CardNote>
      )}
      {readiness.completeness.warning && (
        <p className="mt-3 text-[13px] leading-[1.5] text-warn">{readiness.completeness.warning}</p>
      )}
    </section>
  );
}

const PROGRESS_ICON: Record<ProgressKey, Icon> = {
  mention_rate: AtSign,
  citation_rate: Link2,
  share_of_voice: Users,
};

export function ProgressCard({ panel }: { panel: VisibilityPanel }) {
  const rows = progressRowsOf(panel.history);
  const sweeps = Math.max(...rows.map((r) => r.points.length), 0);
  return (
    <section className={GEO_CARD} aria-label="Progress">
      <CardTitle
        icon={TrendingUp}
        sub={
          sweeps === 0
            ? "Changes across sweeps"
            : `Across your last ${sweeps} ${sweeps === 1 ? "sweep" : "sweeps"}`
        }
      >
        Progress
      </CardTitle>
      {sweeps === 0 ? (
        <CardNote>Each sweep adds a point. Run one to start the line.</CardNote>
      ) : (
        <ul className="mt-2 divide-y divide-rule">
          {rows.map((r) => {
            const IconEl = PROGRESS_ICON[r.key];
            return (
              <li key={r.key} className="flex items-center gap-3 py-2.5">
                <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bone text-ink">
                  <IconEl className="h-4 w-4" />
                </span>
                <span className="w-[92px] shrink-0 text-[16px] font-medium leading-5 text-ink">{r.label}</span>
                <span className="min-w-0 flex-1">
                  <Spark points={r.points} />
                </span>
                <span className="shrink-0 text-[13px] font-medium text-inkMuted tabular-nums">
                  {r.from === null ? "-" : r.points.length < 2 ? `${r.to}%` : `${r.from} → ${r.to}`}
                </span>
                <span
                  className={cx(
                    "w-11 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums",
                    r.change === null
                      ? "bg-[#eaf2ff] text-[#1d4ed8]"
                      : r.change > 0
                        ? "bg-successBg text-success"
                        : r.change < 0
                          ? "bg-dangerBg text-danger"
                          : "bg-bone text-inkMuted",
                  )}
                  title={
                    r.change === null
                      ? "Only one comparable sweep so far."
                      : "Point change from the first to the latest sweep. A single sweep is a sample; small moves can be noise."
                  }
                >
                  {r.from === null
                    ? "-"
                    : r.change === null
                      ? "New"
                      : r.change === 0
                        ? "-"
                        : `${r.change > 0 ? "+" : "−"}${Math.abs(r.change)}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rows.some((r) => r.trimmed) && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-inkMuted">
          <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Starts where the tracked prompts or rivals last changed.
        </p>
      )}
    </section>
  );
}

const CHECK_ICON: Record<CheckKey, Icon> = {
  crawlers: Bot,
  server_rendered: Code2,
  lead_passage: TextQuote,
  question_headings: Heading,
  figures: Hash,
  schema: Braces,
  author: UserRound,
  dates: CalendarDays,
  fresh: History,
};

const STATUS_COPY: Record<CheckStatus, { text: string; className: string }> = {
  pass: { text: "Pass", className: "text-success" },
  fix: { text: "Fix", className: "text-danger" },
  not_checked: { text: "Not checked", className: "text-inkMuted font-medium" },
};

export function ChecklistCard({ readiness }: { readiness: ReadinessLane | null }) {
  const rows = checklistOf(readiness);
  const [open, setOpen] = useState<CheckKey | null>(null);
  const checked = rows.filter((r) => r.status !== "not_checked");
  const passed = rows.filter((r) => r.status === "pass").length;
  return (
    <section className={GEO_CARD} aria-label="GEO checklist">
      <CardTitle
        icon={ListChecks}
        sub="Citation-readiness signals for LLMs"
        right={
          checked.length > 0 ? (
            <span
              className={cx(
                "shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-semibold tabular-nums",
                passed === checked.length ? "bg-successBg text-success" : "bg-warnBg text-warn",
              )}
              title={
                checked.length < rows.length
                  ? `${rows.length - checked.length} not checked on the last read`
                  : undefined
              }
            >
              {passed}/{checked.length}
            </span>
          ) : undefined
        }
      >
        GEO checklist
      </CardTitle>
      <ul className="mt-3 divide-y divide-rule">
        {rows.map((r) => {
          const IconEl = CHECK_ICON[r.key];
          const status = STATUS_COPY[r.status];
          const expandable = r.status === "fix" && r.detail !== null;
          const expanded = expandable && open === r.key;
          const line = (
            <>
              <span className="flex min-w-0 items-center gap-2 text-[16px] font-medium text-ink">
                <IconEl className="h-[18px] w-[18px] shrink-0 text-inkMuted" aria-hidden />
                <span className="min-w-0">{r.label}</span>
              </span>
              <span className={cx("shrink-0 text-[13px] font-semibold", status.className)}>
                {status.text}
              </span>
            </>
          );
          return (
            <li key={r.key}>
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : r.key)}
                  className={cx(
                    "flex w-full items-center justify-between gap-3 rounded-cta py-2.5 text-left hover:bg-creamDeep",
                    FOCUS_RING,
                  )}
                >
                  {line}
                </button>
              ) : (
                <div className="flex items-center justify-between gap-3 py-2.5">{line}</div>
              )}
              {expanded && (
                <p className="pb-2.5 pl-[26px] text-[13px] leading-[1.5] text-inkMuted">{r.detail}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const FILE_STATUS: Record<
  ReturnType<typeof siteFilesOf>[number]["status"],
  { text: string; className: string; ok: boolean }
> = {
  found: { text: "Found", className: "text-success", ok: true },
  missing: { text: "Missing", className: "text-danger", ok: false },
  unreadable: { text: "Couldn't read", className: "text-warn", ok: false },
  not_checked: { text: "Not checked", className: "text-inkMuted", ok: false },
};

export function SiteFilesCard({ readiness }: { readiness: ReadinessLane | null }) {
  return (
    <section className={GEO_CARD} aria-label="Site files">
      <CardTitle icon={FileText} sub="Crawler and AI accessibility configuration">
        Site files
      </CardTitle>
      <ul className="mt-3 divide-y divide-rule">
        {siteFilesOf(readiness).map((f) => {
          const s = FILE_STATUS[f.status];
          return (
            <li key={f.name} className="flex items-center justify-between gap-3 py-2.5">
              <span className="flex items-center gap-2 text-[16px] text-ink">
                <span
                  aria-hidden
                  className={cx(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                    s.ok ? "bg-successBg text-success" : "bg-bone text-inkLight",
                  )}
                >
                  {s.ok ? <Check className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                </span>
                <code className="text-[16px]">{f.name}</code>
              </span>
              <span className={cx("text-[13px] font-semibold", s.className)}>{s.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const GROUP_COLOR = { owned: "#2563eb", rival: "#a16207", other: "#9ca3af" } as const;
const GROUP_CHIP = {
  owned: { text: "Owned", className: "bg-successBg text-success" },
  rival: { text: "Rival", className: "bg-warnBg text-warn" },
  other: { text: "Third-party", className: "bg-bone text-inkMuted" },
} as const;

export function SourceMixCard({ panel }: { panel: VisibilityPanel }) {
  const m = panel.metrics;
  const mix = m ? sourceGroupsOf(m) : null;
  return (
    <section className={GEO_CARD} aria-label="Source mix">
      <CardTitle icon={ChartPie} sub="Where AI answers pull sources from">
        Source mix
      </CardTitle>
      {!mix || mix.total === 0 ? (
        <CardNote>
          {m
            ? "The sampled answers cited no sources yet."
            : "Fills in from the sources cited in sampled answers."}
        </CardNote>
      ) : (
        <>
          <div
            role="img"
            aria-label={mix.groups.map((g) => `${g.label} ${g.share}%`).join(", ")}
            className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-bone"
          >
            {mix.groups.map((g) =>
              g.share > 0 ? (
                <span key={g.kind} style={{ width: `${g.share}%`, background: GROUP_COLOR[g.kind] }} />
              ) : null,
            )}
          </div>
          <ul className="mt-3 divide-y divide-rule">
            {mix.groups.map((g) => (
              <li key={g.kind} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-2 text-[16px]">
                <span className="flex min-w-0 items-center gap-2 text-ink">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: GROUP_COLOR[g.kind] }} />
                  <span className="truncate">{g.label}</span>
                </span>
                <span className="text-right font-semibold text-ink tabular-nums">{g.share}%</span>
                <span className="flex justify-end">
                  <span className={cx("rounded-full px-2 py-0.5 text-[12px] font-semibold", GROUP_CHIP[g.kind].className)}>
                    {GROUP_CHIP[g.kind].text}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] leading-4 text-inkMuted">
            Share of {mix.total.toLocaleString()} citations
            {mix.partial ? " across the top sources" : ""}.
          </p>
        </>
      )}
    </section>
  );
}

export function TopSourcesCard({ panel }: { panel: VisibilityPanel }) {
  const domains = panel.metrics?.source_mix.domains.slice(0, 5) ?? [];
  return (
    <section className={GEO_CARD} aria-label="Top citation sources">
      <CardTitle icon={Globe}>Top citation sources</CardTitle>
      {domains.length === 0 ? (
        <CardNote>The domains AI answers cite most will list here.</CardNote>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_88px] gap-2 border-b border-rule pb-2 text-[12px] font-semibold uppercase tracking-wide text-inkLight">
            <span>Domain</span>
            <span className="text-right">Cited in</span>
          </div>
          <ul>
            {domains.map((d) => (
              <li
                key={d.domain}
                className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-2 border-b border-rule py-2.5 last:border-b-0"
                title={`${d.responses} answers, ${d.citations} citations`}
              >
                <span className="flex min-w-0 items-center gap-2 text-[16px] text-ink">
                  <DomainIcon domain={d.domain} />
                  <span className="truncate">{d.domain}</span>
                  {d.kind !== "other" && (
                    <span className={cx("shrink-0 rounded-full px-1.5 py-[1px] text-[11px] font-semibold", GROUP_CHIP[d.kind].className)}>
                      {d.kind === "rival" && d.rival ? d.rival : GROUP_CHIP[d.kind].text}
                    </span>
                  )}
                </span>
                <span className="text-right text-[16px] font-semibold text-ink tabular-nums">{pctOf(d.used)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] leading-4 text-inkMuted">Share of sampled answers citing each domain.</p>
        </>
      )}
    </section>
  );
}
