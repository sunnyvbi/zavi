
import { canonicalRedditUrl, firstRedditThreadUrl } from "./reddit/permalink";
import { LISTING_DIRECTORIES } from "@/services/tools/growth/geo/visibility/listing-targets";

const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function bareSubreddit(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const n = s.replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return SUBREDDIT_RE.test(n) ? n : null;
}

type LinkStep = {
  title?: unknown;
  body?: unknown;
  evidence?: unknown;
  deliverable?: {
    label?: unknown;
    presentation?: { type?: unknown; subreddit?: unknown; thread_url?: unknown } | null;
  } | null;
};

function redditLink(step: LinkStep): string | null {
  const deliverable = step.deliverable ?? null;
  const presentation = deliverable?.presentation ?? null;
  const type = str(presentation?.type);
  const subreddit = bareSubreddit(presentation?.subreddit);

  if (type === "reddit_reply") {
    const canon = canonicalRedditUrl(str(presentation?.thread_url), subreddit);
    if (canon) return canon;
  }
  if (type === "reddit_post" && subreddit) {
    return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/`;
  }

  const evidence = Array.isArray(step.evidence) ? step.evidence.map(str).filter(Boolean) : [];
  const prose = [str(step.title), str(step.body), str(deliverable?.label), ...evidence].join("\n");
  const found = firstRedditThreadUrl(prose);
  if (found) return found;
  return subreddit ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/` : null;
}

export function actionLinkForStep(channelSlug: string, step: unknown): string | null {
  if (!step || typeof step !== "object") return null;
  if (channelSlug === "reddit_organic") return redditLink(step as LinkStep);
  if (channelSlug === "geo") return listingLink(step as { target?: unknown });
  return null;
}

function listingLink(step: { target?: unknown }): string | null {
  const t = step.target as { kind?: unknown; ref?: unknown } | null | undefined;
  if (!t || t.kind !== "profile" || typeof t.ref !== "string") return null;
  return LISTING_DIRECTORIES.some((d) => d.way_in_url === t.ref) ? t.ref : null;
}
