"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AtSign,
  ChevronDown,
  Eye,
  FileText,
  MessageSquare,
  MessagesSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  Users,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { Pill } from "../dashboard-ui";
import { VERDICT_COPY, send, type Verdict, type Community, type RedditPayload } from "./shared";
import type { RedditInsights } from "./types";
import { agoShort, compactNumber, Delta, normSub, RelevanceBar, relevanceLevel, SectionCard, startSweep, subLabel, TonePill, type Tone, useTransientError } from "./ui";
import { OverviewGlance } from "./OverviewGlance";
import { BrandMentionsTable, RelevantCommentsTable, RelevantPostsTable, ReplyOpportunitiesTable } from "./KpiTables";
import { columnTemplate, TILE_MIN_PX } from "../../metrics/SummaryRow";

export type Metric = "brand" | "replies" | "posts" | "comments" | "subreddits";

const KPI_GAP_PX = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export function OverviewTab({
  data,
  onChanged,
  onOpenStrategy,
  onOpenKeywords,
  onOpenCompetitors,
}: {
  data: RedditPayload;
  onChanged: () => void;
  onOpenStrategy: (subreddit?: string) => void;
  onOpenKeywords: () => void;
  onOpenCompetitors?: () => void;
}) {
  const insights = data.insights && data.insights.has_data ? data.insights : null;
  const [metric, setMetric] = useState<Metric>("subreddits");
  const brandTerms = (data.workspace?.keywords ?? [])
    .filter((k) => k.type === "brand" && k.status === "tracking")
    .map((k) => k.term);

  if (data.insights_error) {
    return (
      <div className="space-y-[18px]">
        <div role="alert" className="rounded-2xl border border-rule bg-cream px-4 py-6 text-center text-[16px] text-ink">
          Couldn&apos;t load Reddit insights.{" "}
          <button type="button" onClick={onChanged} className="font-semibold underline underline-offset-2">
            Retry
          </button>
        </div>
        <CommunitiesSection data={data} onChanged={onChanged} />
      </div>
    );
  }

  return (
    <div className="space-y-[18px]">
      {insights ? (
        <>
          <ScanStats insights={insights} />
          <OverviewGlance
            data={data}
            onChanged={onChanged}
            onOpenStrategy={() => onOpenStrategy()}
            onOpenKeywords={onOpenKeywords}
            onOpenCompetitors={onOpenCompetitors}
          />
          <KpiRow insights={insights} selected={metric} onSelect={setMetric} />
          <div role="tabpanel" id="reddit-kpi-panel" aria-label="Details for the selected number">
            {metric === "brand" && (
              <BrandMentionsTable
                lists={insights.lists}
                total={insights.kpis.brand_mentions.value}
                terms={brandTerms}
                onChanged={onChanged}
                connected={data.account?.connected === true}
                communities={[...(data.workspace?.communities ?? []), ...(insights.communities ?? [])]}
              />
            )}
            {metric === "replies" && (
              <ReplyOpportunitiesTable
                opportunities={insights.opportunities}
                total={insights.kpis.reply_opportunities.value}
                threshold={insights.threshold}
                onChanged={onChanged}
              />
            )}
            {metric === "posts" && (
              <RelevantPostsTable
                lists={insights.lists}
                total={insights.kpis.relevant_posts.value}
                scanned={insights.kpis.relevant_posts.scanned}
                threshold={insights.threshold}
              />
            )}
            {metric === "comments" && (
              <RelevantCommentsTable
                lists={insights.lists}
                total={insights.kpis.relevant_comments.value}
                scanned={insights.kpis.relevant_comments.scanned}
                threshold={insights.threshold}
              />
            )}
            {metric === "subreddits" && (
              <SubredditTable data={data} insights={insights} onChanged={onChanged} onOpenStrategy={onOpenStrategy} />
            )}
          </div>
        </>
      ) : (
        <>
          <ScanEmptyState insights={data.insights ?? null} onChanged={onChanged} />
          <OverviewGlance
            data={data}
            onChanged={onChanged}
            onOpenStrategy={() => onOpenStrategy()}
            onOpenKeywords={onOpenKeywords}
            onOpenCompetitors={onOpenCompetitors}
          />
          <CommunitiesSection data={data} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-rule bg-cream px-4 py-6 text-center text-[16px] text-inkMuted">
      {children}
    </p>
  );
}

const SCAN_ERROR_MS = 6000;

export function useScan(insights: RedditInsights | null, onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = busy || insights?.sweep.last?.status === "running";
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const scan = async () => {
    setBusy(true);
    clear();
    setError(null);
    const err = await startSweep("manual");
    setBusy(false);
    setError(err);
    if (err) timer.current = setTimeout(() => setError(null), SCAN_ERROR_MS);
    else onChanged();
  };
  return { running, error, scan };
}

function scannedRecently(insights: RedditInsights): boolean {
  const last = insights.sweep.last;
  if (!last || (last.status !== "complete" && last.status !== "partial") || !last.finished_at) return false;
  const t = new Date(last.finished_at).getTime();
  return !Number.isNaN(t) && Date.now() - t < DAY_MS;
}

export function ScanControl({
  insights,
  running,
  scan,
}: {
  insights: RedditInsights;
  running: boolean;
  scan: () => void;
}) {
  const last = insights.sweep.last;
  const lastAt = last && (last.status === "complete" || last.status === "partial") ? last.finished_at : null;
  const lastFailed =
    last?.status === "failed"
      ? last.error_code === "no_data_returned"
        ? "Last scan read nothing from Reddit. Check your keywords and subreddits, or try again later."
        : ["all_jobs_failed", "no_jobs_run"].includes(last.error_code ?? "")
          ? "Last scan failed: Zavi couldn't read Reddit. Try again later."
          : "Last scan failed before it finished. Try again."
      : last?.status === "partial"
        ? "Last scan only partly finished."
        : null;
  const fresh = scannedRecently(insights);
  const blocked = !insights.sweep.enabled || insights.sweep.budget.exhausted;
  const blockedWhy = !insights.sweep.enabled
    ? "Reddit scanning is turned off."
    : insights.sweep.budget.exhausted
      ? "This week's scan budget is used up. Scans resume as the 7-day window rolls."
      : null;

  return (
    <div className="flex shrink-0 items-center gap-2 pl-3 text-[14px] text-inkMuted compact:text-[16px]">
      {}
      {!running && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full compact:hidden ${fresh ? "bg-[#2e7d32]" : "bg-rule"}`}
          aria-label={fresh ? "Scanned in the last 24 hours" : "No successful scan in the last 24 hours"}
          role="img"
        />
      )}
      {running ? (
        <span className="inline-flex items-center gap-2 font-medium" aria-live="polite">
          <RefreshCw className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          Scanning…
        </span>
      ) : (
        <>
          {lastFailed && (
            <span role="status" className="text-warn">
              {lastFailed}
            </span>
          )}
          {lastAt && <span className="whitespace-nowrap">Scanned {agoShort(lastAt)}</span>}
          <button
            type="button"
            disabled={blocked}
            onClick={() => void scan()}
            aria-label="Scan now"
            title={blockedWhy ?? "Scan now"}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-rule bg-cream text-ink hover:border-ink disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

export function ScanStats({ insights }: { insights: RedditInsights }) {
  const t = insights.today;
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="space-y-1">
      <div
        aria-label="Today's scan"
        className="grid gap-[14px]"
        style={{ gridTemplateColumns: columnTemplate(3, TILE_MIN_PX, KPI_GAP_PX) }}
      >
        <ScanFact label="Posts read today" icon={Eye} value={n(t.posts_scanned)} />
        <ScanFact label="Subreddits covered" icon={Users} value={n(t.communities_scanned)} />
        <ScanFact
          label="Worth replying to"
          icon={Target}
          value={n(t.posts_relevant)}
          title={`Posts scoring ${insights.threshold}+ out of 100 for relevance to your business`}
        />
      </div>
      {insights.sweep.budget.exhausted && (
        <p className="text-[16px] text-inkMuted">This week&apos;s scan budget is used up. Scans resume as the 7-day window rolls.</p>
      )}
      {!insights.sweep.enabled && <p className="text-[16px] text-inkMuted">Reddit scanning is turned off.</p>}
    </div>
  );
}

function ScanFact({
  label,
  icon: Icon,
  value,
  title,
}: {
  label: string;
  icon: LucideIcon;
  value: string;
  title?: string;
}) {
  return (
    <div className="rounded-2xl border border-rule bg-cream px-4 py-3" title={title}>
      <div className="flex items-center gap-2">
        <Icon className="h-[18px] w-[18px] shrink-0 text-inkSoft" aria-hidden />
        <span className="min-w-0 flex-1 text-[14px] font-semibold leading-tight text-ink">{label}</span>
      </div>
      <p className="mt-1.5 text-[22px] font-bold tabular-nums text-ink">{value}</p>
    </div>
  );
}

const Value = ({ children }: { children: ReactNode }) => (
  <span className="font-semibold tabular-nums text-ink">{children}</span>
);

function ScanEmptyState({ insights, onChanged }: { insights: RedditInsights | null; onChanged: () => void }) {
  const { running, error, scan } = useScan(insights, onChanged);
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-cream px-4 py-7 text-center">
      <p className="text-[14px] font-semibold text-ink">{running ? "Scanning Reddit…" : "No Reddit scan yet"}</p>
      <p className="mx-auto mt-1 max-w-md text-[16px] leading-5 text-inkMuted">
        Zavi reads today&apos;s posts in your subreddits and threads that mention your keywords and competitors, then
        scores each one for relevance. Counts, subreddits and comment opportunities appear here once it finishes.
      </p>
      <button
        type="button"
        disabled={running}
        onClick={() => void scan()}
        className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[16px] font-semibold text-cream disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} aria-hidden />
        {running ? "Scanning…" : "Scan Reddit now"}
      </button>
      {error && <p className="mt-2 text-[16px] text-coral">{error}</p>}
    </div>
  );
}

function KpiCard({
  label,
  icon: Icon,
  value,
  delta,
  selected,
  onSelect,
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  delta?: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const isZero = value === "0";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls="reddit-kpi-panel"
      onClick={onSelect}
      className={`relative flex min-w-0 flex-col-reverse gap-1 rounded-2xl border px-4 py-3.5 text-left transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-cream ${
        selected ? "border-transparent bg-transparent" : "border-rule bg-cream hover:border-ink/40 hover:bg-creamDeep"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={`h-4 w-4 shrink-0 ${selected ? "text-ink" : "text-inkSoft"}`} aria-hidden />
        <span className={`min-w-0 truncate text-[16px] font-medium ${selected ? "text-ink" : "text-inkMuted"}`} title={label}>
          {label}
        </span>
      </span>
      {}
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`text-[22px] font-bold leading-7 tabular-nums ${isZero ? "text-inkMuted" : "text-ink"}`}>{value}</span>
        {delta}
      </span>
    </button>
  );
}

export function KpiRow({
  insights,
  selected,
  onSelect,
}: {
  insights: RedditInsights;
  selected: Metric;
  onSelect: (m: Metric) => void;
}) {
  const k = insights.kpis;
  const pick = (m: Metric) => ({ selected: selected === m, onSelect: () => onSelect(m) });
  const { listRef, box } = useSlidingIndicator<HTMLElement>(selected);
  return (
    <section
      ref={listRef}
      aria-label="Headline numbers"
      role="tablist"
      data-testid="reddit-kpi-row"
      className="relative grid gap-[14px]"
      style={{ gridTemplateColumns: columnTemplate(5, TILE_MIN_PX, KPI_GAP_PX) }}
    >
      <SlidingIndicator box={box} className="rounded-2xl border border-ink bg-cream" />
      <KpiCard
        label="Brand mentions"
        icon={AtSign}
        {...pick("brand")}
        value={k.brand_mentions.value.toLocaleString("en-US")}
        delta={<Delta value={k.brand_mentions.value} previous={k.brand_mentions.previous} />}
      />
      <KpiCard
        label="Reply opportunities"
        icon={MessageSquare}
        {...pick("replies")}
        value={k.reply_opportunities.value.toLocaleString("en-US")}
        delta={<Delta value={k.reply_opportunities.value} previous={k.reply_opportunities.previous} />}
      />
      <KpiCard
        label="Relevant posts"
        icon={FileText}
        {...pick("posts")}
        value={k.relevant_posts.scanned === 0 ? "-" : k.relevant_posts.value.toLocaleString("en-US")}
        delta={
          k.relevant_posts.scanned === 0 ? (
            <span className="text-[13px] text-inkMuted">Not scanned today</span>
          ) : (
            <Delta value={k.relevant_posts.value} previous={k.relevant_posts.previous} />
          )
        }
      />
      <KpiCard
        label="Relevant comments"
        icon={MessagesSquare}
        {...pick("comments")}
        value={k.relevant_comments.scanned === 0 ? "-" : k.relevant_comments.value.toLocaleString("en-US")}
        delta={
          k.relevant_comments.scanned === 0 ? (
            <span className="text-[13px] text-inkMuted">Not scanned today</span>
          ) : (
            <Delta value={k.relevant_comments.value} previous={k.relevant_comments.previous} />
          )
        }
      />
      <KpiCard
        label="Subreddits saved"
        icon={Users}
        value={k.subreddits.value.toLocaleString("en-US")}
        {...pick("subreddits")}
      />
    </section>
  );
}

const SELF_PROMO: Record<Verdict | "null", { label: string; tone: Tone }> = {
  allowed: { label: "Allowed", tone: "good" },
  unclear: { label: "Limited", tone: "warn" },
  banned: { label: "Not allowed", tone: "bad" },
  null: { label: "Check rules", tone: "neutral" },
};

const SELECT_TONE: Record<Tone, string> = {
  good: "text-inkMuted",
  warn: "text-inkMuted",
  bad: "text-[#c0392b]",
  neutral: "text-inkMuted",
  orange: "text-inkMuted",
};

function useCommunityActions(onChanged: () => void) {
  const [error, setError] = useTransientError();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    const err = await fn();
    setBusy(false);
    setError(err);
    onChanged();
  }
  return { busy, error, run };
}

async function saveVerdict(name: string, savedRow: Community | undefined, verdict: Verdict | null): Promise<string | null> {
  if (savedRow) {
    return send(`/api/reddit/workspace/communities/${savedRow.id}`, "PATCH", { rules_verdict: verdict });
  }
  return send("/api/reddit/workspace/communities", "POST", {
    name,
    ...(verdict ? { rules_verdict: verdict } : {}),
    selected: verdict !== "banned",
  });
}

export function SubredditTable({
  data,
  insights,
  onChanged,
  onOpenStrategy,
}: {
  data: RedditPayload;
  insights: RedditInsights;
  onChanged: () => void;
  onOpenStrategy?: (subreddit?: string) => void;
}) {
  const saved = data.workspace?.communities ?? [];
  const savedByName = useMemo(() => new Map(saved.map((c) => [normSub(c.name), c])), [saved]);
  const { busy, error, run } = useCommunityActions(onChanged);
  const [showLow, setShowLow] = useState(false);
  const all = insights.communities.slice(0, 10);
  const isRelevant = (r: RedditInsights["communities"][number]) =>
    r.saved || r.recommended || (r.relevance !== null && relevanceLevel(r.relevance) !== "Low");
  const lowCount = all.filter((r) => !isRelevant(r)).length;
  const rows = showLow ? all : all.filter(isRelevant);
  const showSize = rows.some((r) => r.subscribers !== null || r.posts_per_day !== null);

  return (
    <SectionCard
      title="Relevant subreddits"
      headingId="reddit-communities"
      sub="Relevance out of 100: how closely each community's conversations match your business."
    >
      {error && <p className="mb-2 text-[16px] text-coral">{error}</p>}

      {all.length === 0 ? (
        <EmptyNote>No subreddits scored yet. Add the ones your buyers post in, then scan.</EmptyNote>
      ) : rows.length === 0 ? (
        <EmptyNote>No subreddit scored Medium or higher yet.</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-rule text-[16px] font-medium text-inkMuted">
                <th scope="col" className="w-7 py-2.5 pr-1 font-medium">#</th>
                <th scope="col" className="px-1.5 py-2.5 font-medium">Subreddit</th>
                <th scope="col" className="px-1.5 py-2.5 font-medium">Relevance</th>
                {showSize && (
                  <>
                    <th scope="col" className="px-1.5 py-2.5 text-right font-medium">Members</th>
                    <th scope="col" className="whitespace-nowrap px-1.5 py-2.5 text-right font-medium">Posts / day</th>
                  </>
                )}
                <th scope="col" className="px-1.5 py-2.5 pl-4 font-medium">Self-promo</th>
                <th scope="col" className="py-2.5 pl-1.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <SubredditRow
                  key={row.name}
                  index={i + 1}
                  row={row}
                  onOpenStrategy={onOpenStrategy && (() => onOpenStrategy(row.name))}
                  savedRow={savedByName.get(normSub(row.name))}
                  showSize={showSize}
                  busy={busy}
                  run={run}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lowCount > 0 && (
        <button
          type="button"
          onClick={() => setShowLow((v) => !v)}
          className="mt-3 text-[16px] font-semibold text-inkMuted hover:text-ink"
        >
          {showLow ? "Show less" : "Show more"}
        </button>
      )}
    </SectionCard>
  );
}

function SubredditRow({
  index,
  row,
  onOpenStrategy,
  savedRow,
  showSize,
  busy,
  run,
}: {
  index: number;
  row: RedditInsights["communities"][number];
  onOpenStrategy?: () => void;
  savedRow: Community | undefined;
  showSize: boolean;
  busy: boolean;
  run: (fn: () => Promise<string | null>) => Promise<void>;
}) {
  const bare = row.name.replace(/^\/?r\//i, "");
  const verdict = savedRow ? savedRow.rules_verdict : row.rules_verdict;
  const promo = SELF_PROMO[verdict ?? "null"];
  const postsPerDay =
    row.posts_per_day === null ? "-" : row.posts_per_day_capped ? `${row.posts_per_day}+` : String(row.posts_per_day);
  return (
    <tr className="border-b border-rule last:border-b-0">
      <td className="py-3.5 pr-1 align-middle text-[16px] tabular-nums text-inkMuted">{index}</td>
      <td className="px-1.5 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`https://www.reddit.com/r/${encodeURIComponent(bare)}/`}
            target="_blank"
            rel="noreferrer"
            className="text-[16px] font-semibold text-ink hover:underline"
          >
            {subLabel(bare)}
          </a>
          {row.recommended && <TonePill tone="orange">Recommended</TonePill>}
        </div>
        {row.relevance_why && <p className="mt-0.5 text-[13px] leading-4 text-inkMuted">{row.relevance_why}</p>}
      </td>
      <td className="px-1.5 py-3.5 align-middle">
        <RelevanceBar value={row.relevance} />
      </td>
      {showSize && (
        <>
          <td className="px-1.5 py-3.5 text-right align-middle text-[16px] tabular-nums text-ink">{compactNumber(row.subscribers)}</td>
          <td className="px-1.5 py-3.5 text-right align-middle text-[16px] tabular-nums text-ink">{postsPerDay}</td>
        </>
      )}
      <td className="px-1.5 py-3.5 pl-4 align-middle">
        <label className="sr-only" htmlFor={`self-promo-${bare}`}>
          Self-promo in {subLabel(bare)} (your reading of its rules)
        </label>
        <span className="relative inline-flex">
          <select
            id={`self-promo-${bare}`}
            disabled={busy}
            value={verdict ?? ""}
            title="Your own reading of the subreddit's rules page"
            onChange={(e) => {
              const next = (e.target.value || null) as Verdict | null;
              void run(() => saveVerdict(bare, savedRow, next));
            }}
            className={`h-7 cursor-pointer appearance-none rounded-md border-0 bg-transparent pl-0 pr-5 text-[16px] outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50 ${SELECT_TONE[promo.tone]}`}
          >
            <option value="allowed">{SELF_PROMO.allowed.label}</option>
            <option value="unclear">{SELF_PROMO.unclear.label}</option>
            <option value="banned">{SELF_PROMO.banned.label}</option>
            <option value="">{SELF_PROMO.null.label}</option>
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
        </span>
      </td>
      <td className="py-3.5 pl-1.5 text-right align-middle">
        {onOpenStrategy && (
        <button
          type="button"
          onClick={onOpenStrategy}
          aria-label={`See strategy for ${subLabel(bare)}`}
          className="inline-flex h-8 items-center whitespace-nowrap rounded-cta border border-rule bg-cream px-3 text-[16px] font-medium text-ink hover:bg-bone"
        >
          See strategy
        </button>
        )}
      </td>
    </tr>
  );
}

function AddCommunityForm({ busy, run }: { busy: boolean; run: (fn: () => Promise<string | null>) => Promise<void> }) {
  const [name, setName] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    void run(async () => {
      const err = await send("/api/reddit/workspace/communities", "POST", { name: value });
      if (!err) setName("");
      return err;
    });
  };
  return (
    <form onSubmit={add} className="flex gap-2">
      <label htmlFor="reddit-add-community" className="sr-only">
        Add a subreddit
      </label>
      <input
        id="reddit-add-community"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="r/smallbusiness"
        className="h-10 min-w-0 flex-1 rounded-full border border-rule bg-cream px-3.5 text-[16px] text-ink outline-none focus:border-ink"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="inline-flex h-10 items-center gap-1 rounded-full bg-ink px-3.5 text-[16px] font-semibold text-cream disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add
      </button>
    </form>
  );
}

function CommunityControls({
  name,
  savedRow,
  busy,
  run,
}: {
  name: string;
  savedRow: Community | undefined;
  busy: boolean;
  run: (fn: () => Promise<string | null>) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <a
        href={`https://www.reddit.com/r/${encodeURIComponent(name)}/about/rules`}
        target="_blank"
        rel="noreferrer"
        className="text-[16px] font-medium text-inkMuted underline underline-offset-2"
      >
        Open rules
      </a>
      <label className="sr-only" htmlFor={`verdict-${name}`}>
        What the rules of r/{name} say
      </label>
      <select
        id={`verdict-${name}`}
        disabled={busy}
        value={savedRow?.rules_verdict ?? ""}
        onChange={(e) => {
          const verdict = (e.target.value || null) as Verdict | null;
          void run(() => saveVerdict(name, savedRow, verdict));
        }}
        className="h-8 rounded-full border border-rule bg-cream px-2.5 text-[16px] text-ink"
      >
        <option value="">Rules: not checked</option>
        <option value="allowed">Founders may answer, product may be named</option>
        <option value="unclear">Unclear, it does not say</option>
        <option value="banned">Self promotion is banned</option>
      </select>
      {savedRow && (
        <>
          <button
            type="button"
            disabled={busy}
            aria-pressed={savedRow.selected}
            onClick={() =>
              void run(() => send(`/api/reddit/workspace/communities/${savedRow.id}`, "PATCH", { selected: !savedRow.selected }))
            }
            className={`rounded-full px-2.5 py-1 text-[16px] font-semibold ${
              savedRow.selected ? "bg-ink text-cream" : "bg-bone text-inkMuted"
            }`}
          >
            {savedRow.selected ? "Tracking" : "Paused"}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove r/${name}`}
            onClick={() => void run(() => send(`/api/reddit/workspace/communities/${savedRow.id}`, "DELETE"))}
            className="rounded-full p-1 text-inkMuted hover:bg-cream hover:text-ink"
          >
            <XIcon className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

function CommunitiesSection({ data, onChanged }: { data: RedditPayload; onChanged: () => void }) {
  const saved = data.workspace?.communities ?? [];
  const rows = data.overview?.top_communities ?? [];
  const { busy, error, run } = useCommunityActions(onChanged);
  const savedByName = useMemo(() => new Map(saved.map((c) => [c.name.toLowerCase(), c])), [saved]);

  return (
    <section aria-labelledby="reddit-communities" className="space-y-3">
      <div>
        <h3 id="reddit-communities" className="text-[16px] font-semibold tracking-tight text-ink">
          Top subreddits
        </h3>
        <p className="text-[16px] text-inkMuted">
          Where your buyers post. Open each one&apos;s rules and record what they say about self-promotion.
        </p>
      </div>
      <AddCommunityForm busy={busy} run={run} />
      {error && <p className="text-[16px] text-coral">{error}</p>}

      {rows.length === 0 ? (
        <EmptyNote>No communities yet. Add the ones your buyers post in, or run the channel.</EmptyNote>
      ) : (
        <ul className="divide-y divide-rule overflow-hidden rounded-2xl border border-rule bg-cream">
          {rows.map((row) => (
            <li key={row.name} className="space-y-2 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <a
                    href={`https://www.reddit.com/r/${encodeURIComponent(row.name)}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[14px] font-semibold text-ink hover:underline"
                  >
                    r/{row.name}
                  </a>
                  <p className="text-[16px] text-inkMuted">
                    {row.reply_opportunities} replies · {row.post_opportunities} posts in the latest run
                  </p>
                </div>
                {row.rules_verdict ? (
                  <Pill tone={VERDICT_COPY[row.rules_verdict].tone}>{VERDICT_COPY[row.rules_verdict].label}</Pill>
                ) : (
                  <Pill tone="neutral">Rules not checked</Pill>
                )}
              </div>
              <CommunityControls
                name={row.name}
                savedRow={savedByName.get(row.name.toLowerCase())}
                busy={busy}
                run={run}
              />
            </li>
          ))}
        </ul>
      )}
      {rows.some((r) => r.rules_verdict === "banned") && (
        <p className="text-[16px] text-inkMuted">
          Subreddits you marked as banning self-promotion are skipped by the next run.
        </p>
      )}
    </section>
  );
}
