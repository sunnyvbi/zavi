import { expect, it, vi } from "vitest";
import { countryFromLocation, countryFromWebsite, countryOptions, isOwnAdImagePath } from "@zavi/shared";
import { resolveAdReviewMedia } from "@/services/channels/ad-review/media";
import { readAdReview, revisedAd, type ReviewRow } from "@/services/channels/ad-review/revision";
import { adReviewVersion } from "@/services/channels/ad-review/version";

const media = vi.hoisted(() => ({ fb: vi.fn(), linkedin: vi.fn(), tt: vi.fn(), accounts: vi.fn(), tweets: vi.fn() }));
function savedMetaVideo(id: string): ReviewRow {
  return { id, channel_slug: "meta_ads", exec_class: "meta_ads.create_ad", exec_payload: { ad_set_id: "12345", headline: "Saved headline", primary_text: "Saved text", link_url: "https://example.com", video_asset_id: "123456", source: "library" }, body: {}, status: "pending", exec_status: null, approved_by: null, score: 0, score_inputs: {}, blocking: false, impact: null, impact_reason: null };
}
vi.mock("@/services/tools/meta-ads/_client", async (original) => ({ ...await original<typeof import("@/services/tools/meta-ads/_client")>(), fbGet: media.fb }));
vi.mock("@/services/connectors/linkedin-ads/client", async (original) => ({ ...await original<typeof import("@/services/connectors/linkedin-ads/client")>(), linkedinAdsToken: async () => "token", withLinkedInAdsToken: async <T,>(_t: string, call: (token: string) => Promise<T>) => call("token") }));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => ({ ...await original<typeof import("@/services/connectors/linkedin-ads/http")>(), linkedinAdsBatchGet: media.linkedin }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", async (original) => ({ ...await original<typeof import("@/services/connectors/tiktok-ads/composio-read")>(), tiktokAdsAccount: async () => ({ id: "owned" }), tt: media.tt }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", async (original) => ({ ...await original<typeof import("@/services/connectors/tiktok-ads/ad-accounts")>(), ensureAdAccounts: media.accounts }));
vi.mock("@/services/connectors/x-ads/client", async (original) => ({ ...await original<typeof import("@/services/connectors/x-ads/client")>(), xAdsTenantToken: async () => "token", listXAdAccountsRaw: async () => [{ id: "owned" }], xAdsRequest: media.tweets }));

it("loads LinkedIn post copy and its image from the saved URN", async () => {
  media.linkedin.mockResolvedValueOnce({ "urn:li:share:123": { commentary: "Actual saved post", content: { media: { id: "urn:li:image:abc" } } } })
    .mockResolvedValueOnce({ "urn:li:image:abc": { downloadUrl: "https://media.example/image.jpg" } });
  const review = await resolveAdReviewMedia("tenant", "linkedin_ads.create_campaign_bundle", { creative: { post_urn: "urn:li:share:123" } }, { creatives: [{ source: "An existing company post" }] });
  expect(review.creatives[0]).toMatchObject({ body: "Actual saved post", image_url: "https://media.example/image.jpg" });
  expect(media.linkedin).toHaveBeenCalledWith("token", "posts", ["urn:li:share:123"]);
  expect(media.linkedin).toHaveBeenCalledWith("token", "images", ["urn:li:image:abc"]);
});
it("resolves a copied Meta ad’s video while retaining its real thumbnail", async () => {
  media.fb.mockResolvedValueOnce({ creative: { video_id: "123456", thumbnail_url: "https://media.example/poster.jpg" } })
    .mockResolvedValueOnce({ source: "https://media.example/video.mp4" });
  const review = await resolveAdReviewMedia("tenant", "meta_ads.create_ad", { source_ad_id: "12345" }, { creatives: [{ title: "Saved title" }] });
  expect(review.creatives[0]).toMatchObject({ title: "Saved title", image_url: "https://media.example/poster.jpg", video_url: "https://media.example/video.mp4" });
});
it("resolves a TikTok upload only inside the tenant’s readable advertiser accounts", async () => {
  media.tt.mockClear();
  media.accounts.mockResolvedValue({ accounts: [{ advertiser_id: "owned" }] });
  media.tt.mockResolvedValue({ list: [{ video_id: "v1", preview_url: "https://video.example/video.mp4", video_cover_url: "https://video.example/cover.jpg" }] });
  const proposal = { advertiser_id: "owned", video: { video_id: "v1" } };
  const actual = await resolveAdReviewMedia("tenant", "tiktok_ads.create_launch", proposal, { creatives: [{ body: "Saved copy" }] });
  expect(actual.creatives[0].video_url).toBe("https://video.example/video.mp4");
  await resolveAdReviewMedia("tenant", "tiktok_ads.create_launch", { ...proposal, advertiser_id: "other" }, { creatives: [{ body: "Saved copy" }] });
  expect(media.tt).toHaveBeenCalledTimes(1);
});
it("maps X post text to the exact saved post instead of another response entry", async () => {
  media.tweets.mockResolvedValue({ data: [{ id_str: "456", text: "Other post" }, { id_str: "123", full_text: "Actual promoted text", extended_entities: { media: [{ media_url_https: "https://media.example/post.jpg" }] } }] });
  const result = await resolveAdReviewMedia("tenant", "x_ads.create_campaign", { account_id: "owned", tweet_ids: ["123"] }, { creatives: [{ target_url: "https://x.com/i/web/status/123" }] });
  expect(result.creatives[0]).toMatchObject({ body: "Actual promoted text", image_url: "https://media.example/post.jpg" });
});
it("deduplicates saved media reads without sharing them across tenants", async () => {
  media.fb.mockClear();
  media.fb.mockImplementation(async (tenant: string) => ({ source: `https://video.example/${tenant}.mp4` }));
  const row = savedMetaVideo("cache-row");
  const [first, duplicate] = await Promise.all([readAdReview("first", row), readAdReview("first", row)]);
  expect(first.review).toEqual(duplicate.review);
  expect(first.review?.creatives[0].video_url).toBe("https://video.example/first.mp4");
  expect((await readAdReview("second", row)).review?.creatives[0].video_url).toBe("https://video.example/second.mp4");
  expect(media.fb).toHaveBeenCalledTimes(2);
});
it("publishing blockers require a confirmed connection failure and never expose raw provider errors", async () => {
  media.fb.mockRejectedValueOnce(Object.assign(new Error("private upstream details"), { code: "meta_ads_not_connected" }));
  const missing = await readAdReview("tenant", savedMetaVideo("connection-row"));
  expect(missing.connection_blocker?.message).toContain("reconnect Meta Ads");
  expect(JSON.stringify(missing)).not.toContain("private upstream details");
  media.fb.mockRejectedValueOnce(Object.assign(new Error("private upstream details"), { code: "meta_ads_permission_revoked" }));
  const readPermission = await readAdReview("tenant", savedMetaVideo("connection-row"), true);
  expect(readPermission.connection_blocker).toBeNull();
  expect(readPermission.limitations.length).toBeGreaterThan(0);
});
it("saved image edits replace stale attached preview media while leaving the original proposal immutable", () => {
  const row: ReviewRow = { ...savedMetaVideo("revision-row"), exec_payload: { ad_set_id: "12345", headline: "Before", primary_text: "Saved text", link_url: "https://example.com", image_url: "https://media.example/before.jpg", source: "library" }, body: { media: { kind: "image", url: "https://media.example/before.jpg" } } };
  const version = adReviewVersion("meta_ads.create_ad", row.exec_payload);
  const next = revisedAd(row, version, { image_url: "https://media.example/after.jpg", headline: "After" });
  expect(next.body.media).toBeUndefined();
  expect(next.body.ad_review_edited).toBe(true);
  expect(next.payload).toMatchObject({ headline: "After", image_url: "https://media.example/after.jpg" });
  expect(row.exec_payload).toMatchObject({ headline: "Before", image_url: "https://media.example/before.jpg" });
  expect(() => revisedAd(row, "b".repeat(64), { headline: "After" })).toThrow("changed");
  expect(() => revisedAd({ ...row, exec_status: "queued" }, version, { headline: "After" })).toThrow("changed");
});

it.each([
  ["San Francisco, CA, USA", "US"], ["Austin, Texas, United States", "US"], ["London, UK", "GB"],
  ["Toronto, Ontario, Canada", "CA"], ["Berlin, Germany", "DE"], ["Bengaluru, India", "IN"], ["Dubai, UAE", "AE"],
])("reads the country from %j", (location, code) => {
  expect(countryFromLocation(location)).toBe(code);
});
it.each([
  "San Francisco, CA", "Portland, OR", "Paris, TX", "Remote", "", "Earth", "Georgia",
])("never guesses from an ambiguous or missing country: %j", location => {
  if (location === "Georgia") expect(countryFromLocation(location)).toBe("GE");
  else expect(countryFromLocation(location)).toBeNull();
});
it("lists real countries only, sorted by name, with no groupings or private codes", () => {
  const list = countryOptions();
  const codes = list.map(c => c.code);
  expect(codes).toEqual(expect.arrayContaining(["US", "CA", "GB", "IN", "AE", "DE"]));
  for (const code of ["EU", "UN", "ZZ", "QO", "XK", "AC", "EZ"]) expect(codes).not.toContain(code);
  expect(list.map(c => c.name)).toEqual([...list.map(c => c.name)].sort((a, b) => a.localeCompare(b)));
  expect(list.length).toBeGreaterThan(240);
});
it("an image path belongs to exactly its own workspace folder", () => {
  const t = "11111111-1111-4111-8111-111111111111";
  expect(isOwnAdImagePath(t, `${t}/33333333-3333-4333-8333-333333333333.jpg`)).toBe(true);
  expect(isOwnAdImagePath(t, `22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg`)).toBe(false);
  expect(isOwnAdImagePath(t, `${t}/33333333-3333-4333-8333-333333333333.jpg/../x`)).toBe(false);
});
it.each([
  ["https://shop.example.co.uk", "GB"], ["example.de", "DE"], ["https://www.example.ca/path", "CA"], ["http://example.in", "IN"],
  ["https://example.com", null], ["https://example.io", null], ["https://example.ai", null], ["https://example.co", null], ["not a url", null], [null, null],
])("reads a country from the website address %j only when it is a real country domain", (site, code) => {
  expect(countryFromWebsite(site)).toBe(code);
});
