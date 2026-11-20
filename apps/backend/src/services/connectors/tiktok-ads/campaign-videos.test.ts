import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accounts: vi.fn(), account: vi.fn(), tt: vi.fn(), read: vi.fn(), upload: vi.fn(),
  zavi: vi.fn(), uploaded: vi.fn(), safe: vi.fn(), find: vi.fn(), remember: vi.fn(), store: vi.fn(),
}));
vi.mock("./ad-accounts", () => ({ ensureAdAccounts: h.accounts }));
vi.mock("./composio-read", () => ({ tiktokAdsAccount: h.account, tt: h.tt }));
vi.mock("./launch-readiness", () => ({ readLaunchVideo: h.read, uploadLaunchVideo: h.upload }));
vi.mock("./zavi-videos", () => ({ signedZaviVideoUrl: h.zavi, signedUploadedVideoUrl: h.uploaded, UPLOADED_VIDEO_PATH_RE: /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/ }));
vi.mock("./video-uploads", async (original) => ({ ...await original<typeof import("./video-uploads")>(), videoUploadStore: h.store }));
vi.mock("@/services/onboarding/enrichment/url-guard", async (original) => ({ ...await original<typeof import("@/services/onboarding/enrichment/url-guard")>(), assertSafeUrl: h.safe }));

import { listCampaignVideos, prepareCampaignVideo } from "./campaign-videos";
import { SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";

const T = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const account = { id: "owned-connection" };
const facts = { video_id: "vid", width: 720, height: 1280, duration_s: 15, allowed_placements: ["PLACEMENT_TIKTOK"], displayable: true, cover_url: "https://cdn.example/cover.jpg" };
beforeEach(() => {
  vi.clearAllMocks();
  h.accounts.mockResolvedValue({ connected: true, accounts: [{ advertiser_id: "123" }] });
  h.account.mockResolvedValue(account);
  h.safe.mockImplementation(async (u: string) => new URL(u));
  h.zavi.mockResolvedValue({ url: "https://storage.example/signed.mp4", filename: "generated.mp4" });
  h.uploaded.mockResolvedValue({ url: "https://storage.example/upload.mp4", filename: "upload.mp4" });
  h.store.mockReturnValue({ find: h.find, remember: h.remember });
  h.find.mockResolvedValue(null);
  h.remember.mockResolvedValue(undefined);
  h.upload.mockResolvedValue("vid");
  h.read.mockResolvedValue(facts);
  h.tt.mockResolvedValue({ list: [{ video_id: "vid", file_name: "Demo", video_cover_url: "https://cdn.example/v.jpg" }], page_info: { total_page: 1 } });
});

describe("campaign video library", () => {
  it("reads only the requested saved advertiser, using TikTok's bounded search endpoint", async () => {
    expect(await listCampaignVideos(T, "123")).toEqual({ videos: [{ video_id: "vid", name: "Demo", preview_url: "https://cdn.example/v.jpg" }], truncated: false, page: 1, next_page: null });
    expect(h.accounts).toHaveBeenCalledWith(T);
    expect(h.account).toHaveBeenCalledWith(T);
    expect(h.tt).toHaveBeenCalledWith(account, "/file/video/ad/search/?advertiser_id=123&page=1&page_size=100");
  });
  it("reports partial lists, and does not expose non-HTTPS preview URLs", async () => {
    h.tt.mockResolvedValue({ list: [{ video_id: "v", video_cover_url: "javascript:alert(1)" }], page_info: { total_page: 2 } });
    expect(await listCampaignVideos(T, "123")).toEqual({ videos: [{ video_id: "v", name: "v", preview_url: null }], truncated: true, page: 1, next_page: 2 });
  });
  it("loads a later provider page and stops at the reported last page", async () => {
    h.tt.mockResolvedValue({ list: [{ video_id: "v2" }], page_info: { total_page: 2 } });
    expect(await listCampaignVideos(T, "123", { page: 2 })).toMatchObject({ videos: [{ video_id: "v2" }], page: 2, next_page: null, truncated: false });
    expect(h.tt).toHaveBeenCalledWith(account, "/file/video/ad/search/?advertiser_id=123&page=2&page_size=100");
  });
  it("allows another page when a full response omits page metadata, and rejects invalid pages", async () => {
    h.tt.mockResolvedValue({ list: Array.from({ length: 100 }, (_, i) => ({ video_id: `v${i}` })) });
    expect(await listCampaignVideos(T, "123")).toMatchObject({ next_page: 2, truncated: true });
    h.tt.mockClear();
    for (const page of [0, -1, 1.5, Number.NaN]) await expect(listCampaignVideos(T, "123", { page })).rejects.toThrow();
    expect(h.tt).not.toHaveBeenCalled();
  });
  it("distinguishes a failed or malformed list from an empty library", async () => {
    h.tt.mockResolvedValue({ list: null });
    await expect(listCampaignVideos(T, "123")).rejects.toMatchObject({ code: "tiktok_ads_videos_unreadable" });
  });
});

describe("campaign video preparation", () => {
  it.each([{}, { video_artifact_id: A, video_url: "https://example.com/a.mp4" }])("requires exactly one source: %j", async (source) => {
    await expect(prepareCampaignVideo(T, "123", source)).rejects.toThrow();
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("refuses an advertiser outside this tenant before any provider call or signing", async () => {
    await expect(prepareCampaignVideo(T, "999", { video_artifact_id: A })).rejects.toMatchObject({ code: "tiktok_ads_unknown_account" });
    await expect(listCampaignVideos(T, "999")).rejects.toMatchObject({ code: "tiktok_ads_unknown_account" });
    expect(h.account).not.toHaveBeenCalled();
    expect(h.zavi).not.toHaveBeenCalled();
  });
  it("uploads the tenant-verified artifact and remembers its stable source key", async () => {
    expect(await prepareCampaignVideo(T, "123", { video_artifact_id: A })).toEqual({ ...facts, ai_generated: true });
    expect(h.zavi).toHaveBeenCalledWith(T, A);
    expect(h.store).toHaveBeenCalledWith(T);
    expect(h.upload).toHaveBeenCalledWith(account, "123", "https://storage.example/signed.mp4", "zavi-generated.mp4");
    expect(h.remember).toHaveBeenCalledWith("123", `zavi:${A}`, "vid");
  });
  it("keeps AI provenance unknown for a user-supplied link", async () => {
    expect(await prepareCampaignVideo(T, "123", { video_url: "https://example.com/video.mp4" })).toMatchObject({ video_id: "vid", ai_generated: null });
  });
  it("passes uploaded paths through the tenant ownership check", async () => {
    h.uploaded.mockRejectedValue(new Error("not this workspace"));
    await expect(prepareCampaignVideo(T, "123", { video_upload_path: `${A}/${A}.mp4` })).rejects.toThrow("not this workspace");
    expect(h.uploaded).toHaveBeenCalledWith(T, `${A}/${A}.mp4`);
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("rejects private links before upload", async () => {
    h.safe.mockRejectedValue(new SsrfBlockedError("private"));
    await expect(prepareCampaignVideo(T, "123", { video_url: "https://127.0.0.1/video.mp4" })).rejects.toMatchObject({ code: "tiktok_ads_video_url_unsafe" });
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("reuses a still-present library upload", async () => {
    h.find.mockResolvedValue("vid");
    await prepareCampaignVideo(T, "123", { video_artifact_id: A });
    expect(h.read).toHaveBeenCalledWith(account, "123", "vid");
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("does not duplicate a cached video when its verification read fails", async () => {
    h.find.mockResolvedValue("vid");
    h.read.mockRejectedValue(new Error("TikTok unavailable"));
    await expect(prepareCampaignVideo(T, "123", { video_artifact_id: A })).rejects.toThrow("TikTok unavailable");
    expect(h.upload).not.toHaveBeenCalled();
  });
  it("waits for measured facts and rejects an invalid creative", async () => {
    h.read.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...facts, width: 1280, height: 720 });
    await expect(prepareCampaignVideo(T, "123", { video_url: "https://example.com/video.mp4" })).rejects.toMatchObject({ code: "tiktok_ads_video_not_vertical" });
    expect(h.upload).toHaveBeenCalledTimes(1);
  });
});
