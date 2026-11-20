import { ExpectedToolError } from "@/services/tools/types";
import { linkedinAdsGet, linkedinPostPath } from "./http";

const SEP = "(?::|%3A)";
const ID = "(\\d{6,25})(?!\\d)";
const DIRECT_URN = new RegExp(`urn${SEP}li${SEP}(share|ugcPost)${SEP}${ID}`, "i");
const POST_SLUG = new RegExp(`linkedin\\.com/posts/[^?#\\s"']*[-_](share|ugcPost)-${ID}`, "i");
const ACTIVITY_URN = new RegExp(`urn${SEP}li${SEP}activity${SEP}${ID}`, "i");
const ACTIVITY_SLUG = new RegExp(`linkedin\\.com/posts/[^?#\\s"']*[-_]activity-${ID}`, "i");
const TIMEOUT_MS = 8000;
const HTML_MAX = 4_000_000;
const WALL = /^\/(signup|authwall|login|checkpoint|uas)(\/|$)/i;
const SHORT_LINK = /https?:\/\/lnkd\.in\/([A-Za-z0-9_\/-]{1,100})/i;

export type FetchPostPage = (url: string) => Promise<{ ok: boolean; status: number; url: string; text(): Promise<string> }>;

const BROWSER_HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36", "accept-language": "en-US,en;q=0.9" };

const fetchPostPage: FetchPostPage = (url) =>
  fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: BROWSER_HEADERS,
  });

export type FollowShortLink = (url: string) => Promise<{ status: number; location: string | null }>;

const followShortLink: FollowShortLink = async (url) => {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: BROWSER_HEADERS });
  return { status: res.status, location: res.headers.get("location") };
};

const isLinkedInHost = (host: string) => host === "linkedin.com" || host.endsWith(".linkedin.com");

const postUrn = (kind: string, id: string) => `urn:li:${kind.toLowerCase() === "ugcpost" ? "ugcPost" : "share"}:${id}`;

class PublicPageStatus extends Error {
  constructor(readonly status: number) { super(`status ${status}`); }
}

const pageMissing = (e: unknown) => e instanceof PublicPageStatus && (e.status === 404 || e.status === 410);

export const POST_NOT_FOUND = "LinkedIn could not find this post. Check the link: open the post on LinkedIn, choose … then Copy link to post, and paste it again.";

async function publicLinkedInPage(url: string, fetchPage: FetchPostPage): Promise<{ html: string; path: string }> {
  const res = await fetchPage(url);
  if (!res.ok) throw new PublicPageStatus(res.status);
  const landed = new URL(res.url);
  if (!isLinkedInHost(landed.hostname)) throw new Error(`left linkedin.com for ${landed.hostname}`);
  if (WALL.test(landed.pathname)) throw new Error("sign-in wall");
  return { html: (await res.text()).slice(0, HTML_MAX), path: landed.pathname };
}

export function attributedPostUrn(html: string, activityId: string): string | null {
  const wanted = `data-activity-urn="urn:li:activity:${activityId}"`;
  for (const tag of html.match(/<[a-z][^>]*\sdata-activity-urn="[^"]*"[^>]*>/gi) ?? []) {
    if (!tag.includes(wanted)) continue;
    const found = tag.match(/\sdata-attributed-urn="urn:li:(share|ugcPost):(\d{6,25})"/i);
    if (found) return postUrn(found[1], found[2]);
  }
  return null;
}

const SHORT_LINK_UNREADABLE = "Zavi could not open this lnkd.in short link. Open it in your browser and paste the linkedin.com address it lands on, or open … on the post and choose Copy link to post.";

async function expandShortLink(url: string, followLink: FollowShortLink): Promise<string | null> {
  let target: URL;
  try {
    const { status, location } = await followLink(url);
    if (status < 300 || status > 399 || !location) throw new Error(`status ${status}`);
    target = new URL(location, url);
  } catch {
    throw new ExpectedToolError("linkedin_ads_post_unreadable", SHORT_LINK_UNREADABLE);
  }
  return target.protocol === "https:" && isLinkedInHost(target.hostname) ? target.href : null;
}

const POST_FORMS = [DIRECT_URN, POST_SLUG, ACTIVITY_URN, ACTIVITY_SLUG];

export type PastedPost = { post_urn: string; reposted_from?: string };

export async function resolvePromotablePost(pasted: string, fetchPage: FetchPostPage = fetchPostPage, followLink: FollowShortLink = followShortLink): Promise<string | null> {
  return (await resolvePastedPost(pasted, fetchPage, followLink))?.post_urn ?? null;
}

export async function resolvePastedPost(pasted: string, fetchPage: FetchPostPage = fetchPostPage, followLink: FollowShortLink = followShortLink): Promise<PastedPost | null> {
  const short = POST_FORMS.some((form) => form.test(pasted)) ? null : pasted.match(SHORT_LINK)?.[1];
  if (!short) return postFromLink(pasted, fetchPage);
  const landed = await expandShortLink(`https://lnkd.in/${short}`, followLink);
  return landed ? postFromLink(landed, fetchPage) : null;
}

const REPOST_GAP_MS = 24 * 60 * 60 * 1000;
const idTime = (id: string) => Number(BigInt(id) >> BigInt(22));

function originalPostDate(activityId: string, post: string): string | null {
  const id = post.match(/:(\d{6,25})$/)?.[1];
  if (!id) return null;
  const posted = idTime(id);
  return idTime(activityId) - posted > REPOST_GAP_MS ? new Date(posted).toISOString().slice(0, 10) : null;
}

export const postLink = (post: string) => `https://www.linkedin.com/feed/update/${post}`;

export function repostNote(postedOn: string, author: string | null): string {
  const day = new Date(`${postedOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return `This link is a repost. LinkedIn will run the original post${author ? ` by ${author}` : ""}, first posted on ${day}, not the repost. Open the promoted post to check it is the one you want.`;
}

async function postFromLink(pasted: string, fetchPage: FetchPostPage): Promise<PastedPost | null> {
  const direct = pasted.match(DIRECT_URN) ?? pasted.match(POST_SLUG);
  if (direct) return { post_urn: postUrn(direct[1], direct[2]) };
  const activityId = pasted.match(ACTIVITY_URN)?.[1] ?? pasted.match(ACTIVITY_SLUG)?.[1];
  if (!activityId) return null;
  let html: string;
  try {
    html = (await publicLinkedInPage(`https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`, fetchPage)).html;
  } catch (e) {
    if (pageMissing(e)) throw new ExpectedToolError("linkedin_ads_post_not_found", POST_NOT_FOUND);
    throw new ExpectedToolError(
      "linkedin_ads_post_unreadable",
      "LinkedIn did not show this post to Zavi. Check the link opens the right post. If it does, the post is probably on a personal profile or members-only, so paste its embed code instead: on the post, open … and choose Embed this post.",
    );
  }
  const post_urn = attributedPostUrn(html, activityId);
  if (!post_urn) return null;
  const reposted_from = originalPostDate(activityId, post_urn);
  return reposted_from ? { post_urn, reposted_from } : { post_urn };
}

export const POST_PAGE_MISMATCH = "This post was not published by the company page this ad account advertises for, and LinkedIn only promotes posts from that page. Paste the link to one of that page's posts, or choose another ad account. Nothing was created.";

export const POST_FROM_SHOWCASE = "This post was published by a Showcase page, and LinkedIn only promotes posts from the company page this ad account advertises for, or a member's post. Paste the link to one of that company page's posts, or choose another ad account. Nothing was created.";

const PAGE_URN = /^urn:li:(organization|organizationBrand):\d+$/;

export type PostAuthor = "page" | "member" | "other_page" | "unknown";

export type PublicPost = { author_page: string | null; text: string | null; author_kind?: "member"; missing?: true };
export type ReadPublicPost = () => Promise<PublicPost>;

const NO_PUBLIC_POST: PublicPost = { author_page: null, text: null };
const COMPANY_URL = /^https:\/\/(?:www\.|[a-z]{2}\.)?linkedin\.com\/company\/([A-Za-z0-9_-]{1,100})\/?(?:[?#][^\s]*)?$/;
const LD_JSON = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
const ORG_TRACKING = /<code id="flagshipOrganizationTracking"[^>]*><!--([\s\S]*?)--><\/code>/;

const postText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);

type PublicPosting = { author?: { "@type"?: unknown; url?: unknown; image?: { url?: unknown } }; articleBody?: unknown; image?: { url?: unknown } | Array<{ url?: unknown }> };

function publicPosting(html: string): PublicPosting | null {
  const found: PublicPosting[] = [];
  for (const [, body] of html.matchAll(LD_JSON)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (node && typeof node === "object" && (node as { "@type"?: unknown })["@type"] === "SocialMediaPosting") found.push(node as never);
    }
  }
  return found.length === 1 ? found[0] : null;
}

function companyPageUrn(html: string): string | null {
  const tracking = html.match(ORG_TRACKING)?.[1];
  if (!tracking) return null;
  try {
    const urn = (JSON.parse(tracking) as { organization?: { objectUrn?: unknown } })?.organization?.objectUrn;
    return typeof urn === "string" && /^urn:li:organization:\d{1,20}$/.test(urn) ? urn : null;
  } catch {
    return null;
  }
}

export async function readPublicPost(postUrn: string, fetchPage: FetchPostPage = fetchPostPage): Promise<PublicPost> {
  let html: string;
  try {
    html = (await publicLinkedInPage(`https://www.linkedin.com/feed/update/${postUrn}/`, fetchPage)).html;
  } catch (e) {
    return pageMissing(e) ? { ...NO_PUBLIC_POST, missing: true } : NO_PUBLIC_POST;
  }
  try {
    const posting = publicPosting(html);
    if (!posting) return NO_PUBLIC_POST;
    const text = postText(posting.articleBody);
    if (posting.author?.["@type"] === "Person") return { author_page: null, author_kind: "member", text };
    const slug = posting.author?.["@type"] === "Organization" && typeof posting.author.url === "string" ? posting.author.url.match(COMPANY_URL)?.[1] : undefined;
    if (!slug) return { author_page: null, text };
    let company: { html: string; path: string };
    try {
      company = await publicLinkedInPage(`https://www.linkedin.com/company/${slug}/`, fetchPage);
    } catch {
      return { author_page: null, text };
    }
    if (company.path.replace(/\/$/, "").toLowerCase() !== `/company/${slug.toLowerCase()}`) return { author_page: null, text };
    return { author_page: companyPageUrn(company.html), text };
  } catch {
    return NO_PUBLIC_POST;
  }
}

const OG_IMAGE = /<meta[^>]+(?:property|name)="og:image"[^>]+content="([^"]+)"/i;

function httpsImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.replace(/&amp;/g, "&"));
    return url.protocol === "https:" && !url.username && !url.password && url.hostname !== "static.licdn.com" ? url.href : null;
  } catch {
    return null;
  }
}

function licdnImage(value: unknown): string | null {
  const url = httpsImage(value);
  if (!url) return null;
  const host = new URL(url).hostname;
  return host === "licdn.com" || host.endsWith(".licdn.com") ? url : null;
}

export type PublicPostMedia = { image: string | null; page_logo: string | null };

export async function readPublicPostMedia(postUrn: string, fetchPage: FetchPostPage = fetchPostPage): Promise<PublicPostMedia> {
  let html: string;
  try {
    html = (await publicLinkedInPage(`https://www.linkedin.com/feed/update/${postUrn}/`, fetchPage)).html;
  } catch {
    return { image: null, page_logo: null };
  }
  const posting = publicPosting(html);
  const page_logo = posting?.author?.["@type"] === "Organization" ? licdnImage(posting.author.image?.url) : null;
  const images = Array.isArray(posting?.image) ? posting.image : posting?.image ? [posting.image] : [];
  for (const image of images) {
    const url = httpsImage(image?.url);
    if (url) return { image: url, page_logo };
  }
  return { image: httpsImage(html.match(OG_IMAGE)?.[1]), page_logo };
}

export async function readPublicPostImage(postUrn: string, fetchPage: FetchPostPage = fetchPostPage): Promise<string | null> {
  return (await readPublicPostMedia(postUrn, fetchPage)).image;
}

export async function readPostForPage(token: string, postUrn: string, page: string, readPublic?: ReadPublicPost, fresh = false): Promise<{ author: PostAuthor; text: string | null }> {
  let post: { author?: unknown; commentary?: unknown };
  try {
    post = await linkedinAdsGet<{ author?: unknown; commentary?: unknown }>(token, linkedinPostPath(postUrn), {}, {}, { fresh });
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "linkedin_ads_token_revoked") throw e;
    const shown = readPublic ? await readPublic() : NO_PUBLIC_POST;
    if (shown.missing && e instanceof ExpectedToolError && e.meta?.http_status === 404) throw new ExpectedToolError("linkedin_ads_post_not_found", POST_NOT_FOUND);
    return { author: shown.author_kind === "member" && !shown.author_page ? "member" : postAuthor(shown.author_page ?? undefined, page), text: shown.text };
  }
  return { author: postAuthor(post?.author, page), text: postText(post?.commentary) };
}

export async function assertPostFromPage(token: string, postUrn: string, page: string, readPublic?: ReadPublicPost): Promise<PostAuthor> {
  return (await readPostForPage(token, postUrn, page, readPublic, true)).author;
}

function postAuthor(author: unknown, page: string): PostAuthor {
  if (typeof author !== "string") return "unknown";
  if (author === page) return "page";
  if (/^urn:li:person:[A-Za-z0-9_-]+$/.test(author)) return "member";
  const authorKind = author.match(PAGE_URN)?.[1];
  if (!authorKind) return "unknown";
  const pageKind = page.match(PAGE_URN)?.[1];
  if (authorKind === pageKind) throw new ExpectedToolError("linkedin_ads_post_page_mismatch", POST_PAGE_MISMATCH);
  if (authorKind === "organizationBrand" && pageKind === "organization") throw new ExpectedToolError("linkedin_ads_post_page_mismatch", POST_FROM_SHOWCASE);
  return "other_page";
}

export type CompanyPage = { name: string | null; logo_url: string | null };

type StreamedLogo = { "original~"?: { elements?: Array<{ identifiers?: Array<{ identifier?: unknown }> }> } };

function logoUrl(logo: StreamedLogo | undefined): string | null {
  for (const el of [...(logo?.["original~"]?.elements ?? [])].reverse()) {
    const url = el?.identifiers?.[0]?.identifier;
    if (typeof url !== "string") continue;
    try {
      if (new URL(url).protocol === "https:") return url;
    } catch {
      continue;
    }
  }
  return null;
}

export async function readCompanyPage(token: string, page: string): Promise<CompanyPage> {
  const id = page.match(/^urn:li:organization:(\d{1,20})$/)?.[1];
  if (!id) return { name: null, logo_url: null };
  const [named, logo] = await Promise.allSettled([
    linkedinAdsGet<{ localizedName?: unknown }>(token, `organizations/${id}`),
    linkedinAdsGet<{ logoV2?: StreamedLogo }>(token, `organizations/${id}`, {}, { projection: "(logoV2(original~:playableStreams))" }),
  ]);
  const name = named.status === "fulfilled" && typeof named.value?.localizedName === "string" && named.value.localizedName.trim() ? named.value.localizedName.trim().slice(0, 200) : null;
  return { name, logo_url: logo.status === "fulfilled" ? logoUrl(logo.value?.logoV2) : null };
}
