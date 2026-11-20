"use client";

import { CreditRefusalError, type CreditRefusal } from "@/lib/workspace/creditRefusal";
import { CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import { useEffect, useRef, useState } from "react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";

import { Markdown } from "./Markdown";
import { Skeleton } from "./Skeleton";
import { useWorkspace } from "./WorkspaceShell";
import {
  useCompetitorIntel,
  saveCustomBrands,
  execSummaryBlock,
  reportSources,
  competitiveRows,
  genericTable,
  markdownBodies,
  brandCount,
  recommendationItems,
  materialMoves,
  recKey,
  saveRecDecision,
  startFirstScan,
  logRecEvent,
  type CompetitorIntelPayload,
  type FirstScanResult,
  type CompetitorSnapshot,
  type ExecSummary,
  type MaterialMove,
  type ReportSource,
  type SaveBrandsResult,
  type RecStatus,
  type RecDecisionMap,
} from "./useCompetitorIntel";
import { summaryLines, sourceDomain } from "./competitorSummary";

type TabId = "moves" | "landscape" | "summary" | "tracked" | "history";

export function CompetitorTab() {
  const { data, loading, error, refetch } = useCompetitorIntel();
  const { seedComposer } = useWorkspace();
  return (
    <CompetitorTabView
      data={data}
      loading={loading}
      error={error}
      onRetry={refetch}
      onAskAgent={(agentSlug, text) => seedComposer({ agentSlug, text })}
      customBrands={data?.custom_brands ?? []}
      onSaveBrands={saveCustomBrands}
      recDecisions={data?.rec_decisions ?? {}}
      onSaveDecision={saveRecDecision}
      onStartFirstScan={startFirstScan}
    />
  );
}

export function CompetitorTabView({
  data,
  loading,
  error,
  onRetry,
  onAskAgent,
  customBrands,
  onSaveBrands,
  recDecisions = {},
  onSaveDecision,
  initialSelectedWeek,
  onStartFirstScan,
}: {
  data: CompetitorIntelPayload | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAskAgent?: (agentSlug: string, text: string) => void;
  customBrands?: string[];
  onSaveBrands?: (brands: string[]) => Promise<SaveBrandsResult>;
  recDecisions?: RecDecisionMap;
  onSaveDecision?: (
    rec_key: string,
    title: string,
    status: RecStatus | "clear",
  ) => Promise<RecDecisionMap>;
  initialSelectedWeek?: string;
  onStartFirstScan?: () => Promise<FirstScanResult>;
}) {
  const [selectedWeek, setSelectedWeek] = useState<string | null>(
    initialSelectedWeek ?? null,
  );
  const [activeTab, setActiveTab] = useState<TabId>("moves");
  const topRef = useRef<HTMLDivElement>(null);
  const prevWeekRef = useRef(selectedWeek);
  useEffect(() => {
    const changed = prevWeekRef.current !== selectedWeek;
    prevWeekRef.current = selectedWeek;
    if (changed && selectedWeek !== null) {
      topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selectedWeek]);

  if (loading) return <CompetitorSkeleton />;

  if (error) {
    return (
      <Frame>
        <div className="mt-6 rounded-lg border border-[#e5e7eb] bg-white px-4 py-6 text-center">
          <div className="text-[16px] text-ink">
            Couldn&rsquo;t load competitor intel.
          </div>
          <div className="mt-1 text-[13px] text-inkMuted">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-cta border border-[#e5e7eb] bg-white px-3 py-1.5 text-[13px] font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)] hover:bg-bone"
          >
            Retry
          </button>
        </div>
      </Frame>
    );
  }

  if (!data || data.enabled !== true) {
    return (
      <Frame>
        <div className="mt-6 rounded-lg border border-[#e5e7eb] bg-white px-4 py-6 text-center">
          <div className="text-[16px] text-ink">Not enabled</div>
          <div className="mt-1 text-[13px] text-inkMuted">
            Competitor Intel isn&rsquo;t turned on for this workspace yet.
          </div>
        </div>
      </Frame>
    );
  }

  if (data.snapshots.length === 0) {
    return (
      <Frame>
        {customBrands !== undefined && onSaveBrands && (
          <CustomBrandsPanel
            initial={customBrands}
            detectedBrands={[]}
            onSave={onSaveBrands}
          />
        )}
        <FirstScanPanel
          scanInProgress={data.scan_in_progress === true}
          onStart={onStartFirstScan}
          onRefresh={onRetry}
        />
      </Frame>
    );
  }

  const latest = data.snapshots[0];
  const active =
    data.snapshots.find((s) => s.week_bucket === selectedWeek) ?? latest;
  const viewingHistory = active.week_bucket !== latest.week_bucket;
  const history = data.snapshots.slice(1);
  const summary = execSummaryBlock(active.landscape);
  const sources = reportSources(active.landscape);
  const rows = competitiveRows(active.landscape);
  const table = rows ? null : genericTable(active.landscape);
  const mdFallback = rows || table ? [] : markdownBodies(active.landscape);
  const activeIdx = data.snapshots.findIndex(
    (s) => s.week_bucket === active.week_bucket,
  );
  const priorSnap =
    activeIdx >= 0 ? data.snapshots[activeIdx + 1] : undefined;
  const priorRecKeys = new Set(
    (recommendationItems(priorSnap?.landscape) ?? []).map((r) => recKey(r.title)),
  );

  const recItems = recommendationItems(active.landscape);
  const hasRecs = !viewingHistory && Array.isArray(recItems) && recItems.length > 0;
  const showTracked =
    !viewingHistory && customBrands !== undefined && !!onSaveBrands;
  const showHistory = history.length > 0;

  const tabs: { id: TabId; label: string; count?: number }[] = [];
  if (hasRecs) tabs.push({ id: "moves", label: "Moves", count: recItems!.length });
  tabs.push({ id: "landscape", label: "Landscape", count: rows?.length });
  tabs.push({ id: "summary", label: "Summary" });
  if (showTracked) tabs.push({ id: "tracked", label: "Tracked" });
  if (showHistory) tabs.push({ id: "history", label: "History" });
  const currentTab: TabId = tabs.some((t) => t.id === activeTab)
    ? activeTab
    : tabs[0]?.id ?? "landscape";

  return (
    <Frame
      title={active.landscape?.title || "Competitor landscape"}
      week={active.week_bucket}
      containerRef={topRef}
    >
      {}
      {viewingHistory && (
        <button
          type="button"
          onClick={() => setSelectedWeek(null)}
          className="-ml-1 mt-3 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[13px] font-semibold text-[#8a6d2c] transition-colors hover:text-[#6f561f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to current week
        </button>
      )}

      <TabBar tabs={tabs} active={currentTab} onSelect={setActiveTab} />

      {}
      {hasRecs && (
        <TabPanel active={currentTab === "moves"}>
          <RecommendedMoves
            snapshot={active}
            onAskAgent={onAskAgent}
            decisions={recDecisions}
            onSaveDecision={onSaveDecision}
            priorRecKeys={priorRecKeys}
          />
        </TabPanel>
      )}

      {}
      <TabPanel active={currentTab === "landscape"}>
        <section>
          <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
            Landscape
          </h2>
          {rows ? (
            <div className="mt-2 overflow-x-auto rounded-lg border border-[#e5e7eb] bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[#e5e7eb] bg-bone/60 font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                    <th className="px-3 py-2 font-medium">Brand</th>
                    <th className="px-3 py-2 font-medium">Positioning</th>
                    <th className="px-3 py-2 font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={`${r.brand}-${i}`}
                      className="border-b border-[#e5e7eb] last:border-b-0 align-top"
                    >
                      <td className="px-3 py-2.5 font-semibold text-ink">
                        {r.brand}
                      </td>
                      <td className="px-3 py-2.5 text-ink/90">{r.positioning}</td>
                      <td className="px-3 py-2.5 text-inkMuted">{r.gap}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : table ? (
            <div className="mt-2 overflow-x-auto rounded-lg border border-[#e5e7eb] bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[#e5e7eb] bg-bone/60 font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                    {table.columns.map((c) => (
                      <th key={c} className="px-3 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r, i) => (
                    <tr
                      key={i}
                      className="border-b border-[#e5e7eb] last:border-b-0 align-top"
                    >
                      {r.map((c, j) => (
                        <td key={j} className="px-3 py-2.5 text-ink/90">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : mdFallback.length > 0 ? (
            <div className="mt-2 rounded-lg border border-[#e5e7eb] bg-white px-4 py-4">
              {mdFallback.map((body, i) => (
                <Markdown
                  key={i}
                  source={body}
                  disableActionLinks
                  className="text-[16px]"
                />
              ))}
            </div>
          ) : (
            <div className="mt-2 rounded-lg border border-[#e5e7eb] bg-white px-4 py-4 text-[13px] text-inkMuted">
              {viewingHistory
                ? "That week’s report has no table."
                : "This week’s report has no table. Check back after the next scan."}
            </div>
          )}
        </section>
      </TabPanel>

      {}
      <TabPanel active={currentTab === "summary"}>
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[3fr,2fr]">
          {summary ? (
            <SummaryCard summary={summary} sources={sources} />
          ) : (
            <section className="rounded-lg border border-[#e5e7eb] bg-white px-4 py-4 text-[13px] text-inkMuted">
              No summary in {viewingHistory ? "that" : "this"} week&rsquo;s report.
            </section>
          )}
          <DeltaPanel snapshot={active} historical={viewingHistory} />
        </div>
      </TabPanel>

      {}
      {showTracked && (
        <TabPanel active={currentTab === "tracked"}>
          <CustomBrandsPanel
            initial={customBrands}
            detectedBrands={(rows ?? []).map((r) => r.brand)}
            onSave={onSaveBrands!}
          />
        </TabPanel>
      )}

      {}
      {showHistory && (
        <TabPanel active={currentTab === "history"}>
          <section>
            <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
              Previous weeks
            </h2>
            <ul className="mt-2 divide-y divide-[#e5e7eb] rounded-lg border border-[#e5e7eb] bg-white">
              {history.map((s) => (
                <HistoryRow
                  key={s.week_bucket}
                  snapshot={s}
                  isSelected={s.week_bucket === active.week_bucket}
                  onSelect={(w) => {
                    setSelectedWeek(w);
                    setActiveTab("landscape");
                  }}
                />
              ))}
            </ul>
          </section>
        </TabPanel>
      )}
    </Frame>
  );
}

function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: TabId; label: string; count?: number }[];
  active: TabId;
  onSelect: (id: TabId) => void;
}) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(active);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Competitor intel sections"
      className="relative mt-4 flex flex-wrap gap-1 border-b border-[#e5e7eb]"
    >
      <SlidingIndicator box={box} className="border-b-2 border-[#c9a24b]" />
      {tabs.map((t) => {
        const on = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(t.id)}
            className={`relative -mb-px border-b-2 border-transparent px-3.5 py-2 text-[13px] font-semibold transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 ${
              on ? "text-ink" : "text-inkMuted hover:text-ink"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="ml-1.5 font-normal text-inkMuted">{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TabPanel({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return <div className={active ? "mt-5" : "hidden"}>{children}</div>;
}

function Frame({
  title,
  week,
  children,
  containerRef,
}: {
  title?: string;
  week?: string;
  children: React.ReactNode;
  containerRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={containerRef} className="mx-auto max-w-7xl px-6 py-6">
      <section>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
          Competitor Intel
        </h1>
        <p className="mt-1 text-[13px] leading-[1.55] text-inkMuted">
          {title && week
            ? `${stripTrailingWeekOf(title)} · week of ${formatWeek(week)}`
            : "Your competitor landscape, refreshed weekly by the research agent."}
        </p>
      </section>
      {children}
    </div>
  );
}

function FirstScanPanel({
  scanInProgress,
  onStart,
  onRefresh,
}: {
  scanInProgress: boolean;
  onStart?: () => Promise<FirstScanResult>;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<CreditRefusal | null>(null);

  if (scanInProgress) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-[#e5e7eb] bg-white px-4 py-8 text-center">
        <div className="text-[16px] text-ink">
          Running your first scan now. Results in a few minutes.
        </div>
        <div className="mt-1 text-[13px] text-inkMuted">
          Your research agent is mapping the landscape. This page updates when the
          report lands.
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="mt-4 rounded-cta border border-[#e5e7eb] bg-white px-3 py-1.5 text-[13px] font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)] hover:bg-bone"
        >
          Refresh
        </button>
      </div>
    );
  }

  async function start() {
    if (!onStart || busy) return;
    setBusy(true);
    setError(null);
    setCredit(null);
    try {
      await onStart();
    } catch (e) {
      if (e instanceof CreditRefusalError) {
        setCredit(e.refusal);
        return;
      }
      setError(e instanceof Error ? e.message : "Couldn't start the scan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-dashed border-[#e5e7eb] bg-white px-4 py-8 text-center">
      <div className="text-[16px] text-ink">No competitor scan yet.</div>
      {onStart ? (
        <>
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="mt-4 rounded-cta border border-[#c9a24b]/50 bg-[#c9a24b]/15 px-3.5 py-2 text-[13px] font-semibold text-[#8a6d2c] hover:bg-[#c9a24b]/25 disabled:opacity-50"
          >
            {busy ? "Starting…" : "Run first scan now"}
          </button>
          <div className="mt-2 text-[13px] text-inkMuted">
            Or wait: the weekly scan runs Monday automatically.
          </div>
          {error && <div className="mt-2 text-[12px] text-red-600">{error}</div>}
          {credit && <CreditRefusalNotice refusal={credit} className="mt-3 text-left" />}
        </>
      ) : (
        <div className="mt-1 text-[13px] text-inkMuted">
          The weekly scan runs Monday automatically. No action needed.
        </div>
      )}
    </div>
  );
}

function CustomBrandsPanel({
  initial,
  detectedBrands,
  onSave,
}: {
  initial: string[];
  detectedBrands: string[];
  onSave: (brands: string[]) => Promise<SaveBrandsResult>;
}) {
  const [brands, setBrands] = useState<string[]>(initial);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const detected = dedupeBrands(detectedBrands);
  const detectedKeys = new Set(detected.map((b) => b.toLowerCase()));
  const manualOnly = brands.filter((b) => !detectedKeys.has(b.toLowerCase()));

  async function commit(next: string[]) {
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(next);
      setBrands(result.brands);
      setDropped(result.dropped);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const v = input.trim();
    if (!v || saving) return;
    setInput("");
    void commit([...brands, v]);
  }

  function remove(b: string) {
    if (saving) return;
    void commit(brands.filter((x) => x !== b));
  }

  return (
    <section className="mt-5 rounded-lg border border-[#e5e7eb] bg-white px-4 py-4">
      <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
        Competitors tracked
      </h2>
      <p className="mt-1 text-[13px] text-inkMuted">
        Auto-detected competitors come from this week&rsquo;s landscape. Add any names
        the scan missed; manual additions are folded into next week&rsquo;s scan.
      </p>

      {detected.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-inkMuted">
            Detected this week
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {detected.map((b) => (
              <span
                key={`detected-${b}`}
                className="inline-flex items-center rounded-full border border-[#e5e7eb] bg-bone px-2 py-0.5 text-[12px] font-semibold text-ink/80"
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      )}

      {manualOnly.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-inkMuted">
            Manual additions
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {manualOnly.map((b) => (
              <span
                key={`manual-${b}`}
                className="inline-flex items-center gap-1 rounded-full border border-[#c9a24b]/40 bg-[#c9a24b]/10 px-2 py-0.5 text-[12px] font-semibold text-[#8a6d2c]"
              >
                {b}
                <button
                  type="button"
                  aria-label={`Remove ${b}`}
                  onClick={() => remove(b)}
                  disabled={saving}
                  className="ml-0.5 text-[#8a6d2c]/70 hover:text-[#8a6d2c] disabled:opacity-50"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a competitor…"
          maxLength={80}
          disabled={saving}
          className="flex-1 rounded-md border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[13px] text-ink placeholder:text-inkMuted focus:border-[#c9a24b] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving || input.trim().length === 0}
          className="rounded-cta border border-[#e5e7eb] bg-white px-3 py-1.5 text-[13px] font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)] hover:bg-bone disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {dropped > 0 && (
        <div className="mt-2 text-[12px] text-inkMuted">
          {dropped} {dropped === 1 ? "entry wasn’t" : "entries weren’t"} valid and{" "}
          {dropped === 1 ? "was" : "were"} dropped.
        </div>
      )}
      {error && (
        <div className="mt-2 text-[12px] text-red-600">{error}</div>
      )}
    </section>
  );
}

function dedupeBrands(brands: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of brands) {
    const brand = raw.trim();
    if (!brand) continue;
    const key = brand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(brand);
  }
  return out;
}

function SummaryCard({
  summary,
  sources,
}: {
  summary: ExecSummary;
  sources: ReportSource[];
}) {
  const lines = summaryLines(summary.prose_md, sources);
  const byN = new Map(sources.map((s) => [s.n, s]));
  const inlineCited = lines.flatMap((l) =>
    l.segments.flatMap((s) => (s.kind === "cite" ? [s.n] : [])),
  );
  const seen = new Set<number>();
  const cited: ReportSource[] = [];
  for (const n of [...inlineCited, ...summary.citations]) {
    if (seen.has(n)) continue;
    seen.add(n);
    const s = byN.get(n);
    if (s) cited.push(s);
  }
  const displayN = new Map(cited.map((s, i) => [s.n, i + 1]));

  const SUMMARY_COLLAPSED = 4;
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const overSummaryCap = lines.length > SUMMARY_COLLAPSED;
  const visibleLines =
    summaryExpanded || !overSummaryCap
      ? lines
      : lines.slice(0, SUMMARY_COLLAPSED);

  return (
    <section className="rounded-lg border border-[#e5e7eb] bg-white px-4 py-4">
      <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
        Summary
      </h2>

      {}
      {summary.stat_tiles.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-2">
          {summary.stat_tiles.map((t, i) => {
            const moved = !!t.prior_value && t.prior_value !== t.value;
            return (
              <div
                key={`${t.label}-${i}`}
                className={`rounded-md border px-2.5 py-1.5 ${
                  moved
                    ? "border-[#c9a24b]/40 bg-[#c9a24b]/10"
                    : "border-[#e5e7eb] bg-bone/40"
                }`}
              >
                <dd
                  className={`text-[16px] font-semibold tabular-nums ${
                    moved ? "text-[#8a6d2c]" : "text-ink"
                  }`}
                >
                  {t.value}
                  {moved && (
                    <span className="ml-1 text-[11px] font-normal text-inkMuted">
                      was {t.prior_value}
                    </span>
                  )}
                </dd>
                <dt className="mt-0.5 text-[11px] leading-snug text-inkMuted">
                  {t.label}
                  {t.as_of && (
                    <span className="text-inkMuted/70"> · {t.as_of}</span>
                  )}
                </dt>
              </div>
            );
          })}
        </dl>
      )}

      {}
      {lines.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {visibleLines.map((line, i) => (
            <li
              key={i}
              className={`flex gap-2 text-[13px] leading-[1.5] ${
                line.lead ? "text-ink" : "text-ink/90"
              }`}
            >
              <span
                aria-hidden
                className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${
                  line.lead ? "bg-[#c9a24b]" : "bg-ink/30"
                }`}
              />
              <span>
                {line.segments.map((seg, j) => {
                  const strong = seg.bold || line.lead;
                  return seg.kind === "cite" ? (
                    <a
                      key={j}
                      href={seg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={seg.title}
                      className="mx-0.5 align-super text-[11px] font-semibold text-[#8a6d2c] no-underline hover:underline"
                    >
                      [{displayN.get(seg.n) ?? seg.n}]
                    </a>
                  ) : (
                    <span key={j} className={strong ? "font-semibold" : undefined}>
                      {seg.text}
                    </span>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {overSummaryCap && (
        <button
          type="button"
          onClick={() => setSummaryExpanded((v) => !v)}
          className="mt-1.5 text-[12px] font-semibold text-[#8a6d2c] hover:underline"
        >
          {summaryExpanded ? "Show less" : "Show more"}
        </button>
      )}

      {}
      {cited.length > 0 && (
        <div className="mt-3 border-t border-[#e5e7eb] pt-2.5">
          <div className="text-[11px] font-mono uppercase tracking-wide text-inkMuted">
            Sources
          </div>
          <ul className="mt-1.5 space-y-1">
            {cited.map((s) => (
              <li key={s.n} className="text-[12px] leading-snug">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink hover:underline"
                >
                  <span className="font-semibold text-[#8a6d2c]">
                    [{displayN.get(s.n)}]
                  </span>{" "}
                  {s.title}
                </a>{" "}
                <span className="text-inkMuted">· {sourceDomain(s.url)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DeltaPanel({
  snapshot,
  historical = false,
}: {
  snapshot: CompetitorSnapshot;
  historical?: boolean;
}) {
  const delta = snapshot.delta;
  const moves = materialMoves(snapshot.landscape);
  const sources = reportSources(snapshot.landscape);
  const rosterAdded = delta?.added_brands ?? [];
  const rosterRemoved = delta?.removed_brands ?? [];
  const narrative = (delta?.narrative_md ?? "").trim();
  const hasRoster = rosterAdded.length > 0 || rosterRemoved.length > 0;
  const hasChanges = !!moves || hasRoster || narrative.length > 0;
  return (
    <section className="rounded-lg border border-[#e5e7eb] bg-white px-4 py-4">
      <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
        What changed {historical ? "that" : "this"} week
      </h2>
      {!hasChanges ? (
        <p className="mt-2 text-[13px] text-inkMuted">
          {delta
            ? `No material moves detected ${historical ? "that" : "this"} week.`
            : "First snapshot. Changes appear from the second scan onward."}
        </p>
      ) : (
        <>
          {}
          {moves && <MovesList moves={moves} sources={sources} />}

          {}
          {!moves && narrative.length > 0 && (
            <Markdown
              source={narrative}
              disableActionLinks
              className="mt-2 text-[13px]"
            />
          )}

          {}
          {hasRoster && (
            <div
              className={
                moves || narrative.length > 0
                  ? "mt-3 border-t border-[#e5e7eb] pt-2.5"
                  : "mt-2"
              }
            >
              {rosterAdded.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-inkMuted">
                    New to the set
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {rosterAdded.map((b) => (
                      <span
                        key={`add-${b}`}
                        className="rounded-full border border-[#c9a24b]/40 bg-[#c9a24b]/10 px-2 py-0.5 text-[12px] font-semibold text-[#8a6d2c]"
                      >
                        + {b}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {rosterRemoved.length > 0 && (
                <div className="mt-2.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-inkMuted">
                    No longer listed
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {rosterRemoved.map((b) => (
                      <span
                        key={`rm-${b}`}
                        className="rounded-full border border-[#e5e7eb] bg-bone px-2 py-0.5 text-[12px] text-inkMuted line-through"
                      >
                        − {b}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function MovesList({
  moves,
  sources,
}: {
  moves: MaterialMove[];
  sources: ReportSource[];
}) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return (
    <ul className="mt-2 space-y-2.5">
      {moves.map((m, i) => (
        <li key={`move-${i}`} className="text-[13px] leading-[1.5]">
          <span className="font-semibold text-ink">
            {m.competitor ? `${m.competitor}: ` : ""}
            {m.move}
          </span>
          {m.citations.map((n) => {
            const s = byN.get(n);
            return s ? (
              <a
                key={n}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="mx-0.5 align-super text-[11px] font-semibold text-[#8a6d2c] no-underline hover:underline"
              >
                [{n}]
              </a>
            ) : null;
          })}
          {m.why_now && (
            <span className="block text-ink/80"> {m.why_now}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

const REC_STATUS_LABEL: Record<RecStatus, string> = {
  act: "Acting",
  snooze: "Monitoring",
  dismiss: "Dismissed",
};

function RecommendedMoves({
  snapshot,
  onAskAgent,
  decisions,
  onSaveDecision,
  priorRecKeys,
}: {
  snapshot: CompetitorSnapshot;
  onAskAgent?: (agentSlug: string, text: string) => void;
  decisions: RecDecisionMap;
  onSaveDecision?: (
    rec_key: string,
    title: string,
    status: RecStatus | "clear",
  ) => Promise<RecDecisionMap>;
  priorRecKeys: Set<string>;
}) {
  const items = recommendationItems(snapshot.landscape);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  if (!items) return null;

  const seedText = (r: { title: string; body_md: string }) =>
    `From this week's competitor scan (week of ${snapshot.week_bucket}): ` +
    `"${r.title}": ${r.body_md.slice(0, 500)}\n\nHelp me turn this into a concrete plan I can execute this week.`;

  async function decide(key: string, title: string, status: RecStatus | "clear") {
    if (!onSaveDecision) return;
    if (status !== "clear") logRecEvent("decision", { status });
    setPending((p) => new Set(p).add(key));
    try {
      await onSaveDecision(key, title, status);
    } catch {
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(key);
        return n;
      });
    }
  }

  const order: Record<string, number> = { act: 0, undecided: 1, snooze: 2, dismiss: 3 };
  const decorated = items.map((r, i) => {
    const key = recKey(r.title);
    return {
      r,
      i,
      key,
      status: decisions[key]?.status,
      repeated: priorRecKeys.has(key),
    };
  });
  decorated.sort(
    (a, b) => order[a.status ?? "undecided"] - order[b.status ?? "undecided"] || a.i - b.i,
  );
  const dismissedCount = decorated.filter((d) => d.status === "dismiss").length;
  const visible = showDismissed
    ? decorated
    : decorated.filter((d) => d.status !== "dismiss");

  return (
    <section className="mt-5 rounded-lg border border-[#c9a24b]/40 bg-[#c9a24b]/5 px-4 py-4">
      <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
        Recommended moves
      </h2>
      <ul className="mt-2 space-y-3">
        {visible.map(({ r, key, status, repeated }) => {
          const isPending = pending.has(key);
          return (
            <li
              key={`rec-${key}`}
              className={`rounded-md border border-[#e5e7eb] bg-white px-3 py-3 ${
                status === "dismiss" ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-[16px] font-semibold text-ink">{r.title}</div>
                <span className="mt-0.5 shrink-0 rounded-full border border-[#e5e7eb] bg-bone px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-inkMuted">
                  {repeated ? "Repeated" : "New"}
                </span>
              </div>
              {r.body_md.trim().length > 0 && <RecBody body_md={r.body_md} />}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {}
                {onSaveDecision &&
                  (status ? (
                    <>
                      <span className="rounded-md border border-[#c9a24b]/40 bg-[#c9a24b]/10 px-2 py-1 text-[12px] font-semibold text-[#8a6d2c]">
                        {REC_STATUS_LABEL[status]}
                      </span>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => decide(key, r.title, "clear")}
                        className="rounded-cta px-1.5 py-1 text-[12px] font-semibold text-inkMuted hover:text-ink disabled:opacity-50"
                      >
                        Clear
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => decide(key, r.title, "act")}
                        className="rounded-cta border border-[#c9a24b]/50 bg-[#c9a24b]/15 px-2.5 py-1 text-[12px] font-semibold text-[#8a6d2c] hover:bg-[#c9a24b]/25 disabled:opacity-50"
                      >
                        Act now
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => decide(key, r.title, "snooze")}
                        className="rounded-cta border border-[#e5e7eb] bg-white px-2.5 py-1 text-[12px] font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)] hover:bg-bone disabled:opacity-50"
                      >
                        Monitor
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => decide(key, r.title, "dismiss")}
                        className="rounded-cta px-2 py-1 text-[12px] font-semibold text-inkMuted hover:text-ink disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                    </>
                  ))}
                {}
                {onAskAgent && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        logRecEvent("ask_agent", { agent_slug: "pm" });
                        onAskAgent("pm", seedText(r));
                      }}
                      className="rounded-cta border border-[#e5e7eb] bg-white px-2.5 py-1 text-[12px] font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)] hover:bg-bone"
                    >
                      Ask PM
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        logRecEvent("ask_agent", { agent_slug: "growth-lead" });
                        onAskAgent("growth-lead", seedText(r));
                      }}
                      className="rounded-cta border border-[#e5e7eb] bg-white px-2.5 py-1 text-[12px] font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)] hover:bg-bone"
                    >
                      Ask Growth lead
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {dismissedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowDismissed((v) => !v)}
          className="mt-2 text-[12px] font-semibold text-[#8a6d2c] hover:underline"
        >
          {showDismissed
            ? "Hide dismissed"
            : `Show ${dismissedCount} dismissed`}
        </button>
      )}
    </section>
  );
}

function RecBody({ body_md }: { body_md: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) return;
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const ps = root.querySelectorAll("p");
      const els: Element[] = ps.length > 0 ? Array.from(ps) : [root];
      setOverflowing(els.some((el) => el.scrollHeight > el.clientHeight + 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [body_md, expanded]);

  return (
    <div>
      <div ref={ref}>
        <Markdown
          source={body_md}
          disableActionLinks
          className={`mt-1 text-[13px] ${
            expanded ? "" : "[&_p]:line-clamp-2"
          }`}
        />
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[12px] font-semibold text-[#8a6d2c] hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function HistoryRow({
  snapshot,
  isSelected,
  onSelect,
}: {
  snapshot: CompetitorSnapshot;
  isSelected: boolean;
  onSelect: (weekBucket: string) => void;
}) {
  const n = brandCount(snapshot.landscape);
  const added = snapshot.delta?.added_brands.length ?? 0;
  const removed = snapshot.delta?.removed_brands.length ?? 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(snapshot.week_bucket)}
        aria-current={isSelected ? "true" : undefined}
        className={`flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 focus-visible:ring-inset ${
          isSelected ? "bg-bone" : ""
        }`}
      >
        <span className="text-[13px] font-semibold text-ink">
          Week of {formatWeek(snapshot.week_bucket)}
        </span>
        <span className="text-[13px] text-inkMuted">
          {n !== null ? `${n} competitor${n === 1 ? "" : "s"} tracked` : "report"}
          {added > 0 && (
            <span className="ml-2 font-semibold text-[#8a6d2c]">+{added}</span>
          )}
          {removed > 0 && <span className="ml-2">−{removed}</span>}
        </span>
      </button>
    </li>
  );
}

function CompetitorSkeleton() {
  return (
    <Frame>
      <div role="status" aria-busy="true" aria-label="Loading competitor intel…">
        <span className="sr-only">Loading competitor intel…</span>

        {}
        <section className="mt-5 rounded-lg border border-[#c9a24b]/40 bg-[#c9a24b]/5 px-4 py-4">
          <Skeleton className="h-4 w-40" />
          <div className="mt-3 space-y-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="space-y-2 rounded-md border border-[#e5e7eb] bg-white px-3 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-4 w-14 shrink-0" rounded="rounded-full" />
                </div>
                <Skeleton className="h-3 w-full" />
                <div className="flex gap-2 pt-1">
                  <Skeleton className="h-7 w-16" rounded="rounded-md" />
                  <Skeleton className="h-7 w-20" rounded="rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </section>

        {}
        <div className="mt-5 grid grid-cols-1 items-start gap-4 sm:grid-cols-[3fr,2fr]">
          <section className="rounded-lg border border-[#e5e7eb] bg-white px-4 py-4">
            <Skeleton className="h-4 w-24" />
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" rounded="rounded-md" />
              ))}
            </div>
            <div className="mt-3 space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </section>
          <section className="rounded-lg border border-[#e5e7eb] bg-white px-4 py-4">
            <Skeleton className="h-4 w-40" />
            <div className="mt-3 space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          </section>
        </div>

        {}
        <div className="mt-5">
          <Skeleton className="h-4 w-28" />
          <div className="mt-2 overflow-hidden rounded-lg border border-[#e5e7eb] bg-white">
            <div className="border-b border-[#e5e7eb] bg-bone/60 px-3 py-2">
              <Skeleton className="h-3 w-24" />
            </div>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`flex items-center gap-4 px-3 py-2.5 ${
                  i < 3 ? "border-b border-[#e5e7eb]" : ""
                }`}
              >
                <Skeleton className="h-3 w-24 shrink-0" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-24 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}

export function stripTrailingWeekOf(title: string): string {
  const stripped = title.replace(/\s*[—–-]\s*week of\b.*$/i, "").trim();
  return stripped.length > 0 ? stripped : title;
}

function formatWeek(weekBucket: string): string {
  const d = new Date(`${weekBucket}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return weekBucket;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
