"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ExternalLink, Plus, RefreshCw, X as XIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { send, type Keyword, type Competitor, type RedditPayload } from "./shared";
import { LoadError, scrollToInPanel, useTransientError } from "./ui";
import type { RedditInsights } from "./types";

const KEYWORD_TYPES = ["problem", "brand", "product", "competitor", "category", "comparison", "industry"] as const;

const SOV_PALETTE = ["bg-ink", "bg-[#FF7A45]", "bg-[#4F7FE8]", "bg-[#9A6BE0]", "bg-[#2FAE7A]", "bg-[#E8B23A]", "bg-[#E0609A]", "bg-[#8A8A8A]"];

type KeywordStat = RedditInsights["keyword_stats"][string];
type CompetitorStat = RedditInsights["competitors"][number];

async function requestSuggestions(): Promise<{ error: string | null; added: number }> {
  try {
    const res = await apiFetch("/api/reddit/workspace/suggest", { method: "POST" });
    const body = (await res.json().catch(() => null)) as
      | { keywords_added?: number; competitors_added?: number; message?: string }
      | null;
    if (res.ok) return { error: null, added: (body?.keywords_added ?? 0) + (body?.competitors_added ?? 0) };
    return { error: body?.message ?? "Zavi couldn't draft suggestions right now. Try again in a minute.", added: 0 };
  } catch {
    return { error: "Couldn't reach Zavi. Check your connection.", added: 0 };
  }
}

type RowStatus = "suggested" | "tracking" | "paused" | "dismissed";

const MAX_SUGGESTIONS_SHOWN = 6;

const TRACKED_ROWS_SHOWN = 10;

const SUGGEST_NOTE_MS = 2000;

export function KeywordsTab({
  data,
  onChanged,
  competitorsArrival = 0,
  suggestedArrival = 0,
}: {
  data: RedditPayload;
  onChanged: () => void;
  competitorsArrival?: number;
  suggestedArrival?: number;
}) {
  const { on: competitorsGlow, target: competitorsRef } = useSectionArrival(competitorsArrival);
  const { on: suggestedGlow, target: suggestedRef } = useSectionArrival(suggestedArrival);
  const [overrides, setOverrides] = useState<Record<string, RowStatus>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const settledAt = useRef(new Map<string, unknown>());
  const workspaceRef = useRef(data.workspace);
  const [notice, setNotice] = useState<string | null>(null);
  const workspaceFailed = Boolean(data.workspace_error);
  const insightsFailed = Boolean(data.insights_error);
  const applied = <T extends { id: string; status: RowStatus }>(rows: T[]) =>
    rows.map((r) => (overrides[r.id] && overrides[r.id] !== r.status ? { ...r, status: overrides[r.id] } : r));
  const allKeywords = applied(data.workspace?.keywords ?? []);
  const allCompetitors = applied(data.workspace?.competitors ?? []).filter((c) => !removedIds.has(c.id));
  const keywords = allKeywords.filter((k) => k.status === "tracking" || k.status === "paused");
  const suggestedKeywords = allKeywords.filter((k) => k.status === "suggested");
  const insights = data.insights ?? null;
  const sovRows = (insights?.share_of_voice.items ?? []).filter((i) => i.mentions > 0 && !i.is_you).length;
  const stats = insights?.keyword_stats ?? {};

  const [showAllTracked, setShowAllTracked] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [comp, setComp] = useState("");
  const [error, setError] = useTransientError();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string | null>, onOk?: () => void) {
    setBusy(true);
    const err = await fn();
    setBusy(false);
    setError(err);
    if (!err) {
      onOk?.();
      onChanged();
    }
  }

  useEffect(() => {
    const server = new Map<string, RowStatus>();
    for (const r of [...(data.workspace?.keywords ?? []), ...(data.workspace?.competitors ?? [])]) server.set(r.id, r.status);
    workspaceRef.current = data.workspace;
    const settled = settledAt.current;
    const refreshed = new Set([...settled].filter(([, ws]) => ws !== data.workspace).map(([id]) => id));
    for (const id of refreshed) settled.delete(id);
    setOverrides((cur) => {
      const next = Object.fromEntries(
        Object.entries(cur).filter(([id, st]) => server.get(id) !== st && !refreshed.has(id)),
      );
      return Object.keys(next).length === Object.keys(cur).length ? cur : next;
    });
  }, [data.workspace]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!suggestNote) return;
    const t = setTimeout(() => setSuggestNote(null), SUGGEST_NOTE_MS);
    return () => clearTimeout(t);
  }, [suggestNote]);

  async function setStatus(kind: "keyword" | "competitor", id: string, label: string, status: RowStatus) {
    if (pendingIds.has(id)) return;
    settledAt.current.delete(id);
    setOverrides((o) => ({ ...o, [id]: status }));
    setPendingIds((p) => new Set(p).add(id));
    setError(null);
    setNotice(
      status === "tracking"
        ? `Now tracking “${label}”. It's in your tracked ${kind === "keyword" ? "keywords" : "competitors"} and the next scan uses it.`
        : status === "dismissed"
          ? `Dismissed “${label}”. Zavi won't suggest it again.`
          : null,
    );
    const err = await send(kind === "keyword" ? kwPath(id) : compPath(id), "PATCH", { status });
    setPendingIds((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
    if (err) {
      setOverrides((o) => {
        const n = { ...o };
        delete n[id];
        return n;
      });
      setNotice(null);
      setError(err);
      return;
    }
    settledAt.current.set(id, workspaceRef.current);
    onChanged();
  }

  async function suggest() {
    setSuggesting(true);
    setSuggestNote(null);
    const { error: err, added } = await requestSuggestions();
    setSuggesting(false);
    if (err) setSuggestNote(err);
    else if (added === 0) setSuggestNote("Nothing new to suggest right now.");
    onChanged();
  }

  async function removeCompetitor(id: string) {
    setRemovedIds((r) => new Set(r).add(id));
    setError(null);
    const err = await send(compPath(id), "DELETE");
    if (err) {
      setRemovedIds((r) => {
        const n = new Set(r);
        n.delete(id);
        return n;
      });
      setError(err);
      return;
    }
    onChanged();
  }

  const kwPath = (id: string) => `/api/reddit/workspace/keywords/${id}`;
  const compPath = (id: string) => `/api/reddit/workspace/competitors/${id}`;
  const hasSuggestions = suggestedKeywords.length > 0;
  const selectedSubs = (data.workspace?.communities ?? []).filter((c) => c.selected).length;
  const subCount = selectedSubs || insights?.kpis.subreddits.value || 0;

  return (
    <div className="space-y-[18px]">
      <p
        role="status"
        aria-live="polite"
        className={`rounded-xl border border-rule bg-bone/60 px-3 py-2 text-[16px] text-ink transition-opacity ${notice ? "opacity-100" : "hidden"}`}
      >
        {notice}
      </p>
      <div className="grid items-start gap-[18px] md:grid-cols-2">
        <section
          ref={suggestedRef}
          tabIndex={-1}
          aria-labelledby="reddit-suggested"
          className={`scroll-mt-4 rounded-2xl border bg-cream p-4 outline-none ${
            suggestedGlow ? "arrival-glow border-rule" : "border-rule"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <CardHead id="reddit-suggested" title="Suggested keywords" sub="Found by Zavi in threads your buyers write." />
            <button
              type="button"
              disabled={suggesting}
              onClick={() => void suggest()}
              aria-label="Refresh suggestions"
              title={suggesting ? "Thinking…" : "Refresh suggestions"}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-rule bg-cream text-ink hover:border-ink disabled:opacity-40"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${suggesting ? "animate-spin motion-reduce:animate-none" : ""}`}
                aria-hidden
              />
            </button>
          </div>
          {!hasSuggestions ? (
            <p className="mt-3 rounded-xl border border-dashed border-rule px-4 py-4 text-center text-[16px] text-inkMuted">
              {suggesting
                ? "Reading your business context…"
                : suggestNote ?? "No suggestions waiting. Ask Zavi for keywords worth watching."}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-rule">
              {suggestedKeywords.slice(0, MAX_SUGGESTIONS_SHOWN).map((k) => (
                <SuggestionRow
                  key={k.id}
                  label={k.term}
                  tag={k.type}
                  detail={statLine(stats[k.id]) ?? k.why ?? null}
                  busy={pendingIds.has(k.id)}
                  onTrack={() => void setStatus("keyword", k.id, k.term, "tracking")}
                />
              ))}
            </ul>
          )}
          {hasSuggestions && suggestNote && <p className="mt-2 text-[16px] text-inkMuted">{suggestNote}</p>}
        </section>

        <section aria-labelledby="reddit-custom" className="rounded-2xl border border-rule bg-cream p-4">
          <CardHead id="reddit-custom" title="Custom keywords" sub="Your brand, products and the phrases you want watched." />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!term.trim()) return;
              void run(() => send("/api/reddit/workspace/keywords", "POST", { term: term.trim() }), () => setTerm(""));
            }}
            className="mt-3 flex flex-wrap gap-2"
          >
            <label htmlFor="reddit-add-keyword" className="sr-only">
              Add a keyword
            </label>
            <input
              id="reddit-add-keyword"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Add a keyword or phrase"
              className="h-10 min-w-0 flex-1 rounded-lg border border-rule bg-cream px-3 text-[16px] text-ink outline-none focus:border-ink"
            />
            <button
              type="submit"
              disabled={busy || !term.trim()}
              className="h-10 shrink-0 rounded-cta bg-ink px-4 text-[16px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-40"
            >
              Add
            </button>
          </form>
          {keywords.length === 0 ? (
            <p className="mt-3 text-[16px] text-inkMuted">
              None yet. Add your brand name and the phrases a buyer who has never heard of you would type.
            </p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {keywords.map((k) => (
                <li
                  key={k.id}
                  className="inline-flex items-center gap-1 rounded-full border border-rule bg-bone py-1 pl-3 pr-1.5 text-[16px] font-medium text-ink"
                >
                  {k.term}
                  <button
                    type="button"
                    disabled={busy || pendingIds.has(k.id)}
                    aria-label={`Stop tracking ${k.term}`}
                    onClick={() => void setStatus("keyword", k.id, k.term, "dismissed")}
                    className="rounded-full p-0.5 text-inkMuted hover:bg-cream hover:text-ink"
                  >
                    <XIcon className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="reddit-tracked" className="rounded-2xl border border-rule bg-cream p-4">
        <CardHead
          id="reddit-tracked"
          title="Tracked keywords"
          sub={`${keywords.length} ${keywords.length === 1 ? "keyword" : "keywords"} watched${
            subCount ? ` across ${subCount} ${subCount === 1 ? "subreddit" : "subreddits"}` : ""
          }.`}
        />
        {workspaceFailed ? (
          <div className="mt-3">
            <LoadError what="your Reddit setup" onRetry={() => void onChanged()} />
          </div>
        ) : keywords.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-rule px-4 py-4 text-center text-[16px] text-inkMuted">
            No keywords tracked yet. Track a suggestion or add your own above.
          </p>
        ) : (
          <div className="-mx-4 mt-3 overflow-x-auto px-4">
            <table className="w-full min-w-[640px] text-left text-[16px]">
              <thead>
                <tr className="border-b border-rule text-[16px] text-inkMuted">
                  <Th>Keyword</Th>
                  <Th>Type</Th>
                  <Th>Mentions / 7d</Th>
                  <Th>Change</Th>
                  <Th>Top subreddit</Th>
                  <Th>Matches today</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {(showAllTracked ? keywords : keywords.slice(0, TRACKED_ROWS_SHOWN)).map((k) => (
                  <TrackedKeywordRow
                    key={k.id}
                    k={k}
                    stat={stats[k.id]}
                    busy={busy}
                    pending={pendingIds.has(k.id)}
                    onToggle={() =>
                      void setStatus("keyword", k.id, k.term, k.status === "tracking" ? "paused" : "tracking")
                    }
                    onType={(t) => void run(() => send(kwPath(k.id), "PATCH", { type: t }))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!workspaceFailed && keywords.length > TRACKED_ROWS_SHOWN && (
          <button
            type="button"
            aria-expanded={showAllTracked}
            onClick={() => setShowAllTracked((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-[16px] font-medium text-inkMuted underline-offset-2 hover:text-ink hover:underline"
          >
            {showAllTracked ? "Show less" : "Show more"}
            <ChevronDown
              className={`h-4 w-4 transition-transform motion-reduce:transition-none ${showAllTracked ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
        )}
      </section>

      {sovRows > 0 && (
        <section aria-labelledby="reddit-sov" className="rounded-2xl border border-rule bg-cream p-4">
          <CardHead
            id="reddit-sov"
            title="Share of voice on Reddit"
            sub="Competitor mentions across your tracked subreddits, last 7 days."
          />
          <ShareOfVoice sov={insights?.share_of_voice ?? null} />
        </section>
      )}

      <section
        ref={competitorsRef}
        tabIndex={-1}
        aria-labelledby="reddit-competitors"
        className={`scroll-mt-4 rounded-2xl border bg-cream p-4 outline-none ${
          competitorsGlow ? "arrival-glow border-rule" : "border-rule"
        }`}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <CardHead
            id="reddit-competitors"
            title="Competitors"
            sub="Where they come up, how people feel and the latest thread."
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!comp.trim()) return;
              void run(
                () => send("/api/reddit/workspace/competitors", "POST", { name: comp.trim() }),
                () => setComp(""),
              );
            }}
            className="flex gap-2 md:w-80"
          >
            <label htmlFor="reddit-add-competitor" className="sr-only">
              Add a competitor
            </label>
            <input
              id="reddit-add-competitor"
              value={comp}
              onChange={(e) => setComp(e.target.value)}
              placeholder="Add a competitor"
              className="h-10 min-w-0 flex-1 rounded-lg border border-rule bg-cream px-3 text-[16px] text-ink outline-none focus:border-ink"
            />
            <button
              type="submit"
              disabled={busy || !comp.trim()}
              aria-label="Add competitor"
              className="h-10 shrink-0 rounded-cta bg-ink px-4 text-[16px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-40"
            >
              Add
            </button>
          </form>
        </div>
        <ul className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-3 pt-1">
          {allCompetitors
            .filter((c) => c.status !== "dismissed")
            .map((c) => (
              <li key={c.id} className="group relative">
                <span
                  className={`inline-flex items-center gap-1 rounded-full border py-1 pl-3 text-[16px] font-medium ${
                    c.status === "suggested"
                      ? "border-dashed border-rule bg-cream pr-1.5 text-inkMuted"
                      : "border-rule bg-bone pr-3 text-ink"
                  }`}
                >
                  {brandName(c.name)}
                  {c.status === "suggested" && (
                    <button
                      type="button"
                      disabled={busy || pendingIds.has(c.id)}
                      onClick={() => void setStatus("competitor", c.id, c.name, "tracking")}
                      aria-label={`Track ${c.name}`}
                      title="Track it, so the next scan searches Reddit for it by name"
                      className="rounded-full p-0.5 text-inkMuted hover:bg-white hover:text-ink disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy || pendingIds.has(c.id)}
                  onClick={() =>
                    c.status === "suggested"
                      ? void setStatus("competitor", c.id, c.name, "dismissed")
                      : void removeCompetitor(c.id)
                  }
                  aria-label={`${c.status === "suggested" ? "Dismiss" : "Remove"} ${c.name}`}
                  className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-rule bg-cream text-inkMuted opacity-0 transition-opacity hover:border-ink hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40 motion-reduce:transition-none"
                >
                  <XIcon className="h-2.5 w-2.5" aria-hidden />
                </button>
              </li>
            ))}
        </ul>
        {workspaceFailed ? (
          <div className="mt-3">
            <LoadError what="your Reddit setup" onRetry={() => void onChanged()} />
          </div>
        ) : (
          <CompetitorsTable
            scanned={!!insights?.has_data}
            failed={insightsFailed}
            tracked={allCompetitors.filter((c) => c.status !== "dismissed")}
            stats={insights?.competitors ?? []}
          />
        )}
      </section>

      {error && <p className="text-[16px] text-coral">{error}</p>}
    </div>
  );
}

function useSectionArrival(arrival: number) {
  const [on, setOn] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!arrival) return;
    const el = target.current;
    if (!el) return;
    setOn(true);
    scrollToInPanel(el, "start");
    el.focus({ preventScroll: true });
    const id = setTimeout(() => setOn(false), 2600);
    return () => clearTimeout(id);
  }, [arrival]);
  return { on, target };
}

function brandName(name: string): string {
  return name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

function CardHead({ id, title, sub }: { id: string; title: string; sub: string }) {
  return (
    <div className="min-w-0">
      <h3 id={id} className="text-[16px] font-semibold tracking-tight text-ink">
        {title}
      </h3>
      <p className="mt-0.5 text-[16px] text-inkMuted">{sub}</p>
    </div>
  );
}

const CTH = "whitespace-nowrap bg-creamDeep px-4 py-2.5 text-[16px] font-semibold text-inkMuted";
const CTD = "px-4 py-3 align-top";

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap py-2 pr-4 font-medium">{children}</th>;
}

function TypePill({ type }: { type: string }) {
  return (
    <span
      className="inline-block rounded-md bg-bone px-2 py-0.5 text-[13px] font-medium capitalize text-inkMuted"
    >
      {type}
    </span>
  );
}

function TypeSelect({
  term,
  type,
  busy,
  onChange,
}: {
  term: string;
  type: string;
  busy: boolean;
  onChange: (type: string) => void;
}) {
  const current = type.toLowerCase();
  const options: string[] = (KEYWORD_TYPES as readonly string[]).includes(current)
    ? [...KEYWORD_TYPES]
    : [current, ...KEYWORD_TYPES];
  return (
    <select
      value={current}
      disabled={busy}
      aria-label={`Type for ${term}`}
      title="Change type"
      onChange={(e) => {
        if (e.target.value !== current) onChange(e.target.value);
      }}
      className="cursor-pointer appearance-none rounded-md border-0 bg-bone px-2 py-0.5 text-[13px] font-medium capitalize text-inkMuted outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-default"
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

const DASH = <span className="text-inkMuted">-</span>;

const MIN_SENTIMENT_SAMPLE = 5;

function statLine(s: KeywordStat | undefined): string | null {
  if (!s || s.mentions_7d <= 0) return null;
  const n = s.mentions_7d;
  return `${n.toLocaleString()} ${n === 1 ? "mention" : "mentions"} this week${s.top_subreddit ? ` · most in r/${s.top_subreddit}` : ""}`;
}

function oneLine(text: string): string {
  const at = text.search(/[.!?]\s/);
  const first = at >= 0 ? text.slice(0, at + 1) : text;
  return first.replace(/[.!?]+$/, "");
}

function Delta({ now, prev }: { now: number; prev: number | null | undefined }) {
  if (prev == null || prev === 0) return DASH;
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return <span className="text-inkMuted">0%</span>;
  const up = pct > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold ${up ? "text-[#167F50]" : "text-[#CB2029]"}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{up ? "up" : "down"} </span>
      {Math.abs(pct)}%
    </span>
  );
}

function threadAge(t: { posted_at: string | null; seen_at?: string }): string | null {
  const posted = t.posted_at ? new Date(t.posted_at).getTime() : NaN;
  const olderThanAWeek = Number.isFinite(posted) && Date.now() - posted > 7 * 24 * 60 * 60 * 1000;
  if (!olderThanAWeek) return ago(t.posted_at);
  const seen = ago(t.seen_at ?? null);
  return seen ? `seen ${seen}` : ago(t.posted_at);
}

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m || 1}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SuggestionRow({
  label,
  sub,
  tag,
  detail,
  busy,
  onTrack,
  onDismiss,
}: {
  label: string;
  sub?: string | null;
  tag?: string;
  detail: string | null;
  busy: boolean;
  onTrack: () => void;
  onDismiss?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[16px] font-medium text-ink">{label}</span>
          {sub && <span className="text-[16px] text-inkMuted">{sub}</span>}
          {tag && <TypePill type={tag} />}
        </div>
        {detail && (
          <p title={detail} className="mt-0.5 truncate text-[16px] leading-5 text-inkMuted">
            {oneLine(detail)}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onTrack}
        aria-label={`Track ${label}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-cta bg-ink px-2.5 py-1 text-[13px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-40"
      >
        <Plus className="h-3 w-3" aria-hidden /> Track
      </button>
      {onDismiss && (
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          aria-label={`Dismiss ${label}`}
          className="shrink-0 rounded-full p-1 text-inkMuted hover:bg-bone hover:text-ink disabled:opacity-40"
        >
          <XIcon className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

function StatusPill({
  tracking,
  label,
  busy,
  onToggle,
}: {
  tracking: boolean;
  label: string;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      aria-pressed={tracking}
      aria-label={`${tracking ? "Pause" : "Resume"} ${label}`}
      title={tracking ? "Click to pause" : "Click to resume"}
      onClick={onToggle}
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[16px] font-semibold ${
        tracking ? "bg-[#E8F5EE] text-[#167F50]" : "bg-bone text-inkMuted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tracking ? "bg-[#167F50]" : "bg-inkMuted"}`} aria-hidden />
      {tracking ? "Tracking" : "Paused"}
    </button>
  );
}

function TrackedKeywordRow({
  k,
  stat,
  busy,
  pending,
  onToggle,
  onType,
}: {
  k: Keyword;
  stat: KeywordStat | undefined;
  busy: boolean;
  pending: boolean;
  onToggle: () => void;
  onType: (type: string) => void;
}) {
  return (
    <tr>
      <td className="py-2.5 pr-4 font-medium text-ink">{k.term}</td>
      <td className="py-2.5 pr-4">
        <TypeSelect term={k.term} type={k.type} busy={busy} onChange={onType} />
      </td>
      <td className="py-2.5 pr-4 font-semibold text-ink">{stat ? stat.mentions_7d.toLocaleString() : DASH}</td>
      <td className="py-2.5 pr-4">{stat ? <Delta now={stat.mentions_7d} prev={stat.mentions_prev_7d} /> : DASH}</td>
      <td className="py-2.5 pr-4 text-ink">{stat?.top_subreddit ? `r/${stat.top_subreddit}` : DASH}</td>
      <td className="py-2.5 pr-4 text-ink">{stat ? stat.matches_today.toLocaleString() : DASH}</td>
      <td className="py-2.5 pr-4">
        <StatusPill tracking={k.status === "tracking"} label={k.term} busy={busy || pending} onToggle={onToggle} />
      </td>
    </tr>
  );
}

function ShareOfVoice({ sov }: { sov: RedditInsights["share_of_voice"] | null }) {
  const items = (sov?.items ?? [])
    .filter((i) => i.mentions > 0 && !i.is_you)
    .sort((a, b) => b.mentions - a.mentions);
  const total = items.reduce((n, i) => n + i.mentions, 0);
  if (!sov || total === 0) {
    return <p className="mt-4 text-[16px] text-inkMuted">No mentions counted yet. Scan Reddit to start.</p>;
  }
  const rows = items.map((i, idx) => ({
    ...i,
    pct: Math.round((i.mentions / total) * 100),
    color: SOV_PALETTE[idx % SOV_PALETTE.length],
  }));
  return (
    <div className="mt-4">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-bone"
        role="img"
        aria-label={`Share of voice: ${rows.map((r) => `${r.name} ${r.pct}%`).join(", ")}`}
      >
        {rows.map((r) => (
          <div key={r.name} className={`h-full ${r.color}`} style={{ width: `${(r.mentions / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[16px]">
        {rows.map((r) => (
          <li key={r.name} className="inline-flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${r.color}`} aria-hidden />
            <span className="text-inkMuted">{r.name}</span>
            <span className="font-semibold tabular-nums text-ink">{r.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sentiment({ s }: { s: CompetitorStat["sentiment"] }) {
  if (!s) return DASH;
  const sum = s.positive + s.neutral + s.negative;
  if (sum <= 0 || s.sample <= 0) return DASH;
  const pos = Math.round((s.positive / sum) * 100);
  const neg = Math.round((s.negative / sum) * 100);
  const neu = Math.max(0, 100 - pos - neg);
  const title = `Inferred by Zavi from post and comment text · ${s.sample.toLocaleString()} ${
    s.sample === 1 ? "mention" : "mentions"
  } read`;
  const line =
    s.sample < MIN_SENTIMENT_SAMPLE
      ? [
          s.positive > 0 ? `${s.positive} positive` : null,
          s.neutral > 0 ? `${s.neutral} neutral` : null,
          s.negative > 0 ? `${s.negative} negative` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : `${pos}% positive · ${neg}% negative`;
  return (
    <div title={title} className="w-max min-w-[128px]">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-bone" aria-hidden>
        <div className="h-full bg-[#2FAE7A]" style={{ width: `${pos}%` }} />
        <div className="sentiment-neutral h-full" style={{ width: `${neu}%` }} />
        <div className="h-full bg-[#E5484D]" style={{ width: `${neg}%` }} />
      </div>
      <p className="mt-1 whitespace-nowrap text-[16px] text-inkMuted">
        {line}
        <span className="sr-only">. {title}</span>
      </p>
    </div>
  );
}

function CompetitorsTable({
  tracked,
  stats,
  scanned,
  failed = false,
}: {
  tracked: Competitor[];
  stats: CompetitorStat[];
  scanned: boolean;
  failed?: boolean;
}) {
  const all = tracked
    .map((c) => ({
      c,
      stat: stats.find((s) => s.id === c.id && !s.is_you) ?? null,
      name: c.name,
      domain: c.domain,
    }))
    .sort((a, b) => (b.stat?.mentions_7d ?? 0) - (a.stat?.mentions_7d ?? 0) || a.name.localeCompare(b.name));
  const rows = all.filter((r) => (r.stat?.mentions_7d ?? 0) > 0);
  if (all.length === 0) {
    return (
      <p className="mt-3 rounded-xl border border-dashed border-rule px-4 py-4 text-center text-[16px] text-inkMuted">
        No competitors yet. Add one above and Zavi counts its mentions from what it has already read.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="mt-3 space-y-2">
        <p className="rounded-xl border border-dashed border-rule px-4 py-4 text-center text-[16px] text-inkMuted">
          {failed
            ? "Couldn't load this week's mention counts."
            : scanned
              ? "None of your competitors came up on Reddit this week."
              : "No mentions counted yet. Zavi fills this in after the first scan."}
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-rule">
      <table className="w-full min-w-[760px] text-left text-[16px]">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className={CTH}>Competitor</th>
            <th scope="col" className={`${CTH} w-px text-right`}>Mentions · 7d</th>
            <th scope="col" className={`${CTH} w-px`}>
              <span title="Inferred by Zavi from post and comment text">
                Sentiment <span className="font-normal">(inferred)</span>
              </span>
            </th>
            <th scope="col" className={`${CTH} w-px`}>Top subreddits</th>
            <th scope="col" className={CTH}>Latest thread</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map(({ c, stat, name, domain }) => (
            <tr key={c.id}>
              <td className={`${CTD} w-[150px] max-w-[150px]`}>
                <p className="truncate font-semibold text-ink">{brandName(name)}</p>
                {domain && <p className="truncate text-[13px] text-inkMuted">{domain}</p>}
              </td>
              {!stat || stat.mentions_7d === 0 ? (
                <>
                  <td className={`${CTD} text-right font-semibold tabular-nums text-inkLight`}>0</td>
                  <td colSpan={3} className={`${CTD} text-inkLight`}>
                    Nothing on Reddit this week
                  </td>
                </>
              ) : (
                <>
                  <td className={`${CTD} whitespace-nowrap tabular-nums`}>
                    <span className="flex items-center justify-end gap-2">
                      <span className="font-semibold text-ink">{stat.mentions_7d.toLocaleString()}</span>
                      {stat.mentions_prev_7d > 0 && (
                        <span className="text-[13px]">
                          <Delta now={stat.mentions_7d} prev={stat.mentions_prev_7d} />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={CTD}>
                    <Sentiment s={stat.sentiment ?? null} />
                  </td>
                  <td className={`${CTD} whitespace-nowrap`}>
                    {stat.top_subreddits.length > 0 ? (
                      <span className="flex items-center gap-1" title={stat.top_subreddits.map((x) => `r/${x}`).join(", ")}>
                        {stat.top_subreddits.slice(0, 1).map((x) => (
                          <span key={x} className="max-w-[140px] truncate rounded-md bg-bone px-2 py-0.5 text-[13px] text-inkMuted">
                            r/{x}
                          </span>
                        ))}
                        {stat.top_subreddits.length > 1 && (
                          <span className="text-[13px] text-inkMuted">+{stat.top_subreddits.length - 1}</span>
                        )}
                      </span>
                    ) : (
                      DASH
                    )}
                  </td>
                  <td className={`${CTD} w-full max-w-0`}>
                    {stat.latest_thread ? (
                      <>
                        <a
                          href={stat.latest_thread.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={stat.latest_thread.title}
                          className="group flex items-center gap-2 font-medium text-ink"
                        >
                          <span className="min-w-0 truncate group-hover:underline">{stat.latest_thread.title}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 text-inkMuted" aria-hidden />
                        </a>
                        <p className="truncate text-[13px] text-inkMuted">
                          r/{stat.latest_thread.subreddit}
                          {threadAge(stat.latest_thread) ? ` · ${threadAge(stat.latest_thread)}` : ""}
                        </p>
                      </>
                    ) : (
                      DASH
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

