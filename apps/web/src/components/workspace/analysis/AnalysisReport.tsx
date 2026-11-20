"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { FileDown, FileText, Sheet } from "lucide-react";
import type { UiBlock } from "@zavi/shared";
import { Markdown } from "../Markdown";
import { CHART_COLORS, loadUiBlock } from "../uiBlockData";
import { buildReport, parseSources, type Kpi, type Measure, type ReportModel } from "@zavi/shared";
import { downloadReportCsv } from "./reportDownloads";

export type AnalysisReportProps = {
  artifactId: string;
  previewUrl?: string | null;
  summary: string;
  sources: string | null;
  createdAt: string;
  onModel?: (model: ReportModel | null) => void;
};

export function AnalysisReport({ artifactId, previewUrl, summary, sources, createdAt, onModel }: AnalysisReportProps) {
  const [block, setBlock] = useState<UiBlock | null | "loading">("loading");
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    void loadUiBlock(artifactId, fetch, previewUrl ?? null, controller.signal).then((b) => {
      if (alive) setBlock(b);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [artifactId, previewUrl]);

  const model = useMemo(() => (block && block !== "loading" ? buildReport(block) : null), [block]);
  const src = useMemo(() => parseSources(sources), [sources]);
  useEffect(() => {
    onModel?.(model);
  }, [model, onModel]);

  if (block === "loading") {
    return (
      <div className="space-y-4 px-8 py-8" aria-label="Loading report">
        <div className="h-3 w-40 animate-pulse rounded bg-ink/5" />
        <div className="h-7 w-3/4 animate-pulse rounded bg-ink/5" />
        <div className="h-20 animate-pulse rounded bg-ink/5" />
        <div className="h-40 animate-pulse rounded bg-ink/5" />
      </div>
    );
  }
  if (!model) {
    return <p className="px-8 py-8 text-sm text-inkMuted">This analysis could not be drawn.</p>;
  }
  return <ReportBody model={model} summary={summary} src={src} createdAt={createdAt} />;
}

function ReportBody({
  model,
  summary,
  src,
  createdAt,
}: {
  model: ReportModel;
  summary: string;
  src: ReturnType<typeof parseSources>;
  createdAt: string;
}) {
  const when = formatDate(createdAt);
  const time = formatTime(createdAt);
  const fromData = !!src && src.pulled.length > 0;
  return (
    <article className="mx-auto w-full max-w-[760px] px-6 pb-10 pt-8 text-ink" data-testid="analysis-report">
      <header>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <FileText className="mt-0.5 size-6 shrink-0 text-[#3f3f46]" strokeWidth={1.5} aria-hidden />
            <div className="min-w-0">
              <h1 className="text-[16px] font-medium leading-6 text-ink">{model.title}</h1>
              {when && (
                <p className="text-[13px] leading-5 text-[#71717a]">
                  Generated: {when}
                  {time ? ` • ${time}` : ""}
                </p>
              )}
            </div>
          </div>
          <p className="flex shrink-0 items-center gap-1.5 pt-1 text-[12px] font-medium uppercase tracking-[0.02em] text-[#2563eb]">
            <span aria-hidden className="size-1.5 rounded-full bg-[#2563eb]" />
            {fromData ? "From your data" : "Analysis"}
          </p>
        </div>
        {summary.trim() && (
          <div className="mt-5 text-inkSoft">
            <Markdown source={summary} breaks reading />
          </div>
        )}
      </header>

      {model.kpis.length > 0 && (
        <section aria-label="Headline numbers" className="mt-6">
          {model.kpis[0].period && (
            <p className="mb-3 text-[12px] text-inkMuted">
              {model.kpis[0].period}
              {model.kpis[0].previous ? `, compared with ${model.kpis[0].previous}` : ""}
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            {model.kpis.map((k) => (
              <KpiTile key={k.name} kpi={k} formula={model.measures.find((m) => m.name === k.name)?.formula} />
            ))}
          </div>
        </section>
      )}

      {model.measures.length > 0 && model.labels.length > 1 && (
        <section aria-label="Charts" className="mt-10">
          <SectionTitle>{model.dimension ? `By ${model.dimension.toLowerCase()}` : "Breakdown"}</SectionTitle>
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(125px,1fr))] gap-x-5 gap-y-8">
            {model.measures.slice(0, 4).map((m) => (
              <MeasureChart
                key={m.name}
                measure={m}
                labels={model.labels}
                formula={model.kpis.some((k) => k.name === m.name) ? undefined : m.formula}
                twoLineCaption={model.measures.slice(0, 4).some((x) => x.formula && !model.kpis.some((k) => k.name === x.name))}
              />
            ))}
          </div>
        </section>
      )}

      <section aria-label="Data" className="mt-8">
        <Sheet className="size-6 text-[#3f3f46]" strokeWidth={1.5} aria-hidden />
        <div className="mt-3 overflow-x-auto rounded-xl border border-[#ececec]">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-[#f4f4f5]">
                {model.columns.map((c, j) => (
                  <th
                    key={`${c}-${j}`}
                    className={`px-3 py-2.5 text-[13px] font-normal text-[#3f3f46] ${isMeasureCol(model, j) ? "text-right" : "text-left"}`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r, i) => (
                <tr key={i} className="border-t border-[#ececec]">
                  {r.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-3 py-3 text-[#18181b] ${isMeasureCol(model, j) ? "text-right tabular-nums" : "text-left"}`}
                    >
                      {cell || "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {model.note && <p className="mt-3 text-[12px] text-inkMuted">{model.note}</p>}
        <div className="mt-8 flex justify-end">
          <button
            type="button"
            onClick={() => downloadReportCsv(model)}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-[#2563eb] px-5 text-[14px] font-medium text-white transition-colors hover:bg-[#1d4ed8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/40 focus-visible:ring-offset-2"
          >
            <FileDown className="size-4" strokeWidth={1.75} aria-hidden />
            Download CSV
          </button>
        </div>
      </section>

      {src && (
        <section aria-label="Sources" className="mt-10 border-t border-rule pt-6">
          <SectionTitle>Where these numbers came from</SectionTitle>
          <p className="mt-2 text-[13px] text-inkSoft">{src.summary}</p>
          <dl className="mt-4 space-y-3 text-[13px]">
            {src.pulled.length > 0 && (
              <SourceRow label="Pulled from your data" tone="ok">
                <ul className="space-y-1">
                  {src.pulled.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </SourceRow>
            )}
            {src.checked.length > 0 && (
              <SourceRow label="Checks out as arithmetic" tone="ok">
                <ul className="space-y-1 tabular-nums">
                  {src.checked.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </SourceRow>
            )}
            {src.missing && (
              <SourceRow label="Not in this run's data" tone="warn">
                {src.missing.replace(/^Not in this run's data:\s*/, "")}
              </SourceRow>
            )}
          </dl>
        </section>
      )}
    </article>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-inkMuted">{children}</h2>;
}

function KpiTile({ kpi, formula }: { kpi: Kpi; formula?: string }) {
  const arrow = kpi.direction === "up" ? "▲" : kpi.direction === "down" ? "▼" : "";
  return (
    <div className="min-w-0 rounded-xl bg-[#f4f4f5] px-4 py-3.5">
      <div className="truncate text-[14px] text-[#3f3f46]" title={kpi.name}>
        {kpi.name}
      </div>
      <div className="mt-2 text-[20px] font-semibold leading-none tabular-nums text-[#18181b]">{kpi.value}</div>
      <div className="mt-2 empty:hidden text-[12px] leading-snug text-inkMuted">
        {kpi.change ? (
          <>
            {arrow && <span aria-hidden className="mr-1 text-[8px] align-[1px]">{arrow}</span>}
            {kpi.change}
          </>
        ) : null}
        {formula && <div className="mt-0.5 text-inkLight">{formula}</div>}
      </div>
    </div>
  );
}

function MeasureChart({
  measure,
  labels,
  formula,
  twoLineCaption,
}: {
  measure: Measure;
  labels: string[];
  formula?: string;
  twoLineCaption?: boolean;
}) {
  const data = labels.map((label, i) => ({
    label: label.replace(/\*+$/, ""),
    value: measure.values[i],
    shown: measure.display[i],
  }));
  return (
    <figure className="min-w-0">
      {}
      <figcaption className={twoLineCaption ? "min-h-[34px]" : ""}>
        <div className="truncate text-[13px] font-semibold text-ink">{measure.name}</div>
        {formula && <div className="truncate text-[11px] text-inkMuted">= {formula}</div>}
      </figcaption>
      <div className="mt-2 h-32" role="img" aria-label={`${measure.name} by ${labels.length} rows`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 18, right: 0, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: CHART_COLORS.rule }}
              interval={0}
              tick={{ fill: CHART_COLORS.muted, fontSize: 10.5 }}
              tickFormatter={shortLabel}
            />
            <Tooltip
              cursor={{ fill: CHART_COLORS.muted, fillOpacity: 0.08 }}
              contentStyle={{ borderRadius: 8, border: `1px solid ${CHART_COLORS.rule}`, background: CHART_COLORS.surface, fontSize: 12 }}
              formatter={(_v: number, _n: string, item: { payload?: { shown?: string } }) => [item.payload?.shown ?? "", measure.name]}
            />
            <Bar dataKey="value" fill={CHART_COLORS.series} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
              {data.length <= 8 && <LabelList dataKey="shown" position="top" fill={CHART_COLORS.ink} fontSize={10.5} />}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {}
      <ul className="sr-only">
        {data.map((d) => (
          <li key={d.label}>
            {d.label}: {d.shown}
          </li>
        ))}
      </ul>
    </figure>
  );
}

const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{2,4})?$/i;

function shortLabel(v: string): string {
  const m = v.match(MONTH);
  if (m) return `${v.slice(0, 1).toUpperCase()}${v.slice(1, 3).toLowerCase()}${m[2] ? ` ${m[2].trim().slice(-2)}` : ""}`;
  return v.length > 8 ? `${v.slice(0, 7)}…` : v;
}

function SourceRow({ label, tone, children }: { label: string; tone: "ok" | "warn"; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3">
      <dt className="flex items-start gap-2 font-medium text-ink">
        <span aria-hidden className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${tone === "ok" ? "bg-[#16a34a]" : "bg-[#b45309]"}`} />
        {label}
      </dt>
      <dd className={tone === "warn" ? "text-[#b45309]" : "text-inkSoft"}>{children}</dd>
    </div>
  );
}

function isMeasureCol(model: ReportModel, j: number): boolean {
  return model.measures.some((m) => m.name === model.columns[j]);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
