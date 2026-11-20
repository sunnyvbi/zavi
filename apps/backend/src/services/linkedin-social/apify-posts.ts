
import type { LinkedInPublicPage, LinkedInPublicPost } from "./public-page";
import { apifyRanAndBilled, recordApifyCall } from "@/services/vendors/usage";

export const LINKEDIN_POSTS_ACTOR = "harvestapi~linkedin-profile-posts";
const MAX_POSTS = 10;
const TIMEOUT_MS = 30_000;

type ApifyPost = {
  id?: unknown;
  linkedinUrl?: unknown;
  content?: unknown;
  postedAt?: { date?: unknown } | null;
  engagement?: { likes?: unknown; comments?: unknown; shares?: unknown } | null;
  author?: { publicIdentifier?: unknown; universalName?: unknown; name?: unknown; info?: unknown; type?: unknown } | null;
  repostId?: unknown;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function slugOf(pageUrl: string): string | null {
  const m = /linkedin\.com\/(?:in|company)\/([^/?#]+)/i.exec(pageUrl);
  return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

function followersFrom(info: unknown): number | null {
  const m = typeof info === "string" ? /^([\d,.]+)\s+followers?\b/i.exec(info.trim()) : null;
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function pageFromApifyPosts(items: unknown[], pageUrl: string): LinkedInPublicPage {
  const slug = slugOf(pageUrl);
  const kind: LinkedInPublicPage["kind"] = /\/company\//i.test(pageUrl) ? "company" : "member";
  const posts: LinkedInPublicPost[] = [];
  let name: string | null = null;
  let followers: number | null = null;
  for (const raw of items) {
    const p = (raw ?? {}) as ApifyPost;
    const author = p.author ?? {};
    const authorSlug = (str(author.publicIdentifier) ?? str(author.universalName) ?? "").toLowerCase();
    if (!slug || authorSlug !== slug || p.repostId) continue;
    const reactions = num(p.engagement?.likes);
    const id = str(p.id);
    if (reactions === null || !id) continue;
    name ??= str(author.name);
    followers ??= followersFrom(author.info);
    posts.push({
      id,
      url: str(p.linkedinUrl) ?? pageUrl,
      text: str(p.content) ?? "",
      posted_at: str(p.postedAt?.date),
      format: "post",
      reactions,
      comments: num(p.engagement?.comments),
      reposts: num(p.engagement?.shares),
    });
  }
  return { kind, name, followers, about: null, photo_url: null, banner_url: null, location: null, website: null, posts };
}

export class ApifyLinkedInError extends Error {
  constructor(public readonly code: "apify_unconfigured" | "apify_quota_exhausted" | "apify_failed" | "apify_timeout", message: string) {
    super(message);
  }
}

export async function fetchLinkedInViaApify(
  pageUrl: string,
  deps: { fetchFn?: typeof fetch; token?: string | undefined } = {},
): Promise<LinkedInPublicPage> {
  const token = "token" in deps ? deps.token : process.env.APIFY_TOKEN;
  if (!token) throw new ApifyLinkedInError("apify_unconfigured", "APIFY_TOKEN is not set");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await (deps.fetchFn ?? fetch)(
      `https://api.apify.com/v2/acts/${LINKEDIN_POSTS_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${Math.floor(TIMEOUT_MS / 1000) - 5}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUrls: [pageUrl], maxPosts: MAX_POSTS, includeReposts: false, scrapeReactions: false, scrapeComments: false }),
        signal: ac.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (apifyRanAndBilled(res.status)) {
        recordApifyCall({ actor: LINKEDIN_POSTS_ACTOR, ms: Date.now() - startedAt, memoryMb: null, items: 0, at: new Date(startedAt) });
      }
      if (res.status === 403 && /platform-feature-disabled|hard limit exceeded|usage limit/i.test(text)) {
        throw new ApifyLinkedInError("apify_quota_exhausted", "Apify monthly usage limit is exhausted");
      }
      throw new ApifyLinkedInError("apify_failed", `Apify answered HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;
    const items = Array.isArray(json) ? json : [];
    recordApifyCall({ actor: LINKEDIN_POSTS_ACTOR, ms: Date.now() - startedAt, memoryMb: null, items: items.length, at: new Date(startedAt) });
    return pageFromApifyPosts(items, pageUrl);
  } catch (e) {
    if (e instanceof ApifyLinkedInError) throw e;
    if ((e as { name?: string })?.name === "AbortError") {
      recordApifyCall({ actor: LINKEDIN_POSTS_ACTOR, ms: Date.now() - startedAt, memoryMb: null, items: 0, at: new Date(startedAt) });
      throw new ApifyLinkedInError("apify_timeout", "Apify did not answer in time");
    }
    throw new ApifyLinkedInError("apify_failed", (e as Error)?.message ?? "Apify call failed");
  } finally {
    clearTimeout(timer);
  }
}
