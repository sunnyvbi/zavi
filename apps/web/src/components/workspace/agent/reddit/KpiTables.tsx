"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, Info, Link2, Search, Send } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ROW_ACTION } from "../../actions/ExtraTable";
import { dedupeBrandMentions } from "./extraTables";
import { requestReplyDraft } from "./shared";
import type { RedditInsights } from "./types";
import { agoShort, compactNumber, KeywordChip, relevanceLevel, ScorePill, SectionCard, subLabel, TonePill, ERROR_CLEAR_MS } from "./ui";

type Lists = RedditInsights["lists"];
type MaybeLists = Partial<Lists> | null | undefined;
type Opportunity = RedditInsights["opportunities"][number];

import { RedditTable as TableCard, ThreadCell, RedditTotals as TotalsRow, sumRedditMetrics as sum, TH, TD, TIGHT, TAIL, THREAD } from "./RedditTable";
import { BrandMentionsTable } from "./BrandMentionsTable";
export { BrandMentionsTable } from "./BrandMentionsTable";

const POST_COL = "w-full min-w-80 max-w-0";
const SPREAD = TIGHT;
const ACTION_SLOT = "flex h-8 items-center justify-end";
const OUTLINE_BTN = "inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-cta border border-rule bg-cream px-3 text-base font-medium text-ink hover:bg-bone disabled:opacity-50";

const POP_GAP = 8;
const POP_EDGE = 12;

function MatchedInfo({ terms }: { terms: string[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean; arrow: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const popId = useId();

  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    const { width, height } = pop.current.getBoundingClientRect();
    const fitsRight = r.left + width <= window.innerWidth - POP_EDGE;
    const left = fitsRight ? r.left - 4 : Math.max(POP_EDGE, r.right - width + 4);
    const up = r.bottom + POP_GAP + height > window.innerHeight - POP_EDGE && r.top - POP_GAP - height > POP_EDGE;
    const arrow = Math.min(width - 16, Math.max(16, r.left + r.width / 2 - left));
    setPos({ left, top: up ? r.top - POP_GAP - height : r.bottom + POP_GAP, up, arrow });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setPos(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!terms.length) return <span className="inline-block w-6" aria-hidden />;

  return (
    <span className="inline-flex">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popId : undefined}
        aria-label={`Show ${terms.length} matched keyword${terms.length === 1 ? "" : "s"}`}
        onClick={() => {
          setPos(null);
          setOpen((v) => !v);
        }}
        className={`-my-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 ${
          open ? "bg-bone text-ink" : "text-inkMuted"
        }`}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={pop}
            id={popId}
            role="dialog"
            aria-label="Matched keywords"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
            className={`workspace-shell z-50 w-max min-w-[180px] max-w-[280px] rounded-xl border border-rule bg-cream px-3 pb-3 pt-2.5 shadow-elev animate-fade-in ${
              pos?.up ? "origin-bottom-left" : "origin-top-left"
            }`}
          >
            <span
              aria-hidden
              style={{ left: (pos?.arrow ?? 16) - 5 }}
              className={`absolute h-2.5 w-2.5 rotate-45 border-rule bg-cream ${
                pos?.up ? "-bottom-[6px] border-b border-r" : "-top-[6px] border-l border-t"
              }`}
            />
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-inkMuted">
              Matched {terms.length === 1 ? "keyword" : `keywords · ${terms.length}`}
            </p>
            <ul className="flex flex-wrap gap-2">
              {terms.map((t) => (
                <li key={t}>
                  <KeywordChip>{t}</KeywordChip>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
}

function RelevanceCell({ value, terms }: { value: number; terms: string[] }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="grid h-5 grid-cols-[64px_22px_auto] items-center gap-x-2 sm:grid-cols-[96px_22px_auto]">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-bone"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v}
        aria-label="Relevance"
      >
        <div className="h-full rounded-full bg-[#2e7d32]" style={{ width: `${v}%` }} />
      </div>
      <span className="text-right text-[16px] font-semibold tabular-nums text-ink">{v}</span>
      <span className="inline-flex items-center gap-0.5">
        <span className="text-[16px] text-inkMuted">{relevanceLevel(v)}</span>
        <MatchedInfo terms={terms} />
      </span>
    </div>
  );
}

const num = (n: number | null | undefined) => (n === null || n === undefined ? "-" : compactNumber(n));

function DraftButton({ threadId, onChanged }: { threadId: string; onChanged: () => void }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (state !== "error") return;
    const id = setTimeout(() => setState("idle"), ERROR_CLEAR_MS);
    return () => clearTimeout(id);
  }, [state]);
  const draft = async () => {
    setState("busy");
    const err = await requestReplyDraft(threadId);
    setMessage(err ?? "");
    setState(err ? "error" : "done");
    if (!err) onChanged();
  };
  if (state === "done") return <TonePill tone="good">Drafted</TonePill>;
  return (
    <button type="button" disabled={state === "busy"} onClick={() => void draft()} className={ROW_ACTION} title={state === "error" ? message : undefined}>
      {state === "busy" ? "Drafting…" : state === "error" ? "Retry draft" : "Draft reply"}
    </button>
  );
}

const SENTIMENT_TONE = { positive: "good", neutral: "neutral", negative: "bad" } as const;

export { dedupeBrandMentions };

function GoogleChip({ g }: { g: Opportunity["google"] }) {
  if (g.rank !== null && g.rank <= 10) {
    return (
      <span className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-[#93b4f5] px-2 py-0.5 text-[13px] text-[#1d4ed8]">
        <Search className="h-3 w-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-semibold">Google #{g.rank}</span>
        {g.query && <span className="truncate">“{g.query}”</span>}
      </span>
    );
  }
  if (g.checked) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rule px-2 py-0.5 text-[13px] text-inkMuted">
        <Search className="h-3 w-3" aria-hidden /> Not on Google page 1
      </span>
    );
  }
  return <span className="text-[16px] text-inkMuted">-</span>;
}

function DraftStatus({ o, onChanged }: { o: Opportunity; onChanged: () => void }) {
  const d = o.draft;
  if (d?.state === "posted") return <TonePill tone="good"><Check className="mr-0.5 inline h-3 w-3" aria-hidden />Posted</TonePill>;
  if (d?.state === "proposed") return <TonePill tone="good"><Check className="mr-0.5 inline h-3 w-3" aria-hidden />In approval queue</TonePill>;
  if (d?.state === "drafted") return <TonePill tone="neutral">Drafted</TonePill>;
  return <DraftButton threadId={o.thread_id} onChanged={onChanged} />;
}

export function ReplyOpportunitiesTable({
  opportunities,
  total,
  threshold,
  onChanged,
}: {
  opportunities: Opportunity[];
  total: number;
  threshold: number;
  onChanged: () => void;
}) {
  const rows = opportunities.slice(0, 10);
  const hasCommentFit = rows.some((o) => o.comment_relevance !== null);
  const hasGoogle = rows.some((o) => o.google.checked || o.google.rank !== null);
  const totalsSpan = 2 + (hasCommentFit ? 1 : 0) + (hasGoogle ? 1 : 0);
  return (
    <TableCard
      title="Reply opportunities · last 7 days"
      sub={`Top ${rows.length} of ${total.toLocaleString("en-US")} threads where a useful reply fits, ranked by post and comment relevance. Nothing is posted by Zavi.`}
      empty={rows.length ? null : "No reply opportunities yet. Scan Reddit to find buyer questions."}
    >
      <thead>
        <tr className="border-b border-rule">
          <th scope="col" className={TH}>Thread</th>
          <th scope="col" className={`${TH} ${TIGHT} !px-2`}>Post fit</th>
          {hasCommentFit && <th scope="col" className={`${TH} ${TIGHT} !px-2`}>Comment fit</th>}
          {hasGoogle && <th scope="col" className={`${TH} ${TIGHT} !px-2`}>Google</th>}
          <th scope="col" className={`${TH} ${TIGHT} !px-2 text-right`}>Upvotes</th>
          <th scope="col" className={`${TH} ${TAIL}`}><span className="sr-only">Status</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.thread_id} className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50">
            <ThreadCell
              url={o.url}
              title={o.title}
              meta={[subLabel(o.subreddit), o.posted_at ? agoShort(o.posted_at) : null, o.comment_count !== null ? `${compactNumber(o.comment_count)} comments` : null].filter(Boolean).join(" · ")}
            />
            <td className={`${TD} ${TIGHT} !px-2`}><ScorePill value={o.post_relevance} threshold={threshold} /></td>
            {hasCommentFit && (
              <td className={`${TD} ${TIGHT} !px-2`}>{o.comment_relevance !== null ? <ScorePill value={o.comment_relevance} threshold={threshold} /> : <span className="text-[16px] text-inkMuted">-</span>}</td>
            )}
            {hasGoogle && <td className={`${TD} ${TIGHT} !px-2`}><GoogleChip g={o.google} /></td>}
            <td className={`${TD} ${TIGHT} !px-2 text-right text-[16px] tabular-nums text-ink`}>{num(o.score)}</td>
            <td className={`${TD} ${TAIL} text-right`}><div className={ACTION_SLOT}><DraftStatus o={o} onChanged={onChanged} /></div></td>
          </tr>
        ))}
      </tbody>
      <TotalsRow
        rows={rows.length}
        label={`${rows.length} thread${rows.length === 1 ? "" : "s"}`}
        span={totalsSpan}
        cells={[
          { key: "score", value: num(sum(rows.map((o) => o.score))), align: "right" },
          { key: "status", value: "" },
        ]}
      />
    </TableCard>
  );
}

export function RelevantPostsTable({ lists, total, scanned, threshold }: { lists: MaybeLists; total: number; scanned: number; threshold: number }) {
  const rows = (lists?.relevant_posts ?? []).slice(0, 10);
  return (
    <TableCard
      title="Relevant posts · today"
      sub={`Top ${rows.length} of ${total.toLocaleString("en-US")} posts scoring ${threshold} or more, out of ${scanned.toLocaleString("en-US")} scanned. Relevance is how closely the post matches your keywords and buyer intent.`}
      empty={rows.length ? null : `No posts scored ${threshold}+ today. Scan again later or add keywords.`}
    >
      <thead>
        <tr className="border-b border-rule">
          <th scope="col" className={`${TH} ${POST_COL}`}>Post</th>
          <th scope="col" className={`${TH} ${SPREAD} !px-2`}>Relevance</th>
          <th scope="col" className={`${TH} ${SPREAD} !pl-2 text-right`}>Upvotes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.thread_id} className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50">
            <ThreadCell
              width={POST_COL}
              url={p.url}
              title={p.title}
              meta={[subLabel(p.subreddit), p.posted_at ? agoShort(p.posted_at) : null, p.comment_count !== null && p.comment_count !== undefined ? `${compactNumber(p.comment_count)} comment${p.comment_count === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
            />
            <td className={`${TD} ${SPREAD} !px-2`}>
              <RelevanceCell value={p.relevance} terms={p.matched_terms} />
            </td>
            <td className={`${TD} ${SPREAD} !pl-2 text-right text-[16px] tabular-nums text-ink`}>{num(p.score)}</td>
          </tr>
        ))}
      </tbody>
      <TotalsRow
        rows={rows.length}
        label={`${rows.length} post${rows.length === 1 ? "" : "s"}`}
        span={2}
        cells={[
          { key: "score", value: num(sum(rows.map((p) => p.score))), align: "right" },
        ]}
      />
    </TableCard>
  );
}

export function RelevantCommentsTable({ lists, total, scanned, threshold }: { lists: MaybeLists; total: number; scanned: number; threshold: number }) {
  const rows = (lists?.relevant_comments ?? []).slice(0, 10);
  return (
    <TableCard
      title="Relevant comments · today"
      sub={`Top ${rows.length} of ${total.toLocaleString("en-US")} comments scoring ${threshold} or more, out of ${scanned.toLocaleString("en-US")} scanned, in threads matching your keywords. Each one is a person you can answer directly.`}
      empty={rows.length ? null : `No comments scored ${threshold}+ today.`}
    >
      <thead>
        <tr className="border-b border-rule">
          <th scope="col" className={TH}>Comment</th>
          <th scope="col" className={`${TH} ${TIGHT} !px-2`}>Relevance</th>
          <th scope="col" className={`${TH} ${TAIL}`}><span className="sr-only">Reply</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.comment_id} className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50">
            <td className={`${TD} ${THREAD}`}>
              {}
              <a href={c.url} target="_blank" rel="noreferrer" title={c.excerpt} className="group flex items-center gap-2">
                <span className="min-w-0 truncate text-[16px] leading-5 text-ink group-hover:underline">{c.excerpt}</span>
                <ExternalLink className="h-3 w-3 shrink-0 text-inkMuted" aria-hidden />
              </a>
              <p className="mt-0.5 truncate text-[13px] text-inkMuted" title={c.thread_title}>
                {[
                  c.author ? `u/${c.author}` : null,
                  subLabel(c.subreddit),
                  c.score !== null ? `${compactNumber(c.score)} upvote${c.score === 1 ? "" : "s"}` : null,
                  c.thread_title,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </td>
            <td className={`${TD} ${TIGHT} !px-2`}>
              <RelevanceCell value={c.relevance} terms={c.matched_terms} />
            </td>
            <td className={`${TD} ${TAIL} text-right`}>
              <div className={ACTION_SLOT}>
                <a href={c.url} target="_blank" rel="noreferrer" aria-label={`Reply on Reddit to ${c.author ? `u/${c.author}` : "this comment"}`} className={ROW_ACTION}>
                  Reply
                </a>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </TableCard>
  );
}
