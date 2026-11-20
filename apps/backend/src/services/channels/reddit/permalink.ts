const SUBREDDIT_RE = /^[A-Za-z0-9_]{1,21}$/;
const POST_ID_RE = /^[A-Za-z0-9]{1,12}$/;

function bareSubreddit(v: string | null | undefined): string | null {
  if (!v || typeof v !== "string") return null;
  const n = v.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return SUBREDDIT_RE.test(n) ? n : null;
}

const canonical = (sub: string, id: string) =>
  `https://www.reddit.com/r/${sub.toLowerCase()}/comments/${id.toLowerCase()}/`;

export function canonicalRedditUrl(
  input: string | null | undefined,
  fallbackSubreddit?: string | null,
): string | null {
  if (!input || typeof input !== "string") return null;
  let u: URL;
  try {
    u = new URL(input.trim(), "https://www.reddit.com");
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "redd.it" || host === "www.redd.it") {
    const id = u.pathname.split("/").filter(Boolean);
    const sub = bareSubreddit(fallbackSubreddit);
    return id.length === 1 && POST_ID_RE.test(id[0]) && sub ? canonical(sub, id[0]) : null;
  }
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
  const m = u.pathname.match(/^\/r\/([A-Za-z0-9_]{1,21})\/comments\/([A-Za-z0-9]{1,12})(?:\/|$)/);
  if (m) return canonical(m[1], m[2]);
  const bare = u.pathname.match(/^\/comments\/([A-Za-z0-9]{1,12})(?:\/|$)/);
  const sub = bareSubreddit(fallbackSubreddit);
  return bare && sub ? canonical(sub, bare[1]) : null;
}

export function redditPostId(input: string | null | undefined): string | null {
  const c = canonicalRedditUrl(input);
  return c ? (c.match(/\/comments\/([a-z0-9]+)\//)?.[1] ?? null) : null;
}

export function firstRedditThreadUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const m of text.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)?(?:reddit\.com|redd\.it)\/[^\s)\]}>"'`]+/gi)) {
    const c = canonicalRedditUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (c) return c;
  }
  return null;
}
