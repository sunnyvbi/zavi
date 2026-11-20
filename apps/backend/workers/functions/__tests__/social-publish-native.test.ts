
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  publishLinkedInText: vi.fn(),
  publishLinkedInImage: vi.fn(),
  publishXText: vi.fn(),
  publishXThread: vi.fn(),
  publishXMedia: vi.fn(),
  publishInstagramImage: vi.fn(),
  publishRedditSelfPost: vi.fn(),
}));

vi.mock("@/services/connectors/linkedin-social/publish", () => ({
  publishLinkedInText: m.publishLinkedInText,
  publishLinkedInImage: m.publishLinkedInImage,
}));
vi.mock("@/services/connectors/x-social/publish", () => ({
  publishXText: m.publishXText,
  publishXThread: m.publishXThread,
  publishXMedia: m.publishXMedia,
}));
vi.mock("@/services/connectors/reddit-social/publish", () => ({
  publishRedditSelfPost: m.publishRedditSelfPost,
}));
vi.mock("@/services/connectors/instagram-social/publish", () => ({
  publishInstagramImage: m.publishInstagramImage,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/connectors/pipedream/api", () => ({ runAction: vi.fn() }));
vi.mock("@/services/connectors/social-publish-account", () => ({
  verifySocialAccountAtPublish: vi.fn(),
}));

import { extractIds, publishNative } from "../social-publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OK = { ok: true, status: 201, raw: { id: "urn:li:share:1" } };

beforeEach(() => {
  m.publishLinkedInText.mockReset().mockResolvedValue(OK);
  m.publishLinkedInImage.mockReset().mockResolvedValue(OK);
  m.publishXText.mockReset().mockResolvedValue({ ok: true, status: 201, raw: { id: "17" } });
  m.publishRedditSelfPost.mockReset().mockResolvedValue({ ok: true, status: 200, raw: { id: "1abc", name: "t3_1abc", url: "https://www.reddit.com/r/SaaS/comments/1abc/t/" } });
  m.publishInstagramImage.mockReset().mockResolvedValue({ ok: true, status: 200, raw: { id: "m1", permalink: "https://www.instagram.com/p/AbC/" } });
});

describe("publishNative", () => {
  it("reddit → publishRedditSelfPost with the frozen subreddit/title/text (kind is the publisher's, never the props')", async () => {
    const r = await publishNative(TENANT, "reddit", { subreddit: "SaaS", title: "T", kind: "self", text: "body" });
    expect(r.ok).toBe(true);
    expect(m.publishRedditSelfPost).toHaveBeenCalledWith(TENANT, "SaaS", "T", "body");
  });

  it("reddit REFUSES frozen props missing subreddit or title — stable 400, no vendor call", async () => {
    const r = await publishNative(TENANT, "reddit", { text: "body" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(m.publishRedditSelfPost).not.toHaveBeenCalled();
  });

  it("x → publishXText with the frozen text", async () => {
    const r = await publishNative(TENANT, "x", { text: "tweet" });
    expect(r.ok).toBe(true);
    expect(m.publishXText).toHaveBeenCalledWith(TENANT, "tweet");
    expect(m.publishLinkedInText).not.toHaveBeenCalled();
  });

  it("linkedin → publishLinkedInText with the frozen text", async () => {
    const r = await publishNative(TENANT, "linkedin", { text: "hello", visibility: "PUBLIC" });
    expect(r).toEqual(OK);
    expect(m.publishLinkedInText).toHaveBeenCalledWith(TENANT, "hello");
    expect(m.publishLinkedInImage).not.toHaveBeenCalled();
  });

  it("linkedin_image → publishLinkedInImage with text + the SIGNED URL in `file`", async () => {
    const url = "https://sb.example/storage/v1/object/sign/x.jpg?token=abc";
    const r = await publishNative(TENANT, "linkedin_image", { text: "cap", file: url, visibility: "PUBLIC" });
    expect(r).toEqual(OK);
    expect(m.publishLinkedInImage).toHaveBeenCalledWith(TENANT, "cap", url);
  });

  it("linkedin_image REFUSES when `file` is still a storage path (resolveMediaProps did not run)", async () => {
    const r = await publishNative(TENANT, "linkedin_image", {
      text: "cap",
      file: `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(m.publishLinkedInImage).not.toHaveBeenCalled();
  });

  it("a channel with no native publisher is a stable 4xx, not a throw", async () => {
    const r = await publishNative(TENANT, "mastodon", { text: "x" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(String((r.raw as { error: string }).error)).toMatch(/no native publisher/);
  });

  it("passes a vendor failure through unchanged (worker maps 4xx → vendor_rejected)", async () => {
    m.publishLinkedInText.mockResolvedValue({ ok: false, status: 401, raw: { message: "expired" } });
    const r = await publishNative(TENANT, "linkedin", { text: "hello" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});

describe("publishNative — media channels", () => {
  const IMG = "https://sb.example/storage/v1/object/sign/x.jpg?token=abc";
  const VID = "https://sb.example/storage/v1/object/sign/v.mp4?token=abc";

  it("instagram_image → publishInstagramImage with caption + the SIGNED URL in `file`", async () => {
    const r = await publishNative(TENANT, "instagram_image", { text: "cap", file: IMG });
    expect(r.ok).toBe(true);
    expect(m.publishInstagramImage).toHaveBeenCalledWith(TENANT, "cap", IMG);
  });

  it("instagram_image REFUSES a storage path still in `file` (resolveMediaProps did not run)", async () => {
    const r = await publishNative(TENANT, "instagram_image", { text: "cap", file: `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg` });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(m.publishInstagramImage).not.toHaveBeenCalled();
  });

  it("youtube_video has no native publisher (YouTube is Composio-only) — stable 400", async () => {
    const r = await publishNative(TENANT, "youtube_video", { file: VID, title: "Launch", text: "desc" });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe("publishNative — x threads", () => {
  beforeEach(() => {
    m.publishXThread.mockReset().mockResolvedValue({ ok: true, status: 201, raw: { id: "17", thread_ids: ["18"] } });
  });

  it("routes a thread to publishXThread with root + parts", async () => {
    const r = await publishNative(TENANT, "x", { text: "root", thread: ["two", "three"] });
    expect(m.publishXThread).toHaveBeenCalledWith(TENANT, "root", ["two", "three"]);
    expect(m.publishXText).not.toHaveBeenCalled();
    expect(r.raw).toMatchObject({ id: "17" });
  });

  it("a plain post (no thread / empty thread) still routes to publishXText", async () => {
    await publishNative(TENANT, "x", { text: "root" });
    await publishNative(TENANT, "x", { text: "root", thread: [] });
    expect(m.publishXText).toHaveBeenCalledTimes(2);
    expect(m.publishXThread).not.toHaveBeenCalled();
  });
});

describe("publishNative — x_image / x_video", () => {
  beforeEach(() => {
    m.publishXMedia.mockReset().mockResolvedValue({ ok: true, status: 201, raw: { id: "17", media_id: "m-1" } });
  });
  const URL_ = "https://sb.example/storage/v1/object/sign/x.jpg?token=abc";

  it("routes an image post to publishXMedia with the signed URL", async () => {
    const r = await publishNative(TENANT, "x_image", { text: "pic", file: URL_ });
    expect(m.publishXMedia).toHaveBeenCalledWith(TENANT, "pic", URL_, "image");
    expect(r.raw).toMatchObject({ id: "17" });
  });

  it("routes a video post to publishXMedia as video", async () => {
    await publishNative(TENANT, "x_video", { text: "clip", file: "https://sb.example/v.mp4?t=1" });
    expect(m.publishXMedia).toHaveBeenCalledWith(TENANT, "clip", "https://sb.example/v.mp4?t=1", "video");
  });

  it("REFUSES a storage path still in `file` — stable 400, no vendor call", async () => {
    const r = await publishNative(TENANT, "x_image", { text: "pic", file: `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg` });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(m.publishXMedia).not.toHaveBeenCalled();
  });
});

describe("extractIds — X status link", () => {
  for (const channel of ["x", "x_image", "x_video"]) {
    it(`${channel}: synthesises the status URL from the post id`, () => {
      expect(extractIds(channel, { id: "1830000000000000001" })).toEqual({
        externalPostId: "1830000000000000001",
        externalUrl: "https://x.com/i/web/status/1830000000000000001",
      });
    });
  }
});

describe("extractIds — TikTok post id and link", () => {
  it("tiktok_video: keeps the public post id and links the post on the creator's profile", () => {
    expect(
      extractIds("tiktok_video", {
        publish_id: "v_pub_url~v2.123",
        status: "PUBLISH_COMPLETE",
        publicaly_available_post_id: ["7300000000000000001"],
        creator_username: "upcar",
      }),
    ).toEqual({
      externalPostId: "7300000000000000001",
      externalUrl: "https://www.tiktok.com/@upcar/video/7300000000000000001",
    });
  });

  it("tiktok_video: a private post with no public id keeps the publish_id and no link", () => {
    expect(
      extractIds("tiktok_video", { publish_id: "v_pub_url~v2.123", publicaly_available_post_id: [], creator_username: "upcar" }),
    ).toEqual({ externalPostId: "v_pub_url~v2.123", externalUrl: null });
  });
});

describe("extractIds — LinkedIn media feed link", () => {
  for (const channel of ["linkedin", "linkedin_image", "linkedin_video"]) {
    it(`${channel}: builds the feed URL from the post urn`, () => {
      expect(extractIds(channel, { id: "urn:li:ugcPost:7100000000000000001" })).toEqual({
        externalPostId: "urn:li:ugcPost:7100000000000000001",
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7100000000000000001",
      });
    });
  }
});
