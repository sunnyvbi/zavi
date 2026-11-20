
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const USER_A = "22222222-bbbb-4bbb-8bbb-222222222222";
const ASSET_A = "33333333-cccc-4ccc-8ccc-333333333333";
const VIDEO_ID = "dQw4w9WgXcQ";
const AD_GROUP_ID = "987654321";
const TAG = "zavi-cr-abc123def456";

vi.mock("../../services/auth/middleware", () => ({ requireAuth: vi.fn() }));

vi.mock("../../services/tenant-client", () => ({
  tenantRpc: vi.fn(),
  asTenantId: (s: string) => s,
}));

vi.mock("../../services/creators/library", () => ({
  getLibraryAssetRow: vi.fn(),
  setLibraryAssetYoutubeVideoId: vi.fn(),
}));

vi.mock("../../services/tools/google-ads/_client", () => ({ gadsSearch: vi.fn() }));

vi.mock("../../services/tools/google-ads/write/_flag-check", () => ({
  isGoogleAdsWriteEnabled: vi.fn(async () => true),
}));

import { requireAuth } from "../../services/auth/middleware";
import { tenantRpc } from "../../services/tenant-client";
import {
  getLibraryAssetRow,
  setLibraryAssetYoutubeVideoId,
} from "../../services/creators/library";
import { gadsSearch } from "../../services/tools/google-ads/_client";
import {
  finalUrlWithTrackingTag,
  getCreatorLibraryYoutubeEligibility,
  postCreatorLibraryYoutubeAd,
  postCreatorLibraryYoutubeVideo,
} from "../../routes/creators/library-youtube";

function mkRes(): Response & { _status: number; _body: unknown } {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 200,
    _body: undefined,
    status(code: number) {
      r._status = code;
      return r as Response;
    },
    json(body: unknown) {
      r._body = body;
      return r as Response;
    },
  };
  return r as Response & { _status: number; _body: unknown };
}

function mkReq(body: unknown = {}): Request {
  return { params: { asset_id: ASSET_A }, body } as unknown as Request;
}

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function assetRow(over: Record<string, unknown> = {}) {
  return {
    id: ASSET_A,
    tenant_id: TENANT_A,
    order_id: "order-1",
    submission_id: "sub-1",
    human_member_id: "hm-1",
    rights_start_at: PAST,
    rights_end_at: FUTURE,
    utm_campaign: TAG,
    meta_ad_account_id: null,
    meta_video_id: null,
    meta_ad_id: null,
    meta_auto_paused_at: null,
    youtube_video_id: null,
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

const getRow = getLibraryAssetRow as ReturnType<typeof vi.fn>;
const setId = setLibraryAssetYoutubeVideoId as ReturnType<typeof vi.fn>;
const search = gadsSearch as ReturnType<typeof vi.fn>;
const rpc = tenantRpc as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user_id: USER_A,
    tenant_id: TENANT_A,
    access_token: "fake",
  });
  getRow.mockResolvedValue(assetRow());
  setId.mockImplementation(async (_t: string, _a: string, youtube_video_id: string) =>
    assetRow({ youtube_video_id }),
  );
  search.mockResolvedValue([
    {
      adGroup: {
        id: AD_GROUP_ID,
        name: "Creator cuts",
        status: "ENABLED",
        type: "VIDEO_TRUE_VIEW_IN_STREAM",
      },
      campaign: { id: "111", name: "Q4 video", status: "ENABLED" },
    },
  ]);
  rpc.mockResolvedValue({ data: "dec-abc", error: null });
});

describe("POST …/youtube-video (paste the id)", () => {
  it("a full watch URL is stored as the canonical 11-character id", async () => {
    const res = mkRes();
    await postCreatorLibraryYoutubeVideo(
      mkReq({ youtube_video: `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PL9&t=12s` }),
      res,
    );
    expect(res._status).toBe(200);
    expect(setId).toHaveBeenCalledWith(TENANT_A, ASSET_A, VIDEO_ID);
    expect((res._body as { youtube_video_id: string }).youtube_video_id).toBe(VIDEO_ID);
  });

  it("a youtu.be short link works too", async () => {
    const res = mkRes();
    await postCreatorLibraryYoutubeVideo(mkReq({ youtube_video: `https://youtu.be/${VIDEO_ID}` }), res);
    expect(setId).toHaveBeenCalledWith(TENANT_A, ASSET_A, VIDEO_ID);
  });

  it("a malformed id is refused with a 400 and stores nothing", async () => {
    const res = mkRes();
    await postCreatorLibraryYoutubeVideo(mkReq({ youtube_video: "not a video" }), res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe("bad_youtube_video_id");
    expect(setId).not.toHaveBeenCalled();
  });

  it("expired rights refuse the paste", async () => {
    getRow.mockResolvedValue(assetRow({ rights_end_at: PAST }));
    const res = mkRes();
    await postCreatorLibraryYoutubeVideo(mkReq({ youtube_video: VIDEO_ID }), res);
    expect(res._status).toBe(409);
    expect((res._body as { error: { code: string } }).error.code).toBe("rights_expired");
    expect(setId).not.toHaveBeenCalled();
  });

  it("another tenant's asset id is a 404, indistinguishable from not existing", async () => {
    getRow.mockResolvedValue(null);
    const res = mkRes();
    await postCreatorLibraryYoutubeVideo(mkReq({ youtube_video: VIDEO_ID }), res);
    expect(res._status).toBe(404);
    expect(setId).not.toHaveBeenCalled();
  });
});

describe("GET …/youtube-eligibility", () => {
  it("answers not eligible with the honest reason, before reading the Google account; Download stays", async () => {
    const res = mkRes();
    await getCreatorLibraryYoutubeEligibility(mkReq(), res);
    expect(res._body).toMatchObject({
      eligible: false,
      reason_code: "google_ads_video_create_unsupported",
      reason: expect.stringMatching(/Download the video and add it in Google Ads yourself/),
      download_available: true,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("expired rights still read as expired rights", async () => {
    getRow.mockResolvedValue(assetRow({ rights_end_at: PAST }));
    const res = mkRes();
    await getCreatorLibraryYoutubeEligibility(mkReq(), res);
    expect(res._body).toMatchObject({ eligible: false, reason_code: "rights_expired" });
  });
});

describe("POST …/youtube-ad (propose)", () => {
  const okBody = { ad_group_id: AD_GROUP_ID, final_url: "https://example.com/offer" };

  it("refuses before any proposal when no video id has been pasted", async () => {
    const res = mkRes();
    await postCreatorLibraryYoutubeAd(mkReq(okBody), res);
    expect(res._status).toBe(409);
    expect((res._body as { error: { code: string } }).error.code).toBe("youtube_video_id_missing");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a direct call is refused as a 409 the operator cannot fix here, and nothing is proposed", async () => {
    getRow.mockResolvedValue(assetRow({ youtube_video_id: VIDEO_ID }));
    const res = mkRes();
    await postCreatorLibraryYoutubeAd(mkReq(okBody), res);
    expect(res._status).toBe(409);
    expect((res._body as { error: { code: string } }).error.code).toBe("google_ads_video_create_unsupported");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an ad group that is not in the account is refused before any emit", async () => {
    getRow.mockResolvedValue(assetRow({ youtube_video_id: VIDEO_ID }));
    const res = mkRes();
    await postCreatorLibraryYoutubeAd(mkReq({ ...okBody, ad_group_id: "1234" }), res);
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe("youtube_ad_group_not_found");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("expired rights refuse the proposal", async () => {
    getRow.mockResolvedValue(assetRow({ youtube_video_id: VIDEO_ID, rights_end_at: PAST }));
    const res = mkRes();
    await postCreatorLibraryYoutubeAd(mkReq(okBody), res);
    expect(res._status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("finalUrlWithTrackingTag", () => {
  it("adds the asset's tag as utm_campaign", () => {
    expect(finalUrlWithTrackingTag("https://example.com/a", TAG)).toBe(
      `https://example.com/a?utm_campaign=${TAG}`,
    );
  });

  it("leaves an operator's own utm_campaign alone", () => {
    expect(finalUrlWithTrackingTag("https://example.com/a?utm_campaign=mine", TAG)).toBe(
      "https://example.com/a?utm_campaign=mine",
    );
  });
});
