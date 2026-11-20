import {
  AtSign,
  CalendarDays,
  CircleDollarSign,
  FileText,
  Gauge,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
  Percent,
  Receipt,
  Target,
  Users,
  Wallet,
} from "lucide-react";
import { SOCIAL_LIMITS, xWeightedLength } from "@zavi/shared";
import { redditSubmitUrl } from "@/lib/reddit/handoff";
import type { MetricDisplay } from "../../metrics/SummaryRow";
import { actionLink, type ActionItem } from "../types";

export function xIntentUrl(text: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

export type RedditPresentation = {
  type?: string;
  thread_url?: string;
  subreddit?: string;
  title?: string;
  post_type?: string;
  rule_status?: string;
  required_flair?: string;
};

export function redditPresentation(a: ActionItem): RedditPresentation | null {
  const d = a.body?.step?.deliverable as { presentation?: unknown } | null | undefined;
  const p = d?.presentation;
  return p && typeof p === "object" ? (p as RedditPresentation) : null;
}

export const THREAD_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/i;

export function bareSubreddit(p: { subreddit?: string } | null): string {
  return (p?.subreddit ?? "").replace(/^\/?r\//i, "").trim();
}

export function redditTargetUrl(a: ActionItem): string | null {
  const p = redditPresentation(a);
  if (p?.type === "reddit_post") {
    const sub = bareSubreddit(p);
    return sub ? redditSubmitUrl(sub) : null;
  }
  if (a.action_type !== "reply") return null;
  const link = actionLink(a);
  if (link && THREAD_RE.test(link)) return link;
  const u = (p?.thread_url ?? "").trim();
  return THREAD_RE.test(u) ? u : null;
}

export type RedditPublishTarget =
  | { channel: "reddit"; fields: { subreddit: string; title: string } }
  | { channel: "reddit_comment"; fields: { thread_url: string } };

export function redditPublishTarget(a: ActionItem): RedditPublishTarget | string {
  const p = redditPresentation(a);
  if (p?.rule_status === "not_allowed") return "This community's rules don't allow it, so Zavi won't post it.";
  if (p?.type === "reddit_post") {
    const subreddit = bareSubreddit(p);
    const title = (p.title ?? "").trim();
    if (p.post_type === "image") return "Zavi can't post image posts to Reddit yet.";
    if (p.required_flair) return `r/${subreddit} needs the "${p.required_flair}" flair, which Zavi can't set yet.`;
    return subreddit && title ? { channel: "reddit", fields: { subreddit, title } } : "This post has no subreddit or title to post with.";
  }
  if (a.action_type !== "reply") return "Zavi can only post Reddit text posts and replies.";
  const thread_url = [p?.thread_url, actionLink(a)].map((u) => (u ?? "").trim()).find((u) => THREAD_RE.test(u));
  return thread_url ? { channel: "reddit_comment", fields: { thread_url } } : "This reply has no Reddit thread to post on.";
}

export const REDDIT_NOT_ALLOWED = "This community does not allow self-promotion, so Zavi won't post here. You can still copy the reply.";

export function redditPublishBlocked(a: ActionItem, text: string): string | null {
  if (a.action_type === "reply" && redditPresentation(a)?.rule_status === "not_allowed") return REDDIT_NOT_ALLOWED;
  const target = redditPublishTarget(a);
  if (typeof target === "string") return target;
  const max = SOCIAL_LIMITS.reddit_comment.text;
  return target.channel === "reddit_comment" && text.length > max ? `Reddit replies are capped at ${max.toLocaleString("en-US")} characters. Shorten it before posting.` : null;
}

export function xLength(text: string): number {
  return xWeightedLength(text).length;
}

export const REDDIT_METRICS: Record<string, MetricDisplay> = {
  brand_mentions: { label: "Brand mentions", icon: AtSign, selects: "reddit_brand_mentions" },
  reply_opportunities: {
    label: "Reply opportunities",
    icon: MessageSquare,
    selects: "reddit_reply_opportunities",
  },
  relevant_posts: { label: "Relevant posts", icon: FileText, selects: "reddit_relevant_posts" },
  relevant_comments: {
    label: "Relevant comments",
    icon: MessagesSquare,
    selects: "reddit_relevant_comments",
  },
  subreddits: { label: "Subreddits saved", icon: Users, selects: "reddit_subreddits" },
};

export const GADS_METRICS: Record<string, MetricDisplay> = {
  spend: { label: "Spend", icon: CircleDollarSign },
  conversions: { label: "Conversions", icon: Target },
  cpa: { label: "Cost per conversion", icon: Receipt },
  conv_value: { label: "Conversion value", icon: Wallet },
  roas: { label: "ROAS", icon: Percent },
  pacing: { label: "Plan pace", icon: Gauge },
};

export const META_METRICS: Record<string, MetricDisplay> = {
  spend: { label: "Spend", icon: CircleDollarSign },
  cpa: { label: "Cost per conversion", icon: Receipt },
  conversions: { label: "Conversions", icon: Target },
  conv_value: { label: "Conversion value", icon: Wallet },
  roas: { label: "ROAS", icon: Percent },
  ctr: { label: "Click-through rate", icon: MousePointerClick },
};

export const TIKTOK_METRICS: Record<string, MetricDisplay> = {
  spend: { label: "Spend", icon: CircleDollarSign },
  cpa: { label: "Cost per conversion", icon: Receipt },
  conversions: { label: "Conversions", icon: Target },
  conv_value: { label: "Conversion value", icon: Wallet },
  roas: { label: "ROAS", icon: Percent },
  ctr: { label: "Click-through rate", icon: MousePointerClick },
};

export const REDDIT_ADS_METRICS: Record<string, MetricDisplay> = {
  spend: { label: "Spend", icon: CircleDollarSign },
  cpa: { label: "Cost per conversion", icon: Receipt },
  conversions: { label: "Conversions", icon: Target },
  clicks: { label: "Clicks", icon: MousePointerClick },
  ctr: { label: "Click-through rate", icon: Percent },
  cpc: { label: "Cost per click", icon: Gauge },
};

export const LINKEDIN_ADS_METRICS: Record<string, MetricDisplay> = {
  spend: { label: "Spend", icon: CircleDollarSign, sub: "Across your campaigns" },
  leads: { label: "Leads", icon: Users, sub: "From LinkedIn lead forms" },
  cpl: { label: "Cost per lead", icon: Receipt, sub: "Spend divided by leads" },
  clicks: { label: "Clicks", icon: MousePointerClick },
  cpc: { label: "Average cost per click", icon: Gauge, sub: "Spend divided by clicks" },
  budget: { label: "Daily budget", icon: CalendarDays },
};

export const X_ADS_METRICS = REDDIT_ADS_METRICS;

export type { MetricDisplay } from "../../metrics/SummaryRow";
export type { ActionItem, PlatformSpec } from "../types";
export type { RedditPayload } from "../../agent/reddit/shared";
export { actionLink } from "../types";
export { pasteKeys, redditSubmitUrl, replyPasteHint } from "@/lib/reddit/handoff";

export { AtSign, CircleDollarSign, FileText, Gauge, MessageSquare, MessagesSquare, Percent, Receipt, Target, Users, Wallet } from "lucide-react";
