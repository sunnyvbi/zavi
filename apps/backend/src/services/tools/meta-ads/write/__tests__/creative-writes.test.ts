
import { describe, it, expect, vi, beforeEach } from "vitest";

const g = vi.hoisted(() => ({
  fbGet: vi.fn(),
  fbPost: vi.fn(),
  creds: vi.fn(),
  cap: vi.fn(),
  safeFetchImage: vi.fn(),
  media: vi.fn(),
}));
vi.mock("../../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  fbPost: (...a: unknown[]) => g.fbPost(...a),
  metaAdsCreds: (...a: unknown[]) => g.creds(...a),
}));
vi.mock("../_library-ad-capability", () => ({ resolveMetaAdCapability: (...a: unknown[]) => g.cap(...a) }));
vi.mock("../launch", () => ({ resolveCreativeMedia: (...a: unknown[]) => g.media(...a) }));
vi.mock("@/services/media-router/vendors/safe-fetch", () => ({ safeFetchImage: (...a: unknown[]) => g.safeFetchImage(...a) }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));

import { metaCreateCreative, metaUpdateCreative, metaUploadAsset } from "../creative_writes";
import { createCreativeBodySchema, uploadAssetBodySchema } from "../_decision-bodies";
import { metaProposeCreativeTool } from "../propose_creative";
import { metaPreviewTool, previewLink } from "../../creative_reads";
import type { ToolContext } from "@/services/tools/types";

const copy = { name: "Autumn", primary_text: "Book a ride", headline: "Rides from $9", link_url: "https://example.com/book" };

beforeEach(() => {
  vi.clearAllMocks();
  g.creds.mockResolvedValue({ ad_account_id: "act_555", access_token: "t" });
  g.cap.mockResolvedValue({ ok: true, ad_account_id: "act_555", page_id: "PAGE1", page_name: "P", ad_sets: [] });
  g.media.mockResolvedValue({ image_url: "https://cdn.example.com/a.png" });
});

describe("creatives", () => {
  it("a body names exactly one piece of media", () => {
    expect(createCreativeBodySchema.safeParse({ ...copy }).success).toBe(false);
    expect(createCreativeBodySchema.safeParse({ ...copy, image_url: "https://x.example/a.png", source_ad_id: "238000000777" }).success).toBe(false);
    expect(createCreativeBodySchema.safeParse({ ...copy, image_url: "https://x.example/a.png" }).success).toBe(true);
  });

  it("a fresh creative is built on the tenant's Page with the tagged name", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [] });
    g.fbPost.mockResolvedValueOnce({ id: "777000" });
    const body = createCreativeBodySchema.parse({ ...copy, image_url: "https://cdn.example.com/a.png" });
    const r = await metaCreateCreative("t1", { ...body, tag: "zvabc1234567" });
    expect(r).toEqual({ id: "777000", name: "Autumn · zvabc1234567", reused: false });
    const [, path, params] = g.fbPost.mock.calls[0] as [string, string, Record<string, string>];
    expect(path).toBe("act_555/adcreatives");
    expect(JSON.parse(params.object_story_spec)).toMatchObject({ page_id: "PAGE1", link_data: { picture: "https://cdn.example.com/a.png" } });
  });

  it("a retry finds its creative by the tag", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [{ id: "777000", name: "Autumn · zvabc1234567" }] });
    const body = createCreativeBodySchema.parse({ ...copy, image_url: "https://cdn.example.com/a.png" });
    expect((await metaCreateCreative("t1", { ...body, tag: "zvabc1234567" })).reused).toBe(true);
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("no Page connected refuses before any write", async () => {
    g.cap.mockResolvedValueOnce({ ok: false, reason_code: "page_missing", reason: "no Page" });
    const body = createCreativeBodySchema.parse({ ...copy, image_url: "https://cdn.example.com/a.png" });
    await expect(metaCreateCreative("t1", { ...body, tag: "zvabc1234567" })).rejects.toBeTruthy();
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a rename refuses a creative from another account", async () => {
    g.fbGet.mockResolvedValueOnce({ id: "777000", account_id: "999" });
    await expect(metaUpdateCreative("t1", { creative_id: "777000", new_name: "X", rationale: "" })).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });
});

describe("assets", () => {
  it("an image is downloaded through the guard and sent as bytes", async () => {
    g.safeFetchImage.mockResolvedValueOnce({ bytes: Buffer.from("png"), mime: "image/png" });
    g.fbPost.mockResolvedValueOnce({ images: { "a.png": { hash: "abc123", url: "https://scontent/a.png" } } });
    const r = await metaUploadAsset("t1", uploadAssetBodySchema.parse({ kind: "image", url: "https://cdn.example.com/a.png", name: "Hero" }));
    expect(r).toEqual({ kind: "image", hash: "abc123", url: "https://scontent/a.png" });
    expect(g.fbPost).toHaveBeenCalledWith("t1", "act_555/adimages", { bytes: Buffer.from("png").toString("base64"), name: "Hero" });
  });

  it("an image the guard refuses is never uploaded", async () => {
    g.safeFetchImage.mockResolvedValueOnce(null);
    await expect(metaUploadAsset("t1", uploadAssetBodySchema.parse({ kind: "image", url: "https://10.0.0.1/a.png", name: "x" }))).rejects.toMatchObject({ code: "meta_ads_invalid_media" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a video is sent to Meta by URL; the bytes never pass through Zavi", async () => {
    g.fbPost.mockResolvedValueOnce({ id: "vid1" });
    const r = await metaUploadAsset("t1", uploadAssetBodySchema.parse({ kind: "video", url: "https://cdn.example.com/v.mp4", name: "Clip" }));
    expect(r).toEqual({ kind: "video", video_id: "vid1" });
    expect(g.safeFetchImage).not.toHaveBeenCalled();
    expect(g.fbPost.mock.calls[0][1]).toBe("act_555/advideos");
  });
});

describe("tools", () => {
  const ctx = () => {
    const emit = vi.fn(async () => "d-1");
    return { c: { tenant_id: "t1", log: () => {}, emit_decision: emit, run_trigger: "scheduled" } as ToolContext, emit };
  };

  it("creative_id + new_name files a rename; otherwise a create", async () => {
    const a = ctx();
    await metaProposeCreativeTool.execute(a.c, { creative_id: "777000", new_name: "Autumn v2", rationale: "tidy" });
    expect(a.emit).toHaveBeenCalledWith("meta_ads.update_creative", expect.objectContaining({ creative_id: "777000", new_name: "Autumn v2" }));
    const b = ctx();
    await metaProposeCreativeTool.execute(b.c, { ...copy, image_url: "https://cdn.example.com/a.png", rationale: "new angle" });
    expect(b.emit).toHaveBeenCalledWith("meta_ads.create_creative", expect.objectContaining({ name: "Autumn", headline: "Rides from $9" }));
  });

  it("an http media link is proposed over https, never fetched as http", async () => {
    const a = ctx();
    await metaProposeCreativeTool.execute(a.c, { ...copy, image_url: "http://cdn.example.com/a.png", rationale: "new angle" });
    expect(a.emit).toHaveBeenCalledWith("meta_ads.create_creative", expect.objectContaining({ image_url: "https://cdn.example.com/a.png" }));
  });

  it("a preview is read only for an object in this account, and returns Meta's link", async () => {
    g.fbGet.mockResolvedValueOnce({ account_id: "555" }).mockResolvedValueOnce({ data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=1&amp;t=2"></iframe>' }] });
    const r = await metaPreviewTool.execute(ctx().c, { creative_id: "777000" });
    expect(r).toEqual({ ad_format: "MOBILE_FEED_STANDARD", preview_url: "https://www.facebook.com/ads/api/preview_iframe.php?d=1&t=2" });
    g.fbGet.mockResolvedValueOnce({ account_id: "999" });
    await expect(metaPreviewTool.execute(ctx().c, { ad_id: "238000000777" })).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(previewLink("no iframe")).toBeNull();
  });
});
