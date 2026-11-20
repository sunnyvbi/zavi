import { redditAdsAccount, getPost } from "@/services/connectors/reddit-ads/adapter";
import { AD_ASSETS_BUCKET } from "@/services/tools/google-ads/write/_logo";
import { adReviewCreativeSchema, type AdReviewCreative, type AdReviewPresentation } from "@zavi/shared";
import { fbGet, metaAdsCreds } from "@/services/tools/meta-ads/_client";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { getAccountBinding } from "@/services/ads-wallet/bindings";
import { resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { linkedinAdsBatchGet } from "@/services/connectors/linkedin-ads/http";
import { tiktokAdsAccount, tt } from "@/services/connectors/tiktok-ads/composio-read";
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import { listXAdAccountsRaw, xAdsRequest, xAdsTenantToken } from "@/services/connectors/x-ads/client";
import { tenantClient, tenantStorage, asTenantId } from "@/services/tenant-client";
import { signTenantArtifactPath } from "@/routes/run-artifacts/file-url";
import { mediaUrls } from "@/services/campaign-media/media";
import { atPath } from "./adapters";
import { record } from "./version";

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function https(value: unknown): string | undefined {
  const parsed = adReviewCreativeSchema.shape.image_url.safeParse(value);
  return parsed.success && parsed.data?.startsWith("https://") ? parsed.data : undefined;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : []) : []; }

async function artifact(tenantId: string, id: unknown): Promise<string | undefined> {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) return undefined;
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("run_artifacts").select("storage_path,bucket,mime").eq("id", id).maybeSingle();
  if (error || !record(data) || typeof data.storage_path !== "string" || !text(data.mime)?.startsWith("image/") || data.mime === "image/svg+xml") return undefined;
  const signed = await signTenantArtifactPath(tenantId, data.storage_path, 300, text(data.bucket));
  return typeof signed === "string" ? signed : undefined;
}

async function meta(tenantId: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewCreative[]> {
  const source = atPath(payload, "ad") ?? payload;
  const video = text(atPath(source, "video_asset_id"));
  if (video && /^\d+$/.test(video)) {
    const data: unknown = await fbGet(tenantId, video, { fields: "source,picture" });
    if (record(data)) return review.creatives.map((creative) => ({ ...creative, video_url: https(data.source), image_url: creative.image_url ?? https(data.picture) }));
  }
  const sourceAd = text(atPath(source, "source_ad_id"));
  const hash = text(atPath(source, "image_hash"));
  if (hash && /^[a-f0-9]{32}$/i.test(hash)) {
    const account = await metaAdsCreds(tenantId);
    const raw: unknown = await fbGet(tenantId, `${account.ad_account_id}/adimages`, { hashes: JSON.stringify([hash]), fields: "hash,url" });
    const images = atPath(raw, "data");
    const image = Array.isArray(images) ? images.find((item) => record(item) && item.hash === hash) : undefined;
    return review.creatives.map((creative) => ({ ...creative, image_url: creative.image_url ?? https(atPath(image, "url")) }));
  }
  if (!sourceAd || !/^\d+$/.test(sourceAd)) return review.creatives;
  const raw: unknown = await fbGet(tenantId, sourceAd, { fields: "creative{image_url,thumbnail_url,video_id,object_story_spec,asset_feed_spec}" });
  const data = atPath(raw, "creative");
  const sourceVideo = text(atPath(data, "video_id")) ?? text(atPath(data, "object_story_spec.video_data.video_id"));
  let videoUrl: string | undefined;
  if (sourceVideo && /^\d+$/.test(sourceVideo)) {
    try { videoUrl = https(atPath(await fbGet(tenantId, sourceVideo, { fields: "source" }), "source")); }
    catch { videoUrl = undefined; }
  }
  return review.creatives.map((creative) => ({ ...creative, image_url: creative.image_url ?? mediaUrls(data)[0], video_url: creative.video_url ?? videoUrl }));
}

async function walletLinkedinToken(tenantId: string, bindingId: string | undefined): Promise<{ token: string | null } | null> {
  if (!bindingId) return null;
  const binding = await getAccountBinding(tenantId, bindingId).catch(() => null);
  if (binding?.funding_source !== "wallet") return null;
  const resolved = await resolveLinkedinAccount(tenantId, binding).catch(() => null);
  return { token: resolved?.token ?? null };
}

async function linkedin(tenantId: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewCreative[]> {
  const ref = text(atPath(payload, "creative.post_urn"));
  if (!ref || !/^urn:li:(share|ugcPost):\d+$/.test(ref)) return review.creatives;
  const wallet = await walletLinkedinToken(tenantId, text(atPath(payload, "account_binding_id")));
  if (wallet && !wallet.token) return review.creatives;
  const { token, raw } = wallet?.token
    ? { token: wallet.token, raw: await linkedinAdsBatchGet(wallet.token, "posts", [ref]).catch(() => null) }
    : await withLinkedInAdsToken(tenantId, async (t) => ({
        token: t,
        raw: await linkedinAdsBatchGet(t, "posts", [ref]),
      }));
  if (!raw) return review.creatives;
  const post = raw[ref];
  const mediaRef = text(atPath(post, "content.media.id"));
  let asset: unknown;
  if (mediaRef && /^urn:li:(image|video):[\w-]+$/.test(mediaRef)) {
    const kind = mediaRef.startsWith("urn:li:image:") ? "images" : "videos";
    asset = (await linkedinAdsBatchGet(token, kind, [mediaRef]))[mediaRef];
  }
  const image = mediaUrls(asset)[0] ?? mediaUrls(post)[0];
  return review.creatives.map((creative) => ({ ...creative, body: creative.body ?? text(atPath(post, "commentary")), title: creative.title ?? text(atPath(post, "content.media.title")), image_url: creative.image_url ?? (mediaRef?.startsWith("urn:li:video:") ? mediaUrls(post)[0] : image), video_url: creative.video_url ?? (mediaRef?.startsWith("urn:li:video:") ? https(atPath(asset, "downloadUrl")) : undefined) }));
}

async function tiktok(tenantId: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewCreative[]> {
  const videoId = text(atPath(payload, "video.video_id"));
  const advertiser = text(atPath(payload, "advertiser_id"));
  if (!videoId || !advertiser) return review.creatives;
  const available = await ensureAdAccounts(tenantId);
  if (!available.accounts.some((account) => account.advertiser_id === advertiser)) return review.creatives;
  const account = await tiktokAdsAccount(tenantId);
  const params = new URLSearchParams({ advertiser_id: advertiser, video_ids: JSON.stringify([videoId]) });
  const raw = await tt(account, `/file/video/ad/info/?${params}`);
  const entries = Array.isArray(raw.list) ? raw.list : [raw];
  const video = entries.find((entry) => record(entry) && entry.video_id === videoId);
  return review.creatives.map((creative) => ({ ...creative, video_url: creative.video_url ?? https(atPath(video, "preview_url")), image_url: creative.image_url ?? https(atPath(video, "video_cover_url")) }));
}

async function x(tenantId: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewCreative[]> {
  const account = text(atPath(payload, "account_id"));
  const ids = strings(atPath(payload, "tweet_ids")).filter((id) => /^\d{1,25}$/.test(id)).slice(0, 10);
  if (!account || !ids.length) return review.creatives;
  const token = await xAdsTenantToken(tenantId);
  if (!(await listXAdAccountsRaw(token)).some((item) => item.id === account)) return review.creatives;
  const raw = await xAdsRequest<unknown>(token, "GET", `accounts/${account}/tweets`, { tweet_ids: ids.join(","), tweet_type: "PUBLISHED", trim_user: "true", include_entities: "true" });
  const posts = atPath(raw, "data");
  return review.creatives.map((creative) => {
    const id = creative.target_url?.split("/").pop();
    const post = Array.isArray(posts) ? posts.find((item) => record(item) && (item.id_str === id || String(item.id) === id)) : undefined;
    const media = atPath(post, "extended_entities.media");
    const videos = Array.isArray(media) ? media.flatMap((item) => {
      const variants = atPath(item, "video_info.variants");
      return Array.isArray(variants) ? variants.filter((variant) => atPath(variant, "content_type") === "video/mp4").flatMap((variant) => { const url = https(atPath(variant, "url")); return url ? [url] : []; }) : [];
    }) : [];
    return { ...creative, body: text(atPath(post, "full_text")) ?? text(atPath(post, "text")) ?? creative.body, image_url: creative.image_url ?? mediaUrls(post)[0], video_url: creative.video_url ?? videos[0] };
  });
}

async function reddit(tenantId: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewCreative[]> {
  const id = text(atPath(payload, "post_id"));
  if (!id || !/^t3_[a-z0-9]+$/i.test(id)) return review.creatives;
  const post: unknown = await getPost(await redditAdsAccount(tenantId), id);
  const creative = adReviewCreativeSchema.safeParse({ ...review.creatives[0], title: text(atPath(post, "title")), body: text(atPath(post, "selftext")) ?? text(atPath(post, "body")), image_url: mediaUrls(post)[0], target_url: `https://www.reddit.com/comments/${id.slice(3)}/` });
  return creative.success ? [creative.data] : review.creatives;
}

async function google(tenantId: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewCreative[]> {
  const paths = ["landscape_images", "square_images", "portrait_images"].flatMap((key) => {
    const values = atPath(payload, `pmax_asset_group.${key}`);
    return Array.isArray(values) ? values.flatMap((item) => {
      const path = atPath(item, "storage_path");
      return typeof path === "string" && path.startsWith(`${tenantId}/images/`) && /^[a-f0-9-]{36}\/images\/[a-f0-9]{64}\.(jpg|png)$/.test(path) ? [path] : [];
    }) : [];
  }).slice(0, 15);
  if (!paths.length) return review.creatives;
  const images = await Promise.all(paths.map(async (path) => {
    const result = await tenantStorage(asTenantId(tenantId)).from(AD_ASSETS_BUCKET).createSignedUrl(path, 600);
    return https(result.data?.signedUrl);
  }));
  return images.flatMap((image) => image ? [{ ...review.creatives[0], image_url: image, media_kind: "image" as const }] : []);
}

export async function resolveAdReviewMedia(tenantId: string, execClass: string, payload: unknown, review: AdReviewPresentation): Promise<AdReviewPresentation> {
  let creatives = review.creatives;
  if (execClass.startsWith("reddit_ads.")) creatives = await reddit(tenantId, payload, review);
  else if (execClass.startsWith("google_ads.")) creatives = await google(tenantId, payload, review);
  else if (execClass.startsWith("meta_ads.")) creatives = await meta(tenantId, payload, review);
  else if (execClass.startsWith("linkedin_ads.")) creatives = await linkedin(tenantId, payload, review);
  else if (execClass.startsWith("tiktok_ads.")) creatives = await tiktok(tenantId, payload, review);
  else if (execClass.startsWith("x_ads.")) creatives = await x(tenantId, payload, review);
  const artifacts = atPath(payload, execClass === "chatgpt_ads.create_and_launch" ? "bundle.ads" : execClass === "chatgpt_ads.create_campaign_bundle" ? "ads" : "creatives");
  if (Array.isArray(artifacts)) creatives = await Promise.all(creatives.map(async (creative, index) => ({ ...creative, image_url: creative.image_url ?? await artifact(tenantId, atPath(artifacts[index], "image_artifact_id")) })));
  return { ...review, creatives: creatives.flatMap((creative) => { const parsed = adReviewCreativeSchema.safeParse(creative); return parsed.success ? [parsed.data] : []; }) };
}
