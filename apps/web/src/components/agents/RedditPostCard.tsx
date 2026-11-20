"use client";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { useEffect, useRef, useState } from "react";
import {
  ArrowBigUp,
  Bookmark,
  Copy,
  Image as ImageIcon,
  Link2,
  MessageCircle,
  Send,
  Share2,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { markRedditSuggestionPosted, redditPostItem, redditPublishKey } from "@/components/workspace/agent/reddit/publish";
import { redditPublishLabel, useRedditPublish } from "@/components/workspace/agent/reddit/useRedditPublish";
import { RedditPublishedPill } from "./RedditReplyCard";
import { RedditClampedBody } from "./RedditClampedBody";
import { WhyList, WhyRationale, WhySection, WhyThisWorks } from "@/components/workspace/agent/reddit/ui";

export type RedditPostSuggestion = {
  id: string;
  action_source?: "channel_action" | "decision";
  type: "reddit_post";
  subreddit: string;
  title: string;
  body: string;
  post_type: "text" | "image";
  image_artifact_id?: string;
  style: string;
  affiliation_disclosure: "first_line" | "not_applicable";
  rule_status: "ready" | "verify_manually" | "not_allowed";
  required_flair?: string;
  potential: {
    level: "promising" | "moderate" | "weak";
    confidence: "low" | "medium" | "high";
    reasons: string[];
  };
  rationale?: string | null;
  evidence?: string[];
};

const potentialTone = {
  promising: "bg-success/10 text-success",
  moderate: "bg-warn/10 text-warn",
  weak: "bg-bone text-inkMuted",
} as const;

const ruleCopy = {
  ready: "Verify rules",
  verify_manually: "Verify rules",
  not_allowed: "Not allowed here",
} as const;

export function RedditPostCard({
  suggestion,
  onChanged,
  connected = false,
}: {
  suggestion: RedditPostSuggestion;
  onChanged?: () => void;
  connected?: boolean;
}) {
  const [copied, setCopied] = useState<"post" | "title" | "body" | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageState, setImageState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    setImageUrl(null);
    setImageState(suggestion.image_artifact_id ? "loading" : "idle");
    if (!suggestion.image_artifact_id) return;
    let live = true;
    void apiFetch(
      `/api/run-artifacts/${encodeURIComponent(suggestion.image_artifact_id)}/url`,
    )
      .then(async (res) =>
        res.ok ? ((await res.json()) as { signed_url?: string }) : {},
      )
      .then((data) => {
        if (!live) return;
        if (data.signed_url) {
          setImageUrl(data.signed_url);
          setImageState("ready");
        } else {
          setImageState("error");
        }
      })
      .catch(() => {
        if (live) setImageState("error");
      });
    return () => {
      live = false;
    };
  }, [suggestion.image_artifact_id]);

  const copy = async (kind: "post" | "title" | "body") => {
    const value =
      kind === "title"
        ? suggestion.title
        : kind === "body"
          ? suggestion.body
          : `${suggestion.title}\n\n${suggestion.body}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  };

  const sub = suggestion.subreddit.replace(/^r\//i, "");
  const item = redditPostItem(suggestion.id, {
    subreddit: sub,
    title: suggestion.title,
    text: suggestion.body,
    post_type: suggestion.post_type,
    required_flair: suggestion.required_flair,
    rule_status: suggestion.rule_status,
  });
  const { state, publish } = useRedditPublish(redditPublishKey(item), connected);
  const approve = () =>
    void publish(item, suggestion.body, async () => {
      const error = await markRedditSuggestionPosted(suggestion.id, suggestion.action_source);
      onChanged?.();
      return error;
    });
  const blocked = suggestion.rule_status === "not_allowed";
  const imageUnavailable =
    suggestion.post_type === "image" && imageState !== "ready";

  return (
    <article className="overflow-hidden rounded-2xl border border-rule bg-cream">
      <div className="flex items-center gap-2 border-b border-rule bg-creamDeep px-4 py-2.5">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-base font-bold text-cream"
          aria-hidden
        >
          r/
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink">
            r/{sub}
          </p>
          <p className="text-detail text-inkMuted">
            Suggested post
          </p>
        </div>
        {suggestion.required_flair && (
          <span className="max-w-36 truncate rounded-full bg-creamDeep px-2 py-1 text-detail font-medium text-inkMuted">
            {suggestion.required_flair}
          </span>
        )}
      </div>

      <div className="px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-bone px-2 py-1 text-detail font-medium text-inkMuted">
            {suggestion.style}
          </span>
          {suggestion.affiliation_disclosure === "first_line" && (
            <span className="rounded-full bg-success/10 px-2 py-1 text-detail font-medium text-success">
              Affiliation disclosed
            </span>
          )}
          <span
            className={cn("rounded-full px-2 py-1 text-detail font-semibold", potentialTone[suggestion.potential.level])}
          >
            {suggestion.potential.level.charAt(0).toUpperCase() +
              suggestion.potential.level.slice(1)}{" "}
            potential
          </span>
          <span
            className={cn("rounded-full px-2 py-1 text-detail font-medium", blocked ? "bg-coral/10 text-coral" : "bg-warn/10 text-warn")}
          >
            {ruleCopy[suggestion.rule_status]}
          </span>
        </div>

        <h3 className="mt-3 text-xl font-semibold leading-6 text-ink">
          {suggestion.title}
        </h3>
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt="Suggested Reddit post visual"
            className="mt-3 max-h-80 w-full rounded-xl bg-bone object-contain"
          />
        )}
        {suggestion.post_type === "image" && !imageUrl && (
          <div className="mt-3 flex h-28 items-center justify-center rounded-xl border border-dashed border-rule bg-bone text-base text-inkMuted">
            <ImageIcon className="mr-2 h-4 w-4" aria-hidden />{" "}
            {imageState === "error"
              ? "Image unavailable. Run again"
              : "Loading image…"}
          </div>
        )}
        <div className="mt-3">
          <RedditClampedBody text={suggestion.body} label="post" className="text-sm leading-6 text-ink" />
        </div>
        {(suggestion.rationale || suggestion.potential.reasons.length > 0 || (suggestion.evidence?.length ?? 0) > 0) && (
          <WhyThisWorks>
            {suggestion.rationale && (
              <WhySection>
                <WhyRationale text={suggestion.rationale} />
              </WhySection>
            )}
            {suggestion.potential.reasons.length > 0 && (
              <WhySection title="Signals">
                <WhyList items={suggestion.potential.reasons} />
              </WhySection>
            )}
            {(suggestion.evidence?.length ?? 0) > 0 && (
              <WhySection title="Evidence">
                <WhyList items={suggestion.evidence!} tone="muted" />
              </WhySection>
            )}
          </WhyThisWorks>
        )}
      </div>

      <div
        className="flex items-center gap-4 border-t border-rule px-4 py-2 text-base text-inkMuted"
        aria-hidden
      >
        <span className="flex items-center gap-1">
          <ArrowBigUp className="h-5 w-5" aria-hidden /> Vote
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle className="h-3.5 w-3.5" /> Comment
        </span>
        <span className="flex items-center gap-1">
          <Share2 className="h-3.5 w-3.5" /> Share
        </span>
        <Bookmark className="ml-auto h-3.5 w-3.5" />
      </div>

      <div className="border-t border-rule bg-creamDeep px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {state.status === "posted" || state.status === "scheduled" ? (
            <RedditPublishedPill status={state.status} />
          ) : (
            <Button
              type="button"
              disabled={blocked || imageUnavailable || state.status === "posting"}
              onClick={approve}
              className="inline-flex cursor-pointer items-center gap-2 rounded-cta bg-ink h-10 px-3 text-sm font-semibold text-cream hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-40"
            >
              {connected ? <Send className="h-3.5 w-3.5" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
              {redditPublishLabel(state, connected)}
            </Button>
          )}
          <Button
            type="button"
            disabled={blocked || imageUnavailable}
            onClick={() => void copy("post")}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-rule bg-cream px-3 text-base font-medium text-ink hover:bg-bone disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />{" "}
            {copied === "post" ? "Copied" : "Copy post"}
          </Button>
          <Button
            type="button"
            disabled={blocked}
            onClick={() => void copy("title")}
            className="h-10 rounded-full border border-rule bg-cream px-3 text-base font-medium text-ink hover:bg-bone disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied === "title" ? "Title copied" : "Copy title"}
          </Button>
          <Button
            type="button"
            disabled={blocked}
            onClick={() => void copy("body")}
            className="h-10 rounded-full border border-rule bg-cream px-3 text-base font-medium text-ink hover:bg-bone disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied === "body" ? "Body copied" : "Copy body"}
          </Button>
          {imageUrl && !blocked && (
            <a
              href={imageUrl}
              download
              className="ml-auto text-base font-medium text-inkMuted underline underline-offset-2"
            >
              Download image
            </a>
          )}
        </div>
        {state.error && (
          <p role="alert" className="mt-2 text-base text-coral">
            {state.error}
          </p>
        )}
      </div>

    </article>
  );
}
