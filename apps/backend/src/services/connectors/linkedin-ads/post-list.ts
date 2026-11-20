import { createHash } from "node:crypto";
import { z } from "zod";
import { mediaReferences } from "@/services/campaign-media/linkedin";
import { inGroups, isRecord, mediaUrls, stringId } from "@/services/campaign-media/media";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertPreparable, readAction } from "./action-read";
import { listLinkedInAdAccountsWithReference, withLinkedInAdsToken } from "./client";
import * as api from "./http";
import { readLinkedinAccountHolders } from "./own-accounts";
import { readCompanyPage, readPublicPost, readPublicPostImage } from "./post-link";

export const USED_IN_AD = "Used in an ad";
export const PAGE_POST = "Page post";

export type LinkedInPostRow = {
  post_urn: string;
  text: string | null;
  date: string | null;
  thumbnail_url: string | null;
  label: typeof USED_IN_AD | typeof PAGE_POST;
};
export type LinkedInPostList = { posts: LinkedInPostRow[]; page_name: string | null };

export const linkedinPostListInput = z.object({ account_id: z.string().regex(/^\d{1,20}$/) }).strict();

export const POST_LIST_ACCOUNT_NOT_LINKED = "That ad account is not linked to this workspace. Refresh and choose again.";

const POST_URN = /^urn:li:(share|ugcPost):\d{6,25}$/;
const PAGE_URN = /^urn:li:organization:\d{1,20}$/;
const AD_POSTS_MAX = 20;
const PAGE_POSTS_MAX = 20;
const PUBLIC_READS_MAX = 8;
const LIST_MAX = 25;
const LIST_TTL_MS = 2 * 60_000;
const SCOPE_REFUSED_TTL_MS = 3600_000;
const MEMO_MAX = 500;

type Found = Omit<LinkedInPostRow, "thumbnail_url"> & { media: string | null; image?: string | null };

const lists = new Map<string, { expires: number; value: LinkedInPostList }>();
const scopeRefused = new Map<string, number>();

export function resetLinkedInPostListCache(): void {
  lists.clear();
  scopeRefused.clear();
}

function remember<V>(memo: Map<string, V>, key: string, value: V): void {
  memo.delete(key);
  memo.set(key, value);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
}

const empty = (): LinkedInPostList => ({ posts: [], page_name: null });
const revoked = (e: unknown) => e instanceof ExpectedToolError && e.code === "linkedin_ads_token_revoked";

function firstLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const plain = value
    .replace(/\{hashtag\|\\?#\|([^}]*)\}/g, "#$1")
    .replace(/@\[([^\]]*)\]\(urn:li:[^)]*\)/g, "$1")
    .replace(/\\([\\|{}@[\]()<>#*_~])/g, "$1");
  const line = plain.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : null;
}

function postDate(urn: string, post?: Record<string, unknown>): string | null {
  const stated = [post?.publishedAt, post?.createdAt].find((v): v is number => typeof v === "number" && v > 0);
  const stamp = stated ?? Number(BigInt(urn.slice(urn.lastIndexOf(":") + 1)) >> BigInt(22));
  return stamp > Date.UTC(2010, 0, 1) && stamp < Date.now() + 86_400_000 ? new Date(stamp).toISOString() : null;
}

const fromApi = (urn: string, post: Record<string, unknown>, label: Found["label"]): Found => ({
  post_urn: urn,
  text: firstLine(post.commentary),
  date: postDate(urn, post),
  media: mediaReferences(post.content)[0] ?? null,
  label,
});

async function sharedWalletAccount(tenantId: string, accountId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_account_binding_details")
    .select("tenant_id, provider_account_id, funding_source, credential_source")
    .eq("platform", "linkedin")
    .range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000) throw new ExpectedToolError("linkedin_ads_read_failed", "This workspace's LinkedIn ad accounts could not be read.");
  return (data as Array<{ tenant_id: string; provider_account_id: string | null; funding_source: string; credential_source: string }>).some(
    (b) => b.tenant_id === tenantId && b.provider_account_id === accountId && (b.funding_source === "wallet" || b.credential_source === "platform"),
  );
}

async function adPostRefs(token: string, accountId: string): Promise<string[]> {
  const refs = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 2 && refs.size < AD_POSTS_MAX; page++) {
    const data = await api.linkedinAdsGet<unknown>(token, `adAccounts/${accountId}/creatives`, { q: "criteria", sortOrder: "DESCENDING", pageSize: 100, ...(pageToken ? { pageToken } : {}) }, {}, { restliMethod: "FINDER" });
    if (!isRecord(data) || !Array.isArray(data.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", api.LINKEDIN_ADS_UNREADABLE);
    for (const creative of data.elements) {
      if (!isRecord(creative) || !isRecord(creative.content)) continue;
      if (creative.account !== undefined && creative.account !== `urn:li:sponsoredAccount:${accountId}`) continue;
      const ref = stringId(creative.content.reference);
      if (ref && POST_URN.test(ref) && refs.size < AD_POSTS_MAX) refs.add(ref);
    }
    pageToken = isRecord(data.metadata) ? stringId(data.metadata.nextPageToken) ?? undefined : undefined;
    if (!pageToken) break;
  }
  return [...refs];
}

export async function postBehindAccountAd(token: string, accountId: string, postUrn: string): Promise<boolean> {
  try {
    return (await adPostRefs(token, accountId)).includes(postUrn);
  } catch (e) {
    if (revoked(e)) throw e;
    return false;
  }
}

async function adPosts(token: string, accountId: string, page: string): Promise<Found[]> {
  const refs = await adPostRefs(token, accountId);
  let read: Record<string, unknown> = {};
  try {
    read = await api.linkedinAdsBatchGet(token, "posts", refs);
  } catch (e) {
    if (revoked(e)) throw e;
  }
  const found = new Map<string, Found>();
  const unread: string[] = [];
  for (const ref of refs) {
    const post = read[ref];
    if (!isRecord(post)) unread.push(ref);
    else if (post.author === page) found.set(ref, fromApi(ref, post, USED_IN_AD));
  }
  for (const ref of unread) found.set(ref, { post_urn: ref, text: null, date: postDate(ref), media: null, label: USED_IN_AD });
  await inGroups(unread.slice(0, PUBLIC_READS_MAX), async (ref) => {
    const [shown, image] = await Promise.all([readPublicPost(ref), readPublicPostImage(ref)]);
    if (shown.author_kind === "member" || (shown.author_page && shown.author_page !== page)) found.delete(ref);
    else found.set(ref, { post_urn: ref, text: firstLine(shown.text), date: postDate(ref), media: null, image, label: USED_IN_AD });
  }, 4);
  return refs.flatMap((ref) => found.get(ref) ?? []);
}

async function pagePosts(token: string, page: string): Promise<Found[]> {
  const caller = createHash("sha256").update(token).digest("hex");
  if ((scopeRefused.get(caller) ?? 0) > Date.now()) return [];
  let data: unknown;
  try {
    data = await api.linkedinAdsGet<unknown>(token, "posts", { q: "author", author: page, count: PAGE_POSTS_MAX, sortBy: "CREATED" }, {}, { restliMethod: "FINDER" });
  } catch (e) {
    if (revoked(e)) throw e;
    if (e instanceof ExpectedToolError && e.code === "linkedin_ads_forbidden") remember(scopeRefused, caller, Date.now() + SCOPE_REFUSED_TTL_MS);
    return [];
  }
  const elements = isRecord(data) && Array.isArray(data.elements) ? data.elements : [];
  return elements.flatMap((post) => {
    if (!isRecord(post) || post.author !== page) return [];
    const urn = stringId(post.id);
    if (!urn || !POST_URN.test(urn)) return [];
    if (post.lifecycleState !== undefined && post.lifecycleState !== "PUBLISHED") return [];
    if (post.reshareContext !== undefined) return [];
    return [fromApi(urn, post, PAGE_POST)];
  });
}

async function thumbnails(token: string, found: Found[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const kind of ["image", "video"] as const) {
    const refs = found.flatMap((f) => (f.media?.startsWith(`urn:li:${kind}:`) ? [f.media] : []));
    if (!refs.length) continue;
    let assets: Record<string, unknown> = {};
    try {
      assets = await api.linkedinAdsBatchGet(token, `${kind}s`, refs);
    } catch (e) {
      if (revoked(e)) throw e;
    }
    for (const [ref, asset] of Object.entries(assets)) {
      const media = kind === "video" && isRecord(asset) ? { thumbnail_url: asset.thumbnail, thumbnailUrl: asset.thumbnailUrl, thumbnails: asset.thumbnails } : asset;
      const url = mediaUrls(media)[0];
      if (url) urls.set(ref, url);
    }
  }
  return urls;
}

const newestFirst = (a: Found, b: Found) => (b.date ?? "").localeCompare(a.date ?? "");

export async function listLinkedInPostsForPicker(tenantId: string, actionId: string, input: unknown): Promise<LinkedInPostList> {
  assertPreparable(await readAction(tenantId, actionId));
  const { account_id } = linkedinPostListInput.parse(input);
  if (await sharedWalletAccount(tenantId, account_id)) return empty();
  const holders = await readLinkedinAccountHolders(tenantId, [account_id]);
  if (holders.managed.has(account_id)) return empty();
  if (holders.elsewhere.has(account_id)) throw new ExpectedToolError("linkedin_ads_conflict", POST_LIST_ACCOUNT_NOT_LINKED);
  const account = (await listLinkedInAdAccountsWithReference(tenantId)).find((a) => a.id === account_id);
  if (!account) throw new ExpectedToolError("linkedin_ads_conflict", POST_LIST_ACCOUNT_NOT_LINKED);
  const page = account.reference;
  if (!page || !PAGE_URN.test(page)) return empty();
  const key = `${tenantId}:${account_id}`;
  const hit = lists.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await withLinkedInAdsToken(tenantId, async (token) => {
    const [used, published, company] = await Promise.all([adPosts(token, account_id, page), pagePosts(token, page), readCompanyPage(token, page)]);
    const merged = new Map<string, Found>();
    for (const f of [...used, ...published]) if (!merged.has(f.post_urn)) merged.set(f.post_urn, f);
    const shown = [...merged.values()].sort(newestFirst).slice(0, LIST_MAX);
    const images = await thumbnails(token, shown);
    return {
      posts: shown.map(({ media, image, ...row }) => ({ ...row, thumbnail_url: (media && images.get(media)) || image || null })),
      page_name: company.name,
    };
  });
  remember(lists, key, { expires: Date.now() + LIST_TTL_MS, value });
  return value;
}
