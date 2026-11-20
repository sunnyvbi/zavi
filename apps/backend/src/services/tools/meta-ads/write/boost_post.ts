
import { ExpectedToolError } from "@/services/tools/types";
import { fbGet, fbGetAllPages, fbPost } from "../_client";
import { assertMetaScopes } from "../_scopes";
import { pageAccessToken } from "../pages";
import { enumerateAccountAdSets } from "../list_ad_sets";
import { classifyAccountLookupFailure, classifyPageLookupFailure, resolveMetaAdCapability, type MetaAdBlockReason } from "./_library-ad-capability";
import { boostObjectStoryId, shapeBoostPostCreativeRequest, shapeLibraryAdRequest, LIBRARY_AD_STATUS } from "./_library-ad-shapers";

export type BoostBlockReason = MetaAdBlockReason | "page_posts_permission_missing";

export const BOOST_REASON_TEXT: Record<BoostBlockReason, string> = {
  connector_missing: "Meta Ads is not connected for this workspace. Connect Meta Ads, then boost a post.",
  account_not_writable:
    "The connected Meta ad account is not writable right now: it is inactive (check its status and billing in Meta), or this login only has read access.",
  page_permission_missing:
    "Meta did not give Zavi access to your Facebook Page. Reconnect Meta Ads and allow access to your Page when Facebook asks.",
  page_posts_permission_missing:
    "Meta did not give Zavi permission to read your Page's posts. Reconnect Meta Ads and allow it when Facebook asks.",
  no_page: "This Meta ad account has no Facebook Page it can promote. Add a Page to the ad account in Meta Business Settings.",
  token_expired: "Your Meta connection has expired or was signed out. Reconnect Meta Ads, then boost a post.",
  meta_busy: "Meta is rate limiting this ad account right now. Try again in a few minutes.",
  lookup_failed: "Zavi could not check your Meta connection just now. Try again in a minute.",
};

export type BoostPost = {
  id: string;
  message: string | null;
  created_time: string | null;
  picture: string | null;
  permalink: string | null;
  likes: number;
  comments: number;
  shares: number;
};

export type BoostOptions =
  | {
      eligible: true;
      pages: Array<{ id: string; name: string }>;
      page_id: string;
      posts: BoostPost[];
      posts_note: string | null;
      counts_hidden: boolean;
      ad_sets: Array<{ id: string; name: string; status: string | null }>;
    }
  | { eligible: false; reason_code: BoostBlockReason; reason: string };

function blocked(reason_code: BoostBlockReason): BoostOptions {
  return { eligible: false, reason_code, reason: BOOST_REASON_TEXT[reason_code] };
}

async function promotablePages(tenant_id: string, ad_account_id: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await fbGetAllPages<{ id?: string; name?: string }>(tenant_id, `${ad_account_id}/promote_pages`, { fields: "id,name", limit: 100 }, 10);
  return rows.filter((p): p is { id: string; name?: string } => typeof p.id === "string" && p.id.length > 0).map((p) => ({ id: p.id, name: p.name ?? p.id }));
}

async function accountAdSets(tenant_id: string, ad_account_id: string) {
  const rows = await enumerateAccountAdSets(tenant_id, ad_account_id);
  return rows
    .filter((s): s is typeof s & { id: string } => typeof s.id === "string")
    .map((s) => ({ id: s.id, name: s.name ?? s.id, status: s.effective_status ?? s.status ?? null }));
}

const POST_FIELDS = "id,message,created_time,full_picture,permalink_url,likes.summary(true).limit(0),comments.summary(true).limit(0),shares";

const POST_FIELDS_NO_SUMMARIES = "id,message,created_time,full_picture,permalink_url,shares";

type RawPost = {
  id?: string;
  message?: string;
  created_time?: string;
  full_picture?: string;
  permalink_url?: string;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
};

export function toBoostPost(p: RawPost): BoostPost | null {
  if (typeof p.id !== "string" || !p.id) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    id: p.id,
    message: typeof p.message === "string" ? p.message : null,
    created_time: p.created_time ?? null,
    picture: p.full_picture ?? null,
    permalink: p.permalink_url ?? null,
    likes: n(p.likes?.summary?.total_count),
    comments: n(p.comments?.summary?.total_count),
    shares: n(p.shares?.count),
  };
}

export function mostEngagedPost(posts: readonly BoostPost[]): BoostPost | null {
  let best: BoostPost | null = null;
  for (const p of posts) if (!best || p.likes + p.comments + p.shares > best.likes + best.comments + best.shares) best = p;
  return best;
}

function isPagePermissionRefusal(e: unknown): boolean {
  if (!(e instanceof ExpectedToolError)) return false;
  if (e.code === "meta_ads_permission_revoked") return true;
  const c = e.meta?.graph_code;
  return e.code === "meta_ads_page_read_failed" && typeof c === "number" && (c === 10 || (c >= 200 && c <= 299));
}

function isScopeOrRole(e: unknown): boolean {
  return e instanceof ExpectedToolError && (e.code === "meta_ads_scope_missing" || e.code === "meta_ads_page_not_managed" || e.code === "meta_ads_page_role_missing");
}

export async function readBoostOptions(tenant_id: string, page_id?: string | null): Promise<BoostOptions> {
  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) return blocked(cap.reason_code);
  let pages: Array<{ id: string; name: string }>;
  let ad_sets: Array<{ id: string; name: string; status: string | null }>;
  const [pr, ar] = await Promise.allSettled([promotablePages(tenant_id, cap.ad_account_id), accountAdSets(tenant_id, cap.ad_account_id)]);
  if (pr.status === "rejected") return blocked(classifyPageLookupFailure(pr.reason));
  if (ar.status === "rejected") return blocked(classifyAccountLookupFailure(ar.reason));
  pages = pr.value;
  ad_sets = ar.value;
  if (pages.length === 0) return blocked("no_page");
  const chosen = pages.find((p) => p.id === page_id) ?? pages[0];

  let posts: BoostPost[] = [];
  let posts_note: string | null = null;
  let counts_hidden = false;
  try {
    await assertMetaScopes(tenant_id, ["pages_read_engagement"], "Reading Page posts");
  } catch {
    return blocked("page_posts_permission_missing");
  }
  try {
    const token = await pageAccessToken(tenant_id, chosen.id);
    const readPosts = async (fields: string) => {
      const r = (await fbGet(tenant_id, `${chosen.id}/published_posts`, { fields, limit: 10 }, { page_access_token: token })) as { data?: RawPost[] };
      return (r.data ?? []).map(toBoostPost).filter((p): p is BoostPost => p !== null);
    };
    try {
      posts = await readPosts(POST_FIELDS);
    } catch (e) {
      if (!isPagePermissionRefusal(e)) throw e;
      posts = await readPosts(POST_FIELDS_NO_SUMMARIES);
      counts_hidden = true;
    }
  } catch (e) {
    if (isScopeOrRole(e)) {
      posts_note = `Zavi cannot read ${chosen.name}'s posts: the connected Facebook login does not manage this Page with an advertiser role.`;
    } else {
      return blocked(isPagePermissionRefusal(e) ? "page_posts_permission_missing" : classifyPageLookupFailure(e));
    }
  }
  return { eligible: true, pages, page_id: chosen.id, posts, posts_note, counts_hidden, ad_sets };
}

export async function deleteCreative(tenant_id: string, creative_id: string): Promise<boolean> {
  try {
    const r = (await fbPost(tenant_id, creative_id, { method: "delete" })) as { success?: boolean } | null;
    return r?.success !== false;
  } catch (e) {
    console.warn(`[boost_post] orphan creative ${creative_id} not removed: ${(e as Error).message}`);
    return false;
  }
}

export type BoostResult = { ad_id: string; creative_id: string; status: typeof LIBRARY_AD_STATUS; ads_manager_url: string };

export function adsManagerUrl(ad_account_id: string, ad_id: string): string {
  const act = ad_account_id.replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${encodeURIComponent(act)}&selected_ad_ids=${encodeURIComponent(ad_id)}`;
}

export async function createBoostAd(
  tenant_id: string,
  input: { page_id: string; post_id: string; ad_set_id: string },
): Promise<BoostResult> {
  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) throw new ExpectedToolError(`meta_ads_${cap.reason_code}`, BOOST_REASON_TEXT[cap.reason_code]);

  const [pages, ad_sets] = await Promise.all([promotablePages(tenant_id, cap.ad_account_id), accountAdSets(tenant_id, cap.ad_account_id)]);
  const page = pages.find((p) => p.id === input.page_id);
  if (!page) throw new ExpectedToolError("meta_ads_boost_page_not_promotable", "That Page is not one this ad account can promote.");
  if (!ad_sets.some((s) => s.id === input.ad_set_id)) {
    throw new ExpectedToolError("meta_ads_boost_ad_set_not_in_account", "That ad set is not in your connected ad account.");
  }

  const object_story_id = boostObjectStoryId(page.id, input.post_id);
  await assertMetaScopes(tenant_id, ["pages_read_engagement"], "Reading Page posts");
  const token = await pageAccessToken(tenant_id, page.id);
  const post = (await fbGet(tenant_id, object_story_id, { fields: "id,from" }, { page_access_token: token })) as { id?: string; from?: { id?: string } };
  if (post?.id !== object_story_id || (post.from?.id !== undefined && post.from.id !== page.id)) {
    throw new ExpectedToolError("meta_ads_post_not_on_page", "That post is not on the Page you picked.");
  }

  const name = `Zavi boost ${object_story_id}`;
  const creativeReq = shapeBoostPostCreativeRequest({ ad_account_id: cap.ad_account_id, page_id: page.id, post_id: object_story_id, name });
  const creative = (await fbPost(tenant_id, creativeReq.path, creativeReq.params)) as { id?: string };
  if (!creative?.id) throw new ExpectedToolError("meta_ads_boost_creative_failed", "Meta did not return the new creative.");
  const adReq = shapeLibraryAdRequest({ ad_account_id: cap.ad_account_id, ad_set_id: input.ad_set_id, creative_id: creative.id, name });
  let ad: { id?: string };
  try {
    ad = (await fbPost(tenant_id, adReq.path, adReq.params)) as { id?: string };
    if (!ad?.id) throw new ExpectedToolError("meta_ads_boost_ad_failed", "Meta did not return the new ad.");
  } catch (e) {
    if (await deleteCreative(tenant_id, creative.id)) throw e;
    const base = e instanceof ExpectedToolError ? e : new ExpectedToolError("meta_ads_boost_ad_failed", "Meta did not create the ad.");
    throw new ExpectedToolError(base.code, `${base.message} Zavi could not remove the unused creative ${creative.id}; you can delete it in Meta Ads Manager.`, {
      ...(base.meta ?? {}),
      orphan_creative_id: creative.id,
    });
  }
  return { ad_id: ad.id, creative_id: creative.id, status: LIBRARY_AD_STATUS, ads_manager_url: adsManagerUrl(cap.ad_account_id, ad.id) };
}
