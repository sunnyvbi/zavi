"use client";

import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Link2, MessageCircle, Send } from "lucide-react";
import type { RedditReplyOpportunity } from "@/components/agents/RedditReplyCard";
import type { RedditPayload } from "./shared";
import type { RedditInsights } from "./types";
import { OpportunityCard, strategyDefaultSubs, strategyVisibleOpportunities } from "./StrategyTab";
import { compactNumber, Delta, subLabel } from "./ui";
import { RedditClampedBody } from "@/components/agents/RedditClampedBody";
import { markRedditSuggestionPosted, redditPublishKey, redditReplyItem } from "./publish";
import { redditPublishLabel, useRedditPublish } from "./useRedditPublish";

const LINK_BTN =
  "inline-flex shrink-0 items-center whitespace-nowrap text-base font-semibold text-ink underline decoration-inkLight decoration-1 underline-offset-[5px] transition-colors hover:decoration-ink";
const BTN = "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-cta px-3 text-base font-semibold disabled:opacity-50";
const OUTLINE_BTN = `${BTN} border border-rule bg-cream text-ink hover:bg-bone`;
const PRIMARY_BTN = `${BTN} bg-ink text-cream hover:bg-inkSoft`;

function GlanceCard({
  id,
  title,
  sub,
  action,
  children,
}: {
  id: string;
  title: string;
  sub?: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-2xl border border-rule bg-cream p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={id} className="text-base font-semibold tracking-tight text-ink">
            {title}
          </h3>
          {sub && <p className="mt-0.5 text-base text-inkMuted">{sub}</p>}
        </div>
        {action}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

function ColumnHeads({ left, right }: { left: string; right: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 border-b border-rule pb-1.5 text-xs font-semibold uppercase tracking-wide text-inkMuted">
      <span className="min-w-0 flex-1 truncate">{left}</span>
      <span className="shrink-0">{right}</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-rule px-3 py-4 text-center text-base text-inkMuted">{children}</p>;
}

function GoToPost({ href, label = "Go to post" }: { href: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={OUTLINE_BTN}>
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

function useCopied() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return { copied, copy };
}

function Row({
  index,
  title,
  href,
  meta,
  body,
  actions,
  note,
}: {
  index: number;
  title: string;
  href: string | null;
  meta: ReactNode;
  body?: string | null;
  actions: ReactNode;
  note: string | null;
}) {
  return (
    <li className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <span className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bone text-base font-semibold tabular-nums text-ink sm:inline-flex">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="line-clamp-2 text-sm font-semibold leading-5 text-ink hover:underline">
              {title}
            </a>
          ) : (
            <p className="line-clamp-2 text-sm font-semibold leading-5 text-ink">{title}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-base text-inkMuted">{meta}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      </div>
      {body && (
        <div className="mt-2.5 rounded-xl bg-creamDeep px-3.5 py-3 sm:ml-10">
          <p className="text-xs font-semibold uppercase tracking-wide text-inkMuted">Suggested comment</p>
          <div className="mt-1">
            <RedditClampedBody text={body} label="comment" className="text-base leading-5 text-ink" />
          </div>
        </div>
      )}
      {note && (
        <p role="status" className="mt-1.5 text-base text-coral sm:ml-10">
          {note}
        </p>
      )}
    </li>
  );
}

function RunReplyRow({ index, r, connected, onChanged }: { index: number; r: RedditReplyOpportunity; connected: boolean; onChanged: () => void }) {
  const { copied, copy } = useCopied();
  const item = redditReplyItem(r.id, r.thread_url ?? "", r.body, r.rule_status);
  const { state, publish } = useRedditPublish(redditPublishKey(item), connected);
  const sub = r.subreddit?.replace(/^\/?r\//i, "");
  const href = r.thread_url ?? (sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/` : null);
  const allowed = r.rule_status !== "not_allowed";
  const approve = () =>
    void publish(item, r.body, async () => {
      const error = await markRedditSuggestionPosted(r.id, r.action_source);
      onChanged();
      return error;
    });
  return (
    <Row
      index={index}
      title={r.thread_title}
      href={r.thread_url ?? null}
      note={state.error}
      body={allowed ? r.body : null}
      meta={
        <>
          {sub && <span>{subLabel(sub)}</span>}
          <span>· drafted by your last run</span>
        </>
      }
      actions={
        <>
          {allowed && (
            <IconButton
              type="button"
              onClick={() => void copy(r.body)}
              label={copied ? "Copied" : "Copy"}
              className={OUTLINE_BTN}
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </IconButton>
          )}
          {href && <GoToPost href={href} label={r.thread_url ? "Go to post" : `Open ${subLabel(sub!)}`} />}
          {allowed &&
            (state.status === "posted" || state.status === "scheduled" ? (
              <Badge className="h-8 gap-2 rounded-cta bg-success/15 px-3 text-base font-semibold text-success">
                <Check className="h-3.5 w-3.5" aria-hidden /> {state.status === "posted" ? "Posted" : "Scheduled"}
              </Badge>
            ) : (
              <Button type="button" disabled={state.status === "posting"} onClick={approve} className={PRIMARY_BTN}>
                {connected ? <Send className="h-3.5 w-3.5" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
                {redditPublishLabel(state, connected)}
              </Button>
            ))}
        </>
      }
    />
  );
}

function OpportunitiesGlance({
  data,
  onChanged,
  onOpenStrategy,
}: {
  data: RedditPayload;
  onChanged: () => void;
  onOpenStrategy: () => void;
}) {
  const insights = data.insights?.has_data ? data.insights : null;
  const connected = data.account?.connected === true;
  const top = insights ? strategyVisibleOpportunities(data, strategyDefaultSubs(data)).slice(0, 2) : [];
  const runReplies =
    top.length > 0
      ? []
      : data.suggestions.filter((s): s is RedditReplyOpportunity => s.type === "reddit_reply").slice(0, 2);

  return (
    <GlanceCard
      id="glance-opportunities"
      title="Top comment opportunities"
      sub="Threads worth answering now. Review the reply, then approve it and Zavi posts it from your Reddit account."
      action={
        <Button type="button" onClick={onOpenStrategy} className={LINK_BTN}>
          See all
        </Button>
      }
    >
      {top.length > 0 ? (
        <div className="flex flex-col gap-[18px]">
          {top.map((o, i) => (
            <OpportunityCard key={o.thread_id} opportunity={o} rank={i + 1} onChanged={onChanged} connected={connected} />
          ))}
        </div>
      ) : runReplies.length > 0 ? (
        <ol className="divide-y divide-rule">
          {runReplies.map((r, i) => (
            <RunReplyRow key={r.id} index={i + 1} r={r} connected={connected} onChanged={onChanged} />
          ))}
        </ol>
      ) : (
        <Empty>No threads to answer yet. Scan Reddit to find buyer questions.</Empty>
      )}
    </GlanceCard>
  );
}

function KeywordsGlance({ data, onOpenKeywords }: { data: RedditPayload; onOpenKeywords: () => void }) {
  const keywords = data.workspace?.keywords ?? [];
  const stats = data.insights?.keyword_stats ?? {};
  const tracked = keywords
    .filter((k) => k.status === "tracking")
    .map((k) => ({ k, s: stats[k.id] }))
    .sort((a, b) => (b.s?.mentions_7d ?? -1) - (a.s?.mentions_7d ?? -1) || a.k.term.localeCompare(b.k.term))
    .slice(0, 3);
  const waiting = keywords.filter((k) => k.status === "suggested").length;

  return (
    <GlanceCard
      id="glance-keywords"
      title="Top keywords"
      action={
        <Button type="button" onClick={onOpenKeywords} className={LINK_BTN}>
          {waiting > 0 ? `${waiting} to review` : "Manage"}
        </Button>
      }
    >
      {tracked.length === 0 ? (
        <Empty>{waiting > 0 ? `${waiting} suggested keywords are waiting. Track the ones that fit.` : "No keywords tracked yet."}</Empty>
      ) : (
        <>
          <ColumnHeads left="Keyword" right="Mentions · 7d" />
          <ul className="space-y-3">
            {tracked.map(({ k, s }) => (
              <li key={k.id}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{k.term}</span>
                  <span
                    className={`text-base tabular-nums ${s && s.mentions_7d > 0 ? "font-semibold text-ink" : "text-inkMuted"}`}
                    title="Mentions in the last 7 days"
                  >
                    {s ? compactNumber(s.mentions_7d) : "-"}
                  </span>
                  {s && <Delta value={s.mentions_7d} previous={s.mentions_prev_7d} />}
                </div>
                {s && (
                  <p className="mt-0.5 truncate text-detail text-inkMuted">
                    {s.mentions_7d === 0
                      ? "No mentions in the last 7 days"
                      : [
                          s.top_subreddit ? `most in ${subLabel(s.top_subreddit)}` : null,
                          s.matches_today > 0 ? `${compactNumber(s.matches_today)} today` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "no subreddit stands out"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </GlanceCard>
  );
}

function SentimentMini({ s }: { s: RedditInsights["competitors"][number]["sentiment"] }) {
  if (!s || s.sample === 0) return null;
  const total = s.positive + s.neutral + s.negative || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <span
      className="inline-flex h-1.5 w-12 overflow-hidden rounded-full bg-bone"
      title={`Inferred by Zavi from ${s.sample} mentions: ${Math.round((s.positive / total) * 100)}% positive, ${Math.round((s.negative / total) * 100)}% negative`}
    >
      <span className="h-full bg-[#2e7d32]" style={{ width: pct(s.positive) }} />
      <span className="sentiment-neutral h-full" style={{ width: pct(s.neutral) }} />
      <span className="h-full bg-[#d64545]" style={{ width: pct(s.negative) }} />
    </span>
  );
}

function CompetitorsGlance({ data, onOpenCompetitors }: { data: RedditPayload; onOpenCompetitors: () => void }) {
  const fromInsights = (data.insights?.competitors ?? [])
    .filter((c) => !c.is_you)
    .sort((a, b) => b.mentions_7d - a.mentions_7d)
    .slice(0, 3);
  const saved = (data.workspace?.competitors ?? []).filter((c) => c.status === "tracking").slice(0, 3);

  return (
    <GlanceCard
      id="glance-competitors"
      title="Competitor activity"
      action={
        <Button type="button" onClick={onOpenCompetitors} className={LINK_BTN}>
          See all
        </Button>
      }
    >
      {fromInsights.length > 0 ? (
        <>
          <ColumnHeads left="Competitor" right="Mentions · 7d" />
          <ul className="space-y-3">
          {fromInsights.map((c) => (
            <li key={c.id ?? c.name}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{c.name}</span>
                <Delta value={c.mentions_7d} previous={c.mentions_prev_7d} />
                <span className="ml-1.5 inline-flex"><SentimentMini s={c.sentiment} /></span>
                <span className="ml-1.5 min-w-[1.5rem] text-right text-base tabular-nums text-inkMuted">{compactNumber(c.mentions_7d)}</span>
              </div>
              {c.latest_thread && (
                <a
                  href={c.latest_thread.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 flex items-center gap-1 text-detail text-inkMuted hover:text-ink"
                >
                  <MessageCircle className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{c.latest_thread.title}</span>
                </a>
              )}
            </li>
          ))}
          </ul>
        </>
      ) : saved.length > 0 ? (
        <ul className="space-y-1.5">
          {saved.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{c.name}</span>
              <span className="text-detail text-inkMuted">not scanned yet</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No competitors tracked yet.</Empty>
      )}
    </GlanceCard>
  );
}

export function OverviewGlance({
  data,
  onChanged,
  onOpenStrategy,
  onOpenKeywords,
  onOpenCompetitors,
}: {
  data: RedditPayload;
  onChanged: () => void;
  onOpenStrategy: () => void;
  onOpenKeywords: () => void;
  onOpenCompetitors?: () => void;
}) {
  return (
    <div aria-label="At a glance" role="region" className="space-y-[18px]">
      <OpportunitiesGlance data={data} onChanged={onChanged} onOpenStrategy={onOpenStrategy} />
      <div className="grid gap-[18px] md:grid-cols-2">
        <KeywordsGlance data={data} onOpenKeywords={onOpenKeywords} />
        <CompetitorsGlance data={data} onOpenCompetitors={onOpenCompetitors ?? onOpenKeywords} />
      </div>
    </div>
  );
}
