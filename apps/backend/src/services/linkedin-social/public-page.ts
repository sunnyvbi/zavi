
export type LinkedInPublicPost = {
  id: string;
  url: string;
  text: string;
  posted_at: string | null;
  format: "post" | "article";
  reactions: number;
  comments: number | null;
  reposts?: number | null;
};

export type LinkedInPublicPage = {
  kind: "member" | "company";
  name: string | null;
  followers: number | null;
  about: string | null;
  photo_url: string | null;
  banner_url: string | null;
  location: string | null;
  website: string | null;
  posts: LinkedInPublicPost[];
};

const uploaded = (u: unknown) => (typeof u === "string" && /^https:\/\/media\.licdn\.com\//.test(u) ? u : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(in|company)\/([A-Za-z0-9\-_%.]+)/);
    return m ? `https://www.linkedin.com/${m[1]}/${m[2]}/` : null;
  } catch {
    return null;
  }
}

const int = (s: string | undefined) => (s ? Number(s.replace(/[^\d]/g, "")) : NaN);
const activityId = (s: string) => s.match(/activity[-:](\d{10,})/)?.[1] ?? null;
const samePage = (a: string | undefined, pageUrl: string) =>
  !!a && normalizeLinkedInUrl(a)?.toLowerCase() === pageUrl.toLowerCase();

export function parseLinkedInPublicPage(html: string, pageUrl: string): LinkedInPublicPage {
  let graph: Array<Record<string, any>> = [];
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const j = JSON.parse(ld[1]);
      graph = Array.isArray(j?.["@graph"]) ? j["@graph"] : [j];
    } catch {
      graph = [];
    }
  }
  const owner = graph.find((n) => n["@type"] === "Person" || n["@type"] === "Organization");
  const ldFollowers = owner?.interactionStatistic?.userInteractionCount;
  const domFollowers = int(html.match(/([\d,]{1,15})\s+followers/)?.[1]);
  const followers = typeof ldFollowers === "number" ? ldFollowers : Number.isFinite(domFollowers) ? domFollowers : null;

  const cards = new Map<string, { reactions: number; comments: number | null }>();
  for (const m of html.matchAll(/<article[^>]*data-activity-urn="urn:li:activity:(\d+)"[\s\S]*?<\/article>/g)) {
    const r = int(m[0].match(/data-num-reactions="(\d+)"/)?.[1]);
    const c = int(m[0].match(/data-num-comments="(\d+)"/)?.[1]);
    cards.set(m[1], { reactions: Number.isFinite(r) ? r : 0, comments: Number.isFinite(c) ? c : null });
  }
  const byReactions = new Map<number, number | null>();
  for (const m of html.matchAll(/data-num-reactions="(\d+)"[\s\S]{0,4000}?data-num-comments="(\d+)"/g)) {
    const r = Number(m[1]);
    const c = Number(m[2]);
    byReactions.set(r, byReactions.has(r) && byReactions.get(r) !== c ? null : c);
  }

  const posts: LinkedInPublicPost[] = [];
  for (const n of graph) {
    const type = n["@type"];
    if (type !== "DiscussionForumPosting" && type !== "Article") continue;
    if (!samePage(n.author?.url, pageUrl)) continue;
    const url = typeof n.url === "string" ? n.url : null;
    if (!url) continue;
    const id = activityId(url) ?? url;
    const card = cards.get(id);
    const likes = n.interactionStatistic?.userInteractionCount;
    const reactions = typeof likes === "number" ? likes : card?.reactions ?? 0;
    posts.push({
      id,
      url,
      text: String(n.text ?? n.headline ?? "").replace(/^"|"$/g, "").slice(0, 600),
      posted_at: typeof n.datePublished === "string" ? n.datePublished : null,
      format: type === "Article" ? "article" : "post",
      reactions,
      comments: card ? card.comments : byReactions.get(reactions) ?? null,
    });
  }
  const cover = html.match(/<img[^>]*cover-img__image[^>]*?src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  const kind = pageUrl.includes("/company/") ? "company" : "member";
  return {
    kind,
    name: str(owner?.name),
    followers,
    about: str(owner?.description),
    photo_url: uploaded((owner?.image ?? owner?.logo)?.contentUrl),
    banner_url: uploaded(cover),
    location: str(owner?.address?.addressLocality),
    website: kind === "company" ? str(owner?.sameAs) : null,
    posts,
  };
}

export const LI_ERROR = {
  refused: "linkedin_refused",
  not_public: "linkedin_page_not_public",
  not_found: "linkedin_page_not_found",
  failed: "linkedin_read_failed",
} as const;

export class LinkedInReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const CONTROL_PAGE = "https://www.linkedin.com/company/linkedin/";
const get = (url: string, fetchFn: typeof fetch) =>
  fetchFn(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(20_000),
  });

async function refusal(fetchFn: typeof fetch): Promise<LinkedInReadError> {
  try {
    const control = await get(CONTROL_PAGE, fetchFn);
    if (control.status === 200 && !/\/(uas\/login|authwall)/.test(control.url)) {
      return new LinkedInReadError(LI_ERROR.not_public, "LinkedIn does not show this page to people who are not signed in. Turn on your public profile and Zavi can read it.");
    }
  } catch {
  }
  return new LinkedInReadError(LI_ERROR.refused, "LinkedIn refused this read. It usually clears by tomorrow's.");
}

export async function fetchLinkedInPublicPage(pageUrl: string, fetchFn: typeof fetch = fetch): Promise<LinkedInPublicPage> {
  const resp = await get(pageUrl, fetchFn);
  if (resp.status === 999 || resp.status === 429 || /\/(uas\/login|authwall)/.test(resp.url)) throw await refusal(fetchFn);
  const body = await resp.text();
  if (resp.status === 404) {
    if (!body.trim()) throw await refusal(fetchFn);
    throw new LinkedInReadError(LI_ERROR.not_found, "No public LinkedIn page at that address.");
  }
  if (!resp.ok) throw new LinkedInReadError(LI_ERROR.failed, `LinkedIn answered HTTP ${resp.status}.`);
  return parseLinkedInPublicPage(body, pageUrl);
}
