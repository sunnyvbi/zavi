"use client";

import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { htmlRendersBlank, type BlockReceipt, type ChartBlock, type HtmlBlock, type KpiBlock, type PostsBlock, type TableBlock, type UiBlock, type UiBlockKind } from "@zavi/shared";
import { PanelRightOpen } from "lucide-react";
import { PostPreview } from "./PostPreview";
import { harden } from "./HtmlPreviewFrame";
import { CHART_COLORS, loadUiBlock, reportDismissed } from "./uiBlockData";
import { ReceiptChip, SourceMark, UnverifiedChip } from "./receipts/Receipts";
import { agoText, formatStamp, formatWindow, fromBlockReceipt, isNeutralMetric, sourceName } from "./receipts/receiptData";

export { CHART_COLORS, loadUiBlock };

type ArtifactLike = {
  id: string;
  filename: string;
  preview_url?: string | null;
};

export type CardFrame = { action?: React.ReactNode; expanded?: boolean };

function Card({
  title,
  children,
  wide,
  frame,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
  frame?: CardFrame;
}) {
  const width = frame?.expanded ? "" : wide ? "max-w-[760px]" : "max-w-[640px]";
  return (
    <div className={`mt-1 w-full ${width} rounded-lg border border-rule bg-white p-3 shadow-sm`}>
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[12px] font-semibold text-ink">{title}</div>
        {frame?.action}
      </div>
      {children}
    </div>
  );
}

const PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#64748b"];

const MAX_LABELLED_BARS = 12;

export function barFill(
  value: number,
  hasNegative: boolean,
  colors?: ChartBlock["colors"],
): string {
  const bySign = hasNegative || !!(colors?.positive || colors?.negative);
  if (!bySign) return colors?.series ?? CHART_COLORS.series;
  return value < 0
    ? (colors?.negative ?? CHART_COLORS.negative)
    : (colors?.positive ?? CHART_COLORS.positive);
}

type BarLabelProps = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string;
  fmt: (v: number) => string;
};

function BarValueLabel({ x, y, width, height, value, fmt }: BarLabelProps) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const top = Math.min(Number(y), Number(y) + Number(height));
  const bottom = Math.max(Number(y), Number(y) + Number(height));
  return (
    <text
      x={Number(x) + Number(width) / 2}
      y={n < 0 ? bottom + 12 : top - 4}
      textAnchor="middle"
      fontSize={10}
      fill={CHART_COLORS.ink}
    >
      {fmt(n)}
    </text>
  );
}

const CARTESIAN = new Set(["bar", "line", "area"]);
const COMPARE_STROKE = "#a1a1aa";
const GOAL_STROKE = "#0E9F6E";

function dayTick(label: unknown): string {
  const s = String(label);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? (formatWindow({ since: s, until: s }) ?? s) : s;
}

function seriesWindow(points: ReadonlyArray<{ label: string }> | undefined): string | null {
  if (!points || points.length === 0) return null;
  const a = points[0].label;
  const b = points[points.length - 1].label;
  return /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) ? formatWindow({ since: a, until: b }) : null;
}

function Provenance({ block }: { block: ChartBlock }) {
  const rc = block.receipt;
  const asOf = block.as_of ?? rc?.fetched_at;
  const windowText = formatWindow(block.window ?? rc?.window) ?? seriesWindow(block.series);
  const tz = rc?.tz;
  if (!rc && !asOf && !block.window) return null;
  const stamp = formatStamp(asOf);
  const ago = agoText(asOf);
  return (
    <dl className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-inkMuted" data-testid="chart-provenance">
      {rc && (
        <div className="flex items-center gap-1">
          <dt>Source</dt>
          <dd className="flex items-center gap-1 font-medium text-ink">
            <SourceMark slug={rc.source} size={12} />
            {sourceName(rc.source)}
          </dd>
        </div>
      )}
      {stamp && (
        <div className="flex gap-1">
          <dt>As of</dt>
          <dd className="font-medium text-ink">
            {stamp}
            {ago ? ` (${ago})` : ""}
          </dd>
        </div>
      )}
      {windowText && (
        <div className="flex gap-1">
          <dt>Window</dt>
          <dd className="font-medium text-ink">
            {windowText}
            {tz ? `, ${tz}` : ""}
          </dd>
        </div>
      )}
    </dl>
  );
}

function SeriesToggle({
  shown,
  onToggle,
  swatch,
  children,
}: {
  shown: boolean;
  onToggle: () => void;
  swatch: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={shown}
      onClick={onToggle}
      className={`inline-flex h-8 items-center gap-2 rounded-cta border px-2 text-[12px] font-medium transition-colors ${
        shown ? "border-rule text-ink" : "border-dashed border-rule text-inkMuted"
      }`}
    >
      {swatch}
      {children}
      <span className="text-inkMuted">{shown ? "(shown)" : "(hidden)"}</span>
    </button>
  );
}

function ProvenanceFooter({ verified, receipt, label }: { verified?: boolean; receipt?: BlockReceipt; label: string }) {
  if (verified === true && receipt) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-rule pt-2">
        <ReceiptChip r={fromBlockReceipt(receipt, { label })} />
      </div>
    );
  }
  if (verified === false) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-rule pt-2 text-[12px] text-inkMuted">
        <UnverifiedChip figure="" />
        <span>Zavi typed these numbers; no source returned them.</span>
      </div>
    );
  }
  return null;
}

export function ChartCard({ block, frame }: { block: ChartBlock; frame?: CardFrame }) {
  const [showCompare, setShowCompare] = useState(true);
  const [showGoal, setShowGoal] = useState(true);
  const cartesian = CARTESIAN.has(block.variant);
  const hasCompare = cartesian && (block.compare?.length ?? 0) > 0;
  const hasGoal = cartesian && typeof block.goal === "number";
  const data = block.series.map((s, i) => ({
    name: s.label,
    value: s.value,
    ...(hasCompare && block.compare?.[i] ? { compare: block.compare[i].value } : {}),
  }));
  const fmt = (v: number) => `${block.unit === "$" ? "$" : ""}${v.toLocaleString()}${block.unit && block.unit !== "$" ? block.unit : ""}`;
  const hasNegative = data.some((d) => d.value < 0);
  const lineStroke = block.colors?.series ?? CHART_COLORS.series;
  const mainName = formatWindow(block.window) ?? seriesWindow(block.series) ?? "This period";
  const compareName = seriesWindow(block.compare) ?? "Previous period";
  const tick = { fontSize: 11, fill: CHART_COLORS.muted };
  const tooltip = (cursor: object) => (
    <Tooltip
      formatter={(v, name) => [fmt(Number(v)), name === "compare" ? compareName : name === "value" ? mainName : name]}
      cursor={cursor}
      contentStyle={{
        background: CHART_COLORS.surface,
        border: `1px solid ${CHART_COLORS.rule}`,
        borderRadius: 6,
        fontSize: 12,
      }}
      labelStyle={{ color: CHART_COLORS.ink, fontWeight: 600 }}
      itemStyle={{ color: CHART_COLORS.ink }}
    />
  );
  const axes = (cursor: object) => (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.rule} />
      <XAxis dataKey="name" tick={tick} stroke={CHART_COLORS.muted} tickFormatter={dayTick} />
      <YAxis tick={tick} width={40} stroke={CHART_COLORS.muted} />
      {hasNegative && <ReferenceLine y={0} stroke={CHART_COLORS.muted} />}
      {hasGoal && showGoal && (
        <ReferenceLine y={block.goal} stroke={GOAL_STROKE} strokeWidth={1.5} strokeDasharray="2 4" ifOverflow="extendDomain" />
      )}
      {tooltip(cursor)}
    </>
  );
  const compareLine =
    hasCompare && showCompare ? (
      <Line type="monotone" dataKey="compare" stroke={COMPARE_STROKE} strokeDasharray="5 4" dot={false} strokeWidth={1.75} isAnimationActive={false} />
    ) : null;
  const lineCursor = { stroke: CHART_COLORS.muted, strokeDasharray: "3 3" };
  const margin = { top: 4, right: 8, left: 0, bottom: 0 };
  let chart: React.ReactElement<any>;
  switch (block.variant) {
    case "line":
      chart = (
        <LineChart data={data} margin={margin}>
          {axes(lineCursor)}
          {compareLine}
          <Line type="monotone" dataKey="value" stroke={lineStroke} dot={false} strokeWidth={2} />
        </LineChart>
      );
      break;
    case "area":
      chart = compareLine ? (
        <ComposedChart data={data} margin={margin}>
          {axes(lineCursor)}
          {compareLine}
          <Area type="monotone" dataKey="value" stroke={lineStroke} fill={lineStroke} fillOpacity={0.15} strokeWidth={2} />
        </ComposedChart>
      ) : (
        <AreaChart data={data} margin={margin}>
          {axes(lineCursor)}
          <Area type="monotone" dataKey="value" stroke={lineStroke} fill={lineStroke} fillOpacity={0.15} strokeWidth={2} />
        </AreaChart>
      );
      break;
    case "pie":
    case "donut":
      chart = (
        <PieChart>
          {tooltip({})}
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={block.variant === "donut" ? "55%" : 0}
            outerRadius="80%"
            paddingAngle={block.variant === "donut" ? 2 : 0}
            stroke={CHART_COLORS.surface}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      );
      break;
    case "funnel":
      chart = (
        <FunnelChart>
          {tooltip({})}
          <Funnel dataKey="value" data={data} isAnimationActive={false}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
            <LabelList dataKey="name" position="right" fill={CHART_COLORS.ink} stroke="none" fontSize={11} />
          </Funnel>
        </FunnelChart>
      );
      break;
    default:
      chart = (
        <BarChart data={data} margin={{ ...margin, top: 16, bottom: hasNegative ? 12 : 0 }}>
          {axes({ fill: CHART_COLORS.muted, fillOpacity: 0.12 })}
          {hasCompare && showCompare && (
            <Bar dataKey="compare" fill={COMPARE_STROKE} fillOpacity={0.45} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          )}
          <Bar dataKey="value" fill={lineStroke} radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={barFill(d.value, hasNegative, block.colors)} />
            ))}
            {data.length <= MAX_LABELLED_BARS && !(hasCompare && showCompare) && (
              <LabelList dataKey="value" content={(props) => <BarValueLabel {...props} fmt={fmt} />} />
            )}
          </Bar>
        </BarChart>
      );
  }
  return (
    <Card title={block.title} frame={frame}>
      <Provenance block={block} />
      {(hasCompare || hasGoal) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="inline-flex items-center gap-2 font-medium text-ink">
            <span aria-hidden className="h-0.5 w-5 rounded" style={{ background: lineStroke }} />
            {mainName}
          </span>
          {hasCompare && (
            <SeriesToggle
              shown={showCompare}
              onToggle={() => setShowCompare((v) => !v)}
              swatch={
                <svg width="20" height="4" aria-hidden>
                  <path d="M0 2 H20" stroke={COMPARE_STROKE} strokeWidth="2" strokeDasharray="4 3" />
                </svg>
              }
            >
              {`Compared with ${compareName}`}
            </SeriesToggle>
          )}
          {hasGoal && (
            <SeriesToggle
              shown={showGoal}
              onToggle={() => setShowGoal((v) => !v)}
              swatch={
                <svg width="20" height="4" aria-hidden>
                  <path d="M0 2 H20" stroke={GOAL_STROKE} strokeWidth="2" strokeDasharray="1.5 3" strokeLinecap="round" />
                </svg>
              }
            >
              {}
              {`Goal ${fmt(block.goal as number)}${block.verified === true ? ", typed by Zavi" : ""}`}
            </SeriesToggle>
          )}
        </div>
      )}
      <div
        className={`${frame?.expanded ? "h-80" : "h-56"} w-full`}
        role="img"
        aria-label={`${block.variant} chart: ${block.title}`}
      >
        <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
      </div>
      {frame?.expanded ? (
        <table className="mt-3 w-full text-[12px]">
          <tbody>
            {block.series.map((s, i) => (
              <tr key={s.label} className="border-b border-rule/60 last:border-0">
                <td className="px-2 py-1">{s.label}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmt(s.value)}</td>
                {hasCompare && (
                  <td className="px-2 py-1 text-right tabular-nums text-inkMuted">
                    {block.compare?.[i] ? fmt(block.compare[i].value) : ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="sr-only">
          {block.series.map((s) => (
            <li key={s.label}>{s.label}: {fmt(s.value)}</li>
          ))}
        </ul>
      )}
      <ProvenanceFooter verified={block.verified} receipt={block.receipt} label={block.title} />
    </Card>
  );
}

export function KpiCard({ block, frame }: { block: KpiBlock; frame?: CardFrame }) {
  const toneCls = (t: string | undefined, neutral: boolean) =>
    neutral ? "text-inkMuted" : t === "up" ? "text-[#2e7d32]" : t === "down" ? "text-[#c0392b]" : "text-inkMuted";
  const shown = (v: string | number) => (typeof v === "number" ? v.toLocaleString() : v);
  return (
    <Card title={block.title} wide frame={frame}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {block.items.map((k) => (
          <div key={k.label} className="rounded-md border border-rule bg-bone/40 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-inkMuted">{k.label}</div>
            <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{shown(k.value)}</div>
            {k.delta && (
              <div className={`text-[11px] ${toneCls(k.tone, isNeutralMetric(k.receipt?.metric_id) || isNeutralMetric(k.label))}`}>{k.delta}</div>
            )}
            {k.verified === true && k.receipt ? (
              <div className="-ml-0.5 mt-1">
                <ReceiptChip r={fromBlockReceipt(k.receipt, { label: k.label, figure: shown(k.value) })} />
              </div>
            ) : k.verified === false ? (
              <div className="-ml-0.5 mt-1">
                <UnverifiedChip figure={shown(k.value)} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

function isNumericCell(v: unknown): boolean {
  if (typeof v === "number") return true;
  return typeof v === "string" && /^[-+]?\$?\s?\d[\d,]*(\.\d+)?\s?%?$/.test(v.trim());
}

export function TableCard({ block, frame }: { block: TableBlock; frame?: CardFrame }) {
  return (
    <Card title={block.title} frame={frame}>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-rule text-left text-[11px] uppercase tracking-wide text-inkMuted">
              {block.columns.map((c, j) => (
                <th
                  key={c}
                  className={`px-2 py-1 font-medium ${block.rows.every((r) => r[j] == null || isNumericCell(r[j])) && block.rows.some((r) => r[j] != null) ? "text-right" : ""}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i} className="border-b border-rule/60 last:border-0">
                {block.columns.map((_, j) => (
                  <td key={j} className={`px-2 py-1 ${isNumericCell(r[j]) ? "text-right tabular-nums" : ""}`}>
                    {r[j] === null || r[j] === undefined ? (
                      "-"
                    ) : typeof r[j] === "string" && /^https:\/\/\S+$/.test(r[j] as string) ? (
                      <a
                        href={r[j] as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet underline-offset-2 hover:underline"
                      >
                        open ↗
                      </a>
                    ) : (
                      String(r[j])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.note && <p className="mt-2 px-2 text-[12px] text-inkMuted">{block.note}</p>}
    </Card>
  );
}

export function PostsCard({ block }: { block: PostsBlock }) {
  return (
    <Card title={block.title}>
      <div className="flex flex-col gap-2">
        {block.posts.map((p, i) => (
          <div key={i}>
            {p.label && (
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-inkMuted">{p.label}</p>
            )}
            <PostPreview channel={p.channel} payload={p.payload} scheduledAt={p.scheduled_at ?? null} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function HtmlCard({ block }: { block: HtmlBlock }) {
  const height = Math.min(1200, Math.max(120, block.height ?? 420));
  const [loads, setLoads] = useState(0);
  const tripped = loads > 1;
  const blank = block.scripts !== true && htmlRendersBlank(block.html);
  return (
    <Card title={block.title} wide>
      {blank ? (
        <div className="rounded-md border border-rule bg-creamDeep px-3 py-2 text-[12px] text-inkMuted">
          This visual needed a script to draw itself, which this workspace does
          not run, so there is nothing to show. Ask for it as a chart instead.
        </div>
      ) : tripped ? (
        <div role="alert" className="rounded-md border border-[#f3c9c4] bg-[#fdf2f1] px-3 py-2 text-[12px] text-[#c0392b]">
          This visual tried to navigate away and was stopped.
        </div>
      ) : (
        <iframe
          srcDoc={harden(block.html, { scripts: block.scripts === true })}
          title={`Visual: ${block.title}`}
          sandbox={block.scripts === true ? "allow-scripts" : ""}
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={() => setLoads((n) => n + 1)}
          className="w-full rounded-md border border-rule bg-white"
          style={{ height }}
        />
      )}
    </Card>
  );
}

const SKELETON_LABEL: Record<UiBlockKind, string> = {
  chart: "Drawing a chart",
  kpi: "Laying out the numbers",
  table: "Building a table",
  posts: "Preparing post previews",
  html: "Drawing a visual",
};

export function UiBlockSkeleton({ kind, title }: { kind: UiBlockKind; title: string | null }) {
  const label = SKELETON_LABEL[kind];
  return (
    <div
      role="status"
      aria-label={title ? `${label}: ${title}` : label}
      className="mt-1 w-full max-w-[640px] rounded-lg border border-rule bg-white p-3 shadow-sm"
    >
      <div className="mb-2 flex items-center gap-2 text-[12px]">
        <span className="font-semibold text-ink">{title ?? label}</span>
        <span className="text-inkMuted">· {label.toLowerCase()}…</span>
      </div>
      {kind === "chart" ? (
        <div className="flex h-32 items-end gap-2 px-2" aria-hidden>
          {[40, 65, 50, 80, 35, 70, 55].map((h, i) => (
            <div key={i} className="flex-1 animate-pulse rounded-t bg-ink/10" style={{ height: `${h}%`, animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-ink/10" style={{ width: `${90 - i * 15}%`, animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function UiBlockView({ block, frame }: { block: UiBlock; frame?: CardFrame }) {
  switch (block.kind) {
    case "chart":
      return <ChartCard block={block} frame={frame} />;
    case "kpi":
      return <KpiCard block={block} frame={frame} />;
    case "table":
      return <TableCard block={block} frame={frame} />;
    case "posts":
      return <PostsCard block={block} />;
    case "html":
      return <HtmlCard block={block} />;
  }
}

const ANALYSIS_KINDS: ReadonlySet<UiBlockKind> = new Set(["table", "chart", "kpi"]);

export function UiBlockArtifact({
  artifact,
  fallback,
  onOpenAnalysis,
  expanded,
  autoOpen = false,
  paneOpen = false,
}: {
  artifact: ArtifactLike;
  fallback: React.ReactNode;
  onOpenAnalysis?: (title: string, auto?: boolean) => void;
  expanded?: boolean;
  autoOpen?: boolean;
  paneOpen?: boolean;
}) {
  const [block, setBlock] = useState<UiBlock | null | "loading">("loading");
  const previewUrlRef = useRef(artifact.preview_url ?? null);
  previewUrlRef.current = artifact.preview_url ?? null;
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void loadUiBlock(
      artifact.id,
      fetch,
      previewUrlRef.current,
      controller.signal,
    ).then((b) => {
      if (alive) setBlock(b);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [artifact.id]);
  if (block === "loading") {
    return <div className="mt-1 h-24 w-full max-w-[640px] animate-pulse rounded-lg border border-ink/10 bg-ink/5" aria-label={`Loading ${artifact.filename}`} />;
  }
  if (!block) return <>{fallback}</>;
  return (
    <LoadedBlock block={block} artifactId={artifact.id} onOpenAnalysis={onOpenAnalysis} expanded={expanded} autoOpen={autoOpen} paneOpen={paneOpen} />
  );
}

function LoadedBlock({
  block,
  artifactId,
  onOpenAnalysis,
  expanded,
  autoOpen,
  paneOpen,
}: {
  block: UiBlock;
  artifactId: string;
  onOpenAnalysis?: (title: string, auto?: boolean) => void;
  expanded?: boolean;
  autoOpen: boolean;
  paneOpen: boolean;
}) {
  const canOpen = !!onOpenAnalysis && ANALYSIS_KINDS.has(block.kind);
  const decided = useRef(false);
  useEffect(() => {
    if (!canOpen) {
      decided.current = false;
      return;
    }
    if (decided.current) return;
    decided.current = true;
    const asked = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("report") === artifactId;
    if (!asked && (!autoOpen || paneOpen || reportDismissed(artifactId))) return;
    onOpenAnalysis?.(block.title, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, canOpen, artifactId]);
  const action =
    canOpen ? (
      <button
        type="button"
        onClick={() => onOpenAnalysis?.(block.title)}
        className="inline-flex shrink-0 items-center gap-2 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-cream shadow-sm transition-colors hover:bg-inkSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <PanelRightOpen className="h-4 w-4" aria-hidden />
        Open report
      </button>
    ) : undefined;
  return <UiBlockView block={block} frame={{ action, expanded }} />;
}
