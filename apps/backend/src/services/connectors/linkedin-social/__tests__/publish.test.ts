import { describe, it, expect, vi, beforeEach } from "vitest";

const getSecret = vi.fn();

vi.mock("@/services/secrets/vault", () => ({
  getSecret: (...args: unknown[]) => getSecret(...args),
}));

import { publishLinkedInText, publishLinkedInImage, publishLinkedInVideo } from "../publish";
import { resolveChannelAction } from "../../social-channels";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

beforeEach(() => {
  getSecret.mockReset();
  getSecret.mockImplementation(async (_t: string, key: string) => {
    if (key.endsWith("access_token")) return "tok_test";
    if (key.endsWith("author_urn")) return "urn:li:person:abc123";
    return null;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 201,
      headers: { get: (h: string) => (h === "x-restli-id" ? "urn:li:share:999" : null) },
      json: async () => ({}),
    })),
  );
});

describe("publishLinkedInText", () => {
  it("posts to ugcPosts with bearer token and author urn", async () => {
    const r = await publishLinkedInText(TENANT, "Hello native LinkedIn");
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.linkedin.com/v2/ugcPosts");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_test");
    const body = JSON.parse(String(init.body));
    expect(body.author).toBe("urn:li:person:abc123");
    expect(body.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text).toBe(
      "Hello native LinkedIn",
    );
  });

  it("fails when not connected", async () => {
    getSecret.mockResolvedValue(null);
    await expect(publishLinkedInText(TENANT, "x")).rejects.toThrow(/not connected/);
  });

  it.each(["", "a".repeat(3001), "a".repeat(2999) + "🚗", "e\u0301".repeat(1501)])("refuses invalid text before any provider call (case %#)", async (text) => {
    const result = await publishLinkedInText(TENANT, text);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(resolveChannelAction("linkedin").payload_schema.safeParse({ text }).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each(["a".repeat(3000), "a".repeat(2998) + "🚗", "e\u0301".repeat(1500)])("publishes exact valid boundary copy unchanged (case %#)", async (text) => {
    expect(resolveChannelAction("linkedin").payload_schema.safeParse({ text }).success).toBe(true);
    expect((await publishLinkedInText(TENANT, text)).ok).toBe(true);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text).toBe(text);
  });
});

describe("publishLinkedInImage text validation", () => {
  it.each(["", "a".repeat(3001), "a".repeat(2999) + "🚗"])("refuses invalid text before image fetch or upload (case %#)", async (text) => {
    expect(await publishLinkedInImage(TENANT, text, "https://storage.example/image.jpg")).toMatchObject({ ok: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("preserves exact approved image caption through upload and post", async () => {
    const text = "e\u0301".repeat(1499) + "🚗";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: { asset: "urn:li:digitalmediaAsset:123", uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.example/image" } } } }) } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    expect((await publishLinkedInImage(TENANT, text, "https://storage.example/image.jpg")).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[3][1]?.body));
    expect(body.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text).toBe(text);
    expect(body.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory).toBe("IMAGE");
  });
});

describe("LinkedIn media upload refusals come back as results, never throws", () => {
  const media = { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as Response;
  const registered = { ok: true, status: 200, json: async () => ({ value: { asset: "urn:li:digitalmediaAsset:123", uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.example/image" } } } }) } as Response;
  const calledUgcPosts = () => vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "https://api.linkedin.com/v2/ugcPosts");

  it("image: a registerUpload 403 returns the 403 and never creates the post", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(media)
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ message: "Not enough permissions to access: assets.registerUpload", serviceErrorCode: 100 }) } as Response);
    const r = await publishLinkedInImage(TENANT, "caption", "https://storage.example/image.jpg");
    expect(r).toMatchObject({ ok: false, status: 403, raw: { serviceErrorCode: 100 } });
    expect(calledUgcPosts()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("video: a registerUpload 422 with an unreadable body returns the 422 and never creates the post", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(media)
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response);
    const r = await publishLinkedInVideo(TENANT, "caption", "https://storage.example/clip.mp4");
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calledUgcPosts()).toBe(false);
    const regBody = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(regBody.registerUploadRequest.recipes).toEqual(["urn:li:digitalmediaRecipe:feedshare-video"]);
  });

  it("image: a registerUpload 200 with no upload URL is a 502, never a throw", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(media)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ value: { asset: "urn:li:digitalmediaAsset:123" } }) } as Response);
    const r = await publishLinkedInImage(TENANT, "caption", "https://storage.example/image.jpg");
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(calledUgcPosts()).toBe(false);
  });

  it.each([
    ["image", 400],
    ["video", 413],
    ["video", 503],
  ] as const)("%s: an upload PUT %i returns that status and never creates the post", async (kind, status) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(media)
      .mockResolvedValueOnce(registered)
      .mockResolvedValueOnce({ ok: false, status, text: async () => "upload refused" } as Response);
    const r = kind === "image"
      ? await publishLinkedInImage(TENANT, "caption", "https://storage.example/image.jpg")
      : await publishLinkedInVideo(TENANT, "caption", "https://storage.example/clip.mp4");
    expect(r).toMatchObject({ ok: false, status });
    expect(vi.mocked(fetch).mock.calls[2][0]).toBe("https://upload.example/image");
    expect(calledUgcPosts()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
