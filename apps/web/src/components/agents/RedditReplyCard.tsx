"use client";

import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Link2, MessageCircle, Send } from "lucide-react";
import { RedditClampedBody } from "./RedditClampedBody";
import { WhyList, WhySection, WhyThisWorks } from "@/components/workspace/agent/reddit/ui";
import { markRedditSuggestionPosted, redditPublishKey, redditReplyItem } from "@/components/workspace/agent/reddit/publish";
import { redditPublishLabel, useRedditPublish } from "@/components/workspace/agent/reddit/useRedditPublish";

export type RedditReplyOpportunity = {
  id: string;
  action_source?: "channel_action" | "decision";
  type: "reddit_reply";
  subreddit?: string;
  thread_title: string;
  thread_url?: string;
  body: string;
  reply_style: string;
  rule_status: "ready" | "verify_manually" | "not_allowed";
  potential?: {
    level: "promising" | "moderate" | "weak";
    confidence: "low" | "medium" | "high";
    reasons: string[];
  };
};

const potentialTone = {
  promising: "bg-success/10 text-success",
  moderate: "bg-warn/10 text-warn",
  weak: "bg-bone text-inkMuted",
} as const;

const ruleCopy = {
  ready: "Verify rules",
  verify_manually: "Verify rules",
  not_allowed: "Do not reply",
} as const;

const btn = {
  primary:
    "inline-flex cursor-pointer items-center gap-2 rounded-cta bg-ink h-9 px-3 text-sm font-semibold text-cream hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "inline-flex cursor-pointer items-center gap-2 rounded-cta border border-rule bg-cream h-9 px-3 text-sm font-semibold text-inkSoft hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-50",
};

export function RedditDraftActions({
  copied,
  onCopy,
  onApprove,
  label,
  connected,
  posting = false,
  disabled = false,
}: {
  copied: boolean;
  onCopy: () => void;
  onApprove: () => void;
  label: string;
  connected: boolean;
  posting?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <IconButton
        type="button"
        disabled={disabled}
        onClick={onCopy}
        label={copied ? "Copied" : "Copy"}
        className={btn.secondary}
      >
        {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      </IconButton>
      <Button type="button" disabled={disabled || posting} onClick={onApprove} className={btn.primary}>
        {connected ? <Send className="h-4 w-4" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
        {label}
      </Button>
    </div>
  );
}

export function RedditPublishedPill({ status }: { status: "posted" | "scheduled" }) {
  return (
    <Badge className="inline-flex items-center gap-2 rounded-lg bg-successBg px-3 py-1.5 text-base font-semibold text-success">
      <Check className="h-4 w-4" aria-hidden />
      {status === "posted" ? "Posted" : "Scheduled"}
    </Badge>
  );
}

export function RedditReplyCard({
  opportunity,
  onChanged,
  connected = false,
}: {
  opportunity: RedditReplyOpportunity;
  onChanged?: () => void;
  connected?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copyReply = async () => {
    try {
      await navigator.clipboard.writeText(opportunity.body);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const blocked = opportunity.rule_status === "not_allowed";
  const sub = opportunity.subreddit?.replace(/^r\//i, "");
  const item = redditReplyItem(opportunity.id, opportunity.thread_url ?? "", opportunity.body, opportunity.rule_status);
  const { state, publish } = useRedditPublish(redditPublishKey(item), connected);
  const approve = () =>
    void publish(item, opportunity.body, async () => {
      const error = await markRedditSuggestionPosted(opportunity.id, opportunity.action_source);
      onChanged?.();
      return error;
    });

  return (
    <article className="overflow-hidden rounded-2xl border border-rule bg-cream">
      <div className="border-b border-rule px-4 py-3">
        <div className="flex items-center gap-2 text-base text-inkMuted">
          <MessageCircle className="h-4 w-4 text-inkMuted" aria-hidden />
          <span className="font-semibold text-ink">Reply opportunity</span>
          {sub && <span>in r/{sub}</span>}
        </div>
        {opportunity.thread_url ? (
          <a
            href={opportunity.thread_url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-start gap-2 text-sm font-semibold leading-5 text-ink hover:underline"
          >
            <span className="min-w-0 flex-1">{opportunity.thread_title}</span>
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          </a>
        ) : (
          <p className="mt-2 text-sm font-semibold leading-5 text-ink">
            {opportunity.thread_title}
          </p>
        )}
      </div>

      <div className="px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-bone px-2 py-1 text-detail font-medium text-inkMuted">
            {opportunity.reply_style}
          </span>
          {opportunity.potential && (
            <span
              className={cn("rounded-full px-2 py-1 text-detail font-semibold", potentialTone[opportunity.potential.level])}
            >
              {opportunity.potential.level.charAt(0).toUpperCase() +
                opportunity.potential.level.slice(1)}{" "}
              fit
            </span>
          )}
          <span
            className={cn("rounded-full px-2 py-1 text-detail font-medium", blocked ? "bg-coral/10 text-coral" : "bg-warn/10 text-warn")}
          >
            {ruleCopy[opportunity.rule_status]}
          </span>
        </div>

        <div className="mt-3">
          <RedditClampedBody text={opportunity.body} label="reply" className="text-sm leading-6 text-ink" />
        </div>
        {opportunity.potential && opportunity.potential.reasons.length > 0 && (
          <WhyThisWorks>
            <WhySection>
              <WhyList items={opportunity.potential.reasons} />
            </WhySection>
          </WhyThisWorks>
        )}
      </div>

      <div className="border-t border-rule bg-creamDeep px-4 py-3">
        {state.status === "posted" || state.status === "scheduled" ? (
          <RedditPublishedPill status={state.status} />
        ) : (
          <RedditDraftActions
            copied={copied}
            onCopy={() => void copyReply()}
            onApprove={approve}
            label={redditPublishLabel(state, connected)}
            connected={connected}
            posting={state.status === "posting"}
            disabled={blocked}
          />
        )}
        {state.error && (
          <p role="alert" className="mt-2 text-base text-coral">
            {state.error}
          </p>
        )}
      </div>

      {opportunity.potential && (
        <details className="border-t border-rule px-4 py-3">
          <summary className="cursor-pointer text-base font-medium text-ink">
            Why this is a fit
          </summary>
          <p className="mt-1 text-detail text-inkMuted">
            {opportunity.potential.confidence} confidence · directional
            assessment
          </p>
          <ul className="mt-2 space-y-1 text-base leading-5 text-inkMuted">
            {opportunity.potential.reasons.map((reason) => (
              <li key={reason}>• {reason}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
