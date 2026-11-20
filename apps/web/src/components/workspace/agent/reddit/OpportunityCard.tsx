"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowBigUp, Check, ChevronDown, Clock, ExternalLink, MessageSquare, Search, ShieldAlert, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";
import { RedditDraftActions } from "@/components/agents/RedditReplyCard";
import { draftErrorMessage, send } from "./shared";
import { markRedditSuggestionPosted, redditPublishKey, redditReplyItem } from "./publish";
import { redditPublishLabel, useRedditPublish } from "./useRedditPublish";
import { compactNumber, relevanceLevel, subLabel, useTransientError } from "./ui";
import { pageOneRank, type Opportunity } from "./opportunitySelectors";
import { useOpportunityDeparture } from "./useOpportunityDeparture";
import { useRelativeAge } from "./useRelativeAge";

const FIT_TEXT = { High: "text-success", Medium: "text-warn", Low: "text-inkMuted" };
const GREEN_PILL = "bg-successBg text-success";
const GREY_PILL = "bg-bone text-inkMuted";
const PRIMARY_BTN = "inline-flex h-8 items-center gap-2 rounded-full bg-ink px-3.5 text-base font-semibold text-cream hover:opacity-90 disabled:opacity-60";

async function draftReply(threadId: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/reddit/threads/${encodeURIComponent(threadId)}/draft`, { method: "POST" });
    return res.ok ? null : await draftErrorMessage(res);
  } catch {
    return "Couldn't reach Zavi. Check your connection.";
  }
}

export function OpportunityCard({
  opportunity: o,
  rank,
  onChanged,
  glow = false,
  halfWidth = false,
  connected = false,
}: {
  opportunity: Opportunity;
  rank: number;
  onChanged?: () => void | Promise<void>;
  glow?: boolean;
  halfWidth?: boolean;
  connected?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "draft">(null);
  const [error, setError] = useTransientError();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const { postedLocal, leaving, gone, leaveAsPosted } = useOpportunityDeparture(onChanged);
  const draft = o.draft && o.draft.state !== "dismissed" ? o.draft : null;
  const rankOnGoogle = pageOneRank(o);

  const item = draft ? redditReplyItem(o.thread_id, o.url, draft.text, draft.rule_status) : null;
  const { state: publishState, publish } = useRedditPublish(item ? redditPublishKey(item) : `item:${o.thread_id}`, connected);

  const runDraft = async () => {
    if (busy) return;
    setBusy("draft");
    setError(null);
    const result = await draftReply(o.thread_id);
    setBusy(null);
    if (result) setError(result);
    else await onChanged?.();
  };

  const recordPosted = async (): Promise<string | null> => {
    if (!draft) return null;
    const card =
      draft.source === "run" && draft.decision_id
        ? await markRedditSuggestionPosted(draft.decision_id, draft.action_source ?? undefined)
        : null;
    const failed = await send(`/api/reddit/threads/${encodeURIComponent(o.thread_id)}`, "PATCH", { draft_state: "posted" });
    if (card) return card;
    return failed ? "Posted to Reddit, but Zavi could not mark this draft as posted. Refresh before posting again." : null;
  };

  const approve = async () => {
    if (!draft || !item) return;
    setError(null);
    const posted = await publish(item, draft.text, recordPosted);
    if (posted) leaveAsPosted();
  };

  const copy = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const age = useRelativeAge(o.posted_at);

  if (gone) return null;

  return (
    <div
      data-leaving={leaving || undefined}
      className={cn("grid transition-reddit-departure duration-reddit-departure ease-out motion-reduce:transition-none", leaving ? "grid-rows-reddit-collapsed -translate-y-1 opacity-0" : "grid-rows-reddit-expanded opacity-100")}
    >
    <div className={leaving ? "min-h-0 overflow-hidden" : "min-h-0"}>
    <article
      className={cn("flex h-full flex-col rounded-2xl border bg-cream p-4 transition-colors duration-500", glow ? "arrival-glow border-rule" : postedLocal ? "border-success/50" : "border-rule")}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold leading-none text-cream"
          aria-label={`Rank ${rank}`}
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-detail text-inkMuted">
            <span className="inline-flex items-center gap-2">
              <span className="font-medium text-inkSoft">{subLabel(o.subreddit)}</span>
              {age && (
                <>
                  <span aria-hidden className="text-inkLight">·</span>
                  <span>{age}</span>
                </>
              )}
            </span>
            {o.score !== null && (
              <span className="inline-flex items-center gap-1 tabular-nums" title="Upvotes">
                <ArrowBigUp className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">Upvotes:</span>
                {compactNumber(o.score)}
              </span>
            )}
            {o.comment_count !== null && (
              <span className="inline-flex items-center gap-1 tabular-nums" title="Comments">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">Comments:</span>
                {compactNumber(o.comment_count)}
              </span>
            )}
            <span className={cn("inline-flex items-center gap-2 font-medium", FIT_TEXT[relevanceLevel(o.post_relevance)])}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              <span title={`Post relevance ${Math.round(o.post_relevance)}/100`}>{relevanceLevel(o.post_relevance)} fit</span>
            </span>
          </div>
          <a
            href={o.url}
            target="_blank"
            rel="noreferrer"
            title={o.title}
            className="group mt-1.5 block text-sm font-semibold leading-6 text-ink"
          >
            <span className="line-clamp-2">
              <span className="group-hover:underline">{o.title}</span>
              <ExternalLink className="ml-1.5 inline-block h-3.5 w-3.5 -translate-y-px align-middle text-inkMuted" aria-hidden />
            </span>
          </a>
          {(o.matched_terms.length > 0 || o.google.checked) && (
          <div
            className={cn("mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5", halfWidth && !o.google.checked ? "md:hidden" : "")}
          >
            {o.matched_terms.length > 0 && (
              <span className={cn("contents", halfWidth ? "md:hidden" : "")}>
                <span className="text-detail text-inkMuted">Matched</span>
                {o.matched_terms.map((t) => (
                  <span
                    key={t}
                    className="max-w-full truncate rounded-md bg-bone px-1.5 py-0.5 text-detail font-medium text-inkSoft"
                  >
                    {t}
                  </span>
                ))}
              </span>
            )}
            {o.google.checked &&
              (rankOnGoogle !== null ? (
                <span
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-brand/40 bg-cream px-2 py-0.5 text-detail font-semibold text-brand"
                  title={o.google.query ? `Google #${rankOnGoogle} for "${o.google.query}"` : undefined}
                >
                  <Search className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="shrink-0">Google #{rankOnGoogle}</span>
                  {o.google.query && <span className="min-w-0 truncate font-medium">&ldquo;{o.google.query}&rdquo;</span>}
                </span>
              ) : (
                <Badge className={GREY_PILL}>Not on Google page 1</Badge>
              ))}
          </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex min-h-reddit-draft flex-1 flex-col">
        {draft ? (
          <div className="rounded-xl bg-bone p-3">
            <Button
              type="button"
              aria-expanded={expanded}
              aria-controls={`reddit-draft-${o.thread_id}`}
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-between gap-2 text-left text-detail font-semibold text-ink"
            >
              <span className="flex items-center gap-2">
                <span>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />Suggested comment
                </span>
                {draft.state === "proposed" && <span className="font-medium text-success">In approval queue</span>}
              </span>
              <ChevronDown
                className={cn("h-3.5 w-3.5 text-inkMuted transition-transform", expanded ? "rotate-180" : "")}
                aria-hidden
              />
              <span className="sr-only">{expanded ? "Show less" : "Show more"}</span>
            </Button>
            <p
              id={`reddit-draft-${o.thread_id}`}
              className={cn("mt-1.5 whitespace-pre-wrap text-base leading-relaxed text-inkSoft", expanded ? "" : "line-clamp-2")}
            >
              {draft.text}
            </p>
          </div>
        ) : (
          <p className="flex h-full items-center justify-center rounded-xl border border-dashed border-rule px-3 py-2.5 text-center text-base text-inkMuted">
            No draft yet. Zavi can write one for this thread.
          </p>
        )}
      </div>

      {(error || publishState.error) && (
        <p role="alert" className="mt-2 text-base text-danger">
          {error || publishState.error}
        </p>
      )}

      <div className="mt-3 border-t border-rule pt-3">
        {!draft ? (
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void runDraft()}
              className={PRIMARY_BTN}
            >
              {busy === "draft" ? "Drafting…" : "Draft reply"}
            </Button>
          </div>
        ) : draft.state === "posted" || postedLocal || publishState.status === "posted" ? (
          <Badge className={GREEN_PILL}>
            <Check className="h-3.5 w-3.5" aria-hidden /> Posted
          </Badge>
        ) : publishState.status === "scheduled" ? (
          <Badge className={GREEN_PILL}>
            <Clock className="h-3.5 w-3.5" aria-hidden /> Scheduled
          </Badge>
        ) : (
          <RedditDraftActions
            copied={copied}
            onCopy={() => void copy()}
            onApprove={() => void approve()}
            label={redditPublishLabel(publishState, connected)}
            connected={connected}
            posting={publishState.status === "posting"}
            disabled={draft.rule_status === "not_allowed"}
          />
        )}
      </div>
    </article>
    </div>
    </div>
  );
}

