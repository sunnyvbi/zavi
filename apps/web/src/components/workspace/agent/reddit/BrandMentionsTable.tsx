"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Link2, Send } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";
import { ROW_ACTION } from "../../actions/ExtraTable";
import { dedupeBrandMentions } from "./extraTables";
import { draftErrorMessage, send } from "./shared";
import { redditPublishKey, redditReplyItem } from "./publish";
import { redditPublishLabel, useRedditPublish } from "./useRedditPublish";
import type { RedditInsights } from "./types";
import { compactNumber, KeywordChip, subLabel, TonePill, ERROR_CLEAR_MS } from "./ui";
import { RelativeAge } from "./RelativeAge";
import { RedditTable, ThreadCell, RedditTotals as TotalsRow, sumRedditMetrics as sum, TH, TD, TIGHT, TAIL, ACTION_SLOT } from "./RedditTable";

type MaybeLists = Partial<RedditInsights["lists"]> | null | undefined;
const OUTLINE_BTN = "inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-cta border border-rule bg-cream px-3 text-base font-medium text-ink hover:bg-bone disabled:opacity-50";
const SENTIMENT_TONE = { positive: "good", neutral: "neutral", negative: "bad" } as const;
const num = (n: number | null | undefined) => n == null ? "-" : compactNumber(n);

type InlineDraft = { state: "busy" } | { state: "error"; message: string } | { state: "ready"; text: string; open: boolean };

function MentionDraftRow({
  threadId,
  url,
  text,
  colSpan,
  connected,
  posted,
  banned,
  onChanged,
}: {
  threadId: string;
  url: string;
  text: string;
  colSpan: number;
  connected: boolean;
  posted: boolean;
  banned: boolean;
  onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const item = redditReplyItem(threadId, url, text, banned ? "not_allowed" : null);
  const { state, publish } = useRedditPublish(redditPublishKey(item), connected, posted);
  const approve = () =>
    void publish(item, text, async () => {
      const failed = await send(`/api/reddit/threads/${encodeURIComponent(threadId)}`, "PATCH", { draft_state: "posted" });
      onChanged();
      return failed ? "Posted to Reddit, but Zavi could not mark this draft as posted. Refresh before posting again." : null;
    });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copyOnly = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <tr className="border-b border-rule bg-bone/60 last:border-0">
      <td colSpan={colSpan} className="px-3 py-3">
        <p className="text-detail font-medium text-inkMuted">Drafted reply</p>
        <p className="mt-1 whitespace-pre-wrap border-l-2 border-rule pl-3 text-base leading-5 text-ink">{text}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {state.status === "posted" || state.status === "scheduled" ? (
            <TonePill tone="good">{state.status === "posted" ? "Posted" : "Scheduled"}</TonePill>
          ) : (
            <Button
              type="button"
              disabled={state.status === "posting" || banned}
              onClick={approve}
              className="inline-flex h-8 items-center gap-2 rounded-cta bg-ink px-3 text-base font-semibold text-cream hover:bg-inkSoft disabled:opacity-50"
            >
              {connected ? <Send className="h-3 w-3" aria-hidden /> : <Link2 className="h-3 w-3" aria-hidden />}
              {redditPublishLabel(state, connected)}
            </Button>
          )}
          <IconButton
            type="button"
            onClick={() => void copyOnly()}
            label={copied ? "Copied" : "Copy"}
            className={OUTLINE_BTN}
          >
            {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          </IconButton>
        </div>
        {banned && (
          <p className="mt-2 text-base text-inkMuted">This community does not allow self-promotion, so Zavi won&apos;t post here. You can still copy the reply.</p>
        )}
        {state.error && (
          <p role="alert" className="mt-2 text-base text-coral">
            {state.error}
          </p>
        )}
      </td>
    </tr>
  );
}

async function requestDraft(threadId: string): Promise<{ text: string } | { error: string }> {
  try {
    const res = await apiFetch(`/api/reddit/threads/${encodeURIComponent(threadId)}/draft`, { method: "POST" });
    if (!res.ok) return { error: await draftErrorMessage(res) };
    const body = (await res.json().catch(() => null)) as { draft?: { text?: unknown } } | null;
    const text = typeof body?.draft?.text === "string" ? body.draft.text : "";
    return text ? { text } : { error: "Couldn't draft. Try again." };
  } catch {
    return { error: "Couldn't reach Zavi. Check your connection." };
  }
}

const BRAND_COLS = 7;

export function BrandMentionsTable({
  lists,
  total,
  terms,
  onChanged,
  connected = false,
  communities = [],
}: {
  lists: MaybeLists;
  total: number;
  terms: string[];
  onChanged: () => void;
  connected?: boolean;
  communities?: ReadonlyArray<{ name: string; rules_verdict: string | null }>;
}) {
  const rows = dedupeBrandMentions(lists?.brand_mentions ?? []);
  const bannedSubs = new Set(communities.filter((c) => c.rules_verdict === "banned").map((c) => c.name.replace(/^r\//i, "").toLowerCase()));
  const termText = terms.length ? terms.join(" and ") : "your brand";
  const [drafts, setDrafts] = useState<Record<string, InlineDraft>>({});
  const setDraft = (id: string, d: InlineDraft) => setDrafts((prev) => ({ ...prev, [id]: d }));
  const draft = async (threadId: string) => {
    setDraft(threadId, { state: "busy" });
    const r = await requestDraft(threadId);
    setDraft(threadId, "text" in r ? { state: "ready", text: r.text, open: true } : { state: "error", message: r.error });
    if (!("text" in r)) {
      setTimeout(
        () =>
          setDrafts((prev) => {
            if (prev[threadId]?.state !== "error") return prev;
            const next = { ...prev };
            delete next[threadId];
            return next;
          }),
        ERROR_CLEAR_MS,
      );
    }
    if ("text" in r) onChanged();
  };
  const allTerms = new Set(rows.flatMap((r) => r.terms));
  const showTerm = allTerms.size > 1;
  const cols = BRAND_COLS - (showTerm ? 0 : 1);
  return (
    <RedditTable
      title="Brand mentions · last 7 days"
      sub={`${total} mention${total === 1 ? "" : "s"} of ${termText} in what Zavi scanned. Newest first; sentiment is inferred by Zavi.`}
      empty={rows.length ? null : terms.length ? `No mentions of ${termText} in the last 7 days.` : "No brand mentions in the last 7 days. Track your brand name in Keywords, then scan."}
    >
      <thead>
        <tr className="border-b border-rule">
          <th scope="col" className={TH}>Thread</th>
          {showTerm && <th scope="col" className={cn(TH, TIGHT, "!px-2")}>Term</th>}
          <th scope="col" className={cn(TH, TIGHT, "!px-2")}>Sentiment</th>
          <th scope="col" className={cn(TH, TIGHT, "!px-2 text-right")}>Upvotes</th>
          <th scope="col" className={cn(TH, TIGHT, "!px-2 text-right")}>Comments</th>
          <th scope="col" className={cn(TH, TIGHT, "!px-2")}>Age</th>
          <th scope="col" className={cn(TH, TAIL)}><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const d = drafts[m.thread_id];
          return (
            <Fragment key={m.thread_id}>
              <tr className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50">
                <ThreadCell url={m.url} title={m.title} meta={`${subLabel(m.subreddit)}${m.author ? ` · u/${m.author}` : ""}`} />
                {showTerm && (
                  <td className={cn(TD, TIGHT, "!px-2")}>
                    <div className="flex flex-wrap gap-1">
                      {m.terms.map((t) => (
                        <KeywordChip key={t}>{t}</KeywordChip>
                      ))}
                    </div>
                  </td>
                )}
                <td className={cn(TD, TIGHT, "!px-2")} title="Inferred by Zavi from the post or comment text">
                  {m.sentiment ? (
                    <TonePill tone={SENTIMENT_TONE[m.sentiment]}>{m.sentiment[0].toUpperCase() + m.sentiment.slice(1)}</TonePill>
                  ) : (
                    <span className="text-base text-inkMuted">-</span>
                  )}
                </td>
                <td className={cn(TD, TIGHT, "!px-2 text-right text-base tabular-nums text-ink")}>{num(m.score)}</td>
                <td className={cn(TD, TIGHT, "!px-2 text-right text-base tabular-nums text-ink")}>{num(m.comment_count)}</td>
                <td className={cn(TD, TIGHT, "!px-2 text-base text-inkMuted")}>{<RelativeAge iso={m.observed_at} />}</td>
                <td className={cn(TD, TAIL, "text-right")}>
                  <div className={ACTION_SLOT}>
                  {m.draft?.state === "posted" && d?.state !== "ready" ? (
                    <TonePill tone="good"><Check className="mr-0.5 inline h-3 w-3" aria-hidden />Posted</TonePill>
                  ) : !d && m.draft?.state === "drafted" && m.draft.text ? (
                    <Button
                      type="button"
                      aria-expanded={false}
                      onClick={() => setDraft(m.thread_id, { state: "ready", text: m.draft!.text!, open: true })}
                      className={ROW_ACTION}
                    >
                      <ChevronDown className="h-3 w-3" aria-hidden />
                      Show draft
                    </Button>
                  ) : d?.state === "ready" ? (
                    <Button
                      type="button"
                      aria-expanded={d.open}
                      onClick={() => setDraft(m.thread_id, { ...d, open: !d.open })}
                      className={ROW_ACTION}
                    >
                      {d.open ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
                      {d.open ? "Hide draft" : "Show draft"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={d?.state === "busy"}
                      onClick={() => void draft(m.thread_id)}
                      className={ROW_ACTION}
                      title={d?.state === "error" ? d.message : undefined}
                    >
                      {d?.state === "busy" ? "Drafting…" : d?.state === "error" ? "Retry draft" : "Draft reply"}
                    </Button>
                  )}
                  </div>
                </td>
              </tr>
              {d?.state === "ready" && d.open && <MentionDraftRow threadId={m.thread_id} url={m.url} text={d.text} colSpan={cols} connected={connected} posted={m.draft?.state === "posted"} banned={bannedSubs.has(m.subreddit.replace(/^r\//i, "").toLowerCase())} onChanged={onChanged} />}
              {d?.state === "error" && (
                <tr className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50">
                  <td colSpan={cols} className="px-3 pb-2.5 text-right text-base text-coral" role="alert">
                    {d.message}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
      <TotalsRow
        rows={rows.length}
        label={`${rows.length} thread${rows.length === 1 ? "" : "s"}`}
        span={showTerm ? 3 : 2}
        cells={[
          { key: "score", value: num(sum(rows.map((m) => m.score))), align: "right" },
          { key: "comments", value: num(sum(rows.map((m) => m.comment_count))), align: "right" },
          { key: "age", value: "" },
          { key: "actions", value: "" },
        ]}
      />
    </RedditTable>
  );
}

