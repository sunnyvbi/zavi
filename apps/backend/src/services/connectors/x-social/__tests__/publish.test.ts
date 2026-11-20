
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ getConnectorToken: vi.fn(), forceRefreshConnector: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: m.getConnectorToken,
  forceRefreshConnector: m.forceRefreshConnector,
}));

import { publishXText, isXSocialConnected } from "../publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

beforeEach(() => {
  m.forceRefreshConnector.mockReset().mockResolvedValue(undefined);
  m.getConnectorToken.mockReset().mockResolvedValue("tok_x");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: "1234567890", text: "hi" } }),
      text: async () => "",
    })),
  );
});

describe("publishXText", () => {
  it("posts to /2/tweets with the refreshed bearer token and the text", async () => {
    const r = await publishXText(TENANT, "hello X");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    expect(r.raw.id).toBe("1234567890");
    expect(m.getConnectorToken).toHaveBeenCalledWith(TENANT, "x_social", "x_social.access_token");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.com/2/tweets");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_x");
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello X" });
  });

  it("preserves a valid long URL exactly as approved", async () => {
    const text = "Read more https://example.com/" + "a".repeat(290);
    await publishXText(TENANT, text);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toBe(text);
  });

  it("refuses weighted overflow before contacting X instead of truncating it", async () => {
    const result = await publishXText(TENANT, "界".repeat(141));
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes a vendor failure through with its status (worker maps 4xx → vendor_rejected)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ title: "Forbidden", detail: "not permitted" }),
        text: async () => "",
      })),
    );
    const r = await publishXText(TENANT, "x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.raw.title).toBe("Forbidden");
  });

  it("throws when not connected (no token) — resolver should have refused earlier", async () => {
    m.getConnectorToken.mockResolvedValue(null);
    await expect(publishXText(TENANT, "x")).rejects.toThrow(/not connected/);
  });
});

it("refuses a whitespace-only tail before publishing the root", async () => {
  const result = await publishXThread(TENANT, "A valid root", ["   "]);
  expect(result).toMatchObject({ ok: false, status: 422 });
  expect(fetch).not.toHaveBeenCalled();
});

describe("isXSocialConnected", () => {
  it("true when a token resolves, false when it does not or the read throws", async () => {
    expect(await isXSocialConnected(TENANT)).toBe(true);
    m.getConnectorToken.mockResolvedValue(null);
    expect(await isXSocialConnected(TENANT)).toBe(false);
    m.getConnectorToken.mockRejectedValue(new Error("refresh failed"));
    expect(await isXSocialConnected(TENANT)).toBe(false);
  });
});

describe("publishXText — stale persisted token", () => {
  it("on 401 force-refreshes ONCE through the persisting path and retries with the new token", async () => {
    m.getConnectorToken.mockResolvedValueOnce("tok_stale").mockResolvedValueOnce("tok_new");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> => {
        const bearer = (init.headers as Record<string, string>).Authorization;
        calls.push(bearer);
        return bearer === "Bearer tok_new"
          ? { ok: true, status: 201, json: async () => ({ data: { id: "42" } }), text: async () => "" }
          : { ok: false, status: 401, json: async () => ({ title: "Unauthorized" }), text: async () => "" };
      }),
    );
    const r = await publishXText(TENANT, "retry me");
    expect(r.ok).toBe(true);
    expect(r.raw.id).toBe("42");
    expect(m.forceRefreshConnector).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["Bearer tok_stale", "Bearer tok_new"]);
  });

  it("does not loop when the refresh yields the same token", async () => {
    m.getConnectorToken.mockResolvedValue("tok_stale");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" })));
    const r = await publishXText(TENANT, "x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

import { publishXThread } from "../publish";

describe("publishXThread", () => {
  it("keeps the published root when a tail request loses its response", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++n === 2) throw new Error("network timeout");
      return { ok: true, status: 201, json: async () => ({ data: { id: "root-id" } }) };
    }));
    const result = await publishXThread(TENANT, "root", ["two", "three"]);
    expect(result).toMatchObject({ ok: true, raw: { id: "root-id", thread_ids: [], thread_error: { index: 0, status: 0 } } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("validates every tail before publishing the root", async () => {
    const result = await publishXThread(TENANT, "root", ["界".repeat(141)]);
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a valid long URL in a tail", async () => {
    const text = "Read more https://example.com/" + "a".repeat(290);
    await publishXThread(TENANT, "root", [text]);
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body)).text).toBe(text);
  });
  it("posts the root, then each part in order as a reply to the previous id", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ data: { id: `id-${++n}` } }),
        text: async () => "",
      })),
    );
    const r = await publishXThread(TENANT, "root", ["two", "three"]);
    expect(r.ok).toBe(true);
    expect(r.raw.id).toBe("id-1");
    expect(r.raw.thread_ids).toEqual(["id-2", "id-3"]);
    const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies).toEqual([
      { text: "root" },
      { text: "two", reply: { in_reply_to_tweet_id: "id-1" } },
      { text: "three", reply: { in_reply_to_tweet_id: "id-2" } },
    ]);
  });

  it("a failed part keeps the root as published and records the partial", async () => {
    let n = 0;
    const noText = async (): Promise<string> => "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return n === 3
          ? { ok: false, status: 403, json: async () => ({ detail: "duplicate content" }), text: noText }
          : { ok: true, status: 201, json: async () => ({ data: { id: `id-${n}` } }), text: noText };
      }),
    );
    const r = await publishXThread(TENANT, "root", ["two", "three"]);
    expect(r.ok).toBe(true);
    expect(r.raw.id).toBe("id-1");
    expect(r.raw.thread_ids).toEqual(["id-2"]);
    expect(r.raw.thread_error).toMatchObject({ index: 1, status: 403 });
  });

  it("a failed root is the vendor failure, no tail is attempted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ detail: "dup" }), text: async () => "" })),
    );
    const r = await publishXThread(TENANT, "root", ["two"]);
    expect(r.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

import { uploadXMedia, publishXMedia } from "../publish";

function mediaFetchMock(opts: { finalizeState?: string; statusStates?: string[]; failStep?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const statuses = [...(opts.statusStates ?? [])];
  const f = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => "" });
    const fail = { ok: false, status: 400, json: async () => ({ title: "Bad" }), text: async () => "" };
    if (u.endsWith("/media/upload/initialize")) return opts.failStep === "initialize" ? fail : ok({ id: "m-1" });
    if (u.includes("/media/upload/m-1/append")) return opts.failStep === "append" ? fail : ok({});
    if (u.endsWith("/media/upload/m-1/finalize"))
      return ok({ id: "m-1", ...(opts.finalizeState ? { processing_info: { state: opts.finalizeState, check_after_secs: 1 } } : {}) });
    if (u.includes("command=STATUS")) return ok({ processing_info: { state: statuses.shift() ?? "succeeded", check_after_secs: 1 } });
    if (u === "https://api.x.com/2/tweets") return { ok: true, status: 201, json: async () => ({ data: { id: "t-9" } }), text: async () => "" };
    if (u.startsWith("https://signed.example/")) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

describe("uploadXMedia", () => {
  it("initializes with type/bytes/category, appends segment 0, finalizes, returns the id", async () => {
    const calls = mediaFetchMock();
    const r = await uploadXMedia("tok", Buffer.from("abc"), "image/jpeg", "tweet_image");
    expect(r).toEqual({ ok: true, media_id: "m-1" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ media_type: "image/jpeg", total_bytes: 3, media_category: "tweet_image" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[1].url).toBe("https://api.x.com/2/media/upload/m-1/append");
    expect((calls[1].init.body as FormData).get("segment_index")).toBe("0");
    expect(calls[2].url).toBe("https://api.x.com/2/media/upload/m-1/finalize");
    expect(calls).toHaveLength(3);
  });

  it("polls STATUS for a processing video until it succeeds", async () => {
    const calls = mediaFetchMock({ finalizeState: "pending", statusStates: ["in_progress", "succeeded"] });
    const r = await uploadXMedia("tok", Buffer.from("v"), "video/mp4", "tweet_video", async () => {});
    expect(r).toEqual({ ok: true, media_id: "m-1" });
    expect(calls.filter((c) => c.url.includes("command=STATUS"))).toHaveLength(2);
  });

  it("a failed transcode is a stable 422 naming the step", async () => {
    mediaFetchMock({ finalizeState: "pending", statusStates: ["failed"] });
    const r = await uploadXMedia("tok", Buffer.from("v"), "video/mp4", "tweet_video", async () => {});
    expect(r).toMatchObject({ ok: false, status: 422, raw: { step: "status" } });
  });

  it("a refused initialize is the vendor failure with the step named", async () => {
    mediaFetchMock({ failStep: "initialize" });
    const r = await uploadXMedia("tok", Buffer.from("v"), "image/png", "tweet_image");
    expect(r).toMatchObject({ ok: false, status: 400, raw: { step: "initialize" } });
  });
});

describe("publishXMedia", () => {
  it.each(["image", "video"] as const)("keeps a long-link %s caption intact", async kind => {
    const text = "Read https://example.com/" + "a".repeat(290);
    const calls = mediaFetchMock();
    await publishXMedia(TENANT, text, "https://signed.example/file." + (kind === "image" ? "png" : "mp4"), kind);
    const post = calls.find(c => c.url === "https://api.x.com/2/tweets")!;
    expect(JSON.parse(String(post.init.body)).text).toBe(text);
  });

  it("refuses an invalid caption before fetching or uploading media", async () => {
    const result = await publishXMedia(TENANT, "界".repeat(141), "https://signed.example/file.png", "image");
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fetches the signed media, uploads it, and posts with media_ids", async () => {
    const calls = mediaFetchMock();
    const r = await publishXMedia(TENANT, "look", "https://signed.example/x.png?token=1", "image");
    expect(r.ok).toBe(true);
    expect(r.raw).toMatchObject({ id: "t-9", media_id: "m-1" });
    const post = calls.find((c) => c.url === "https://api.x.com/2/tweets")!;
    expect(JSON.parse(String(post.init.body))).toEqual({ text: "look", media: { media_ids: ["m-1"] } });
    expect(JSON.parse(String(calls[1].init.body)).media_type).toBe("image/png");
  });

  it("a video uploads as video/mp4 under tweet_video", async () => {
    const calls = mediaFetchMock();
    await publishXMedia(TENANT, "clip", "https://signed.example/v.mp4?token=1", "video");
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ media_type: "video/mp4", media_category: "tweet_video" });
  });

  it("an unreachable media URL is a stable 400, no upload attempted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const r = await publishXMedia(TENANT, "x", "https://signed.example/gone.png", "image");
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("publishXMedia — failures come back as results, never throws", () => {
  it("no X token is a 401 result and nothing is fetched", async () => {
    m.getConnectorToken.mockResolvedValue(null);
    const r = await publishXMedia(TENANT, "x", "https://signed.example/a.png", "image");
    expect(r).toMatchObject({ ok: false, status: 401, raw: { error: "x_social not connected" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a token read that throws is a 502 result and nothing is fetched", async () => {
    m.getConnectorToken.mockRejectedValue(new Error("refresh grant 503"));
    const r = await publishXMedia(TENANT, "x", "https://signed.example/a.png", "image");
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a signed media fetch that times out is a 502 result and X is never called", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    const r = await publishXMedia(TENANT, "x", "https://signed.example/a.mp4", "video");
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a network error during the X upload is a 502 result naming the step and no post is made", async () => {
    const calls = mediaFetchMock();
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("/append")) throw new TypeError("fetch failed");
      return base(url, init);
    });
    const r = await publishXMedia(TENANT, "x", "https://signed.example/a.png", "image");
    expect(r).toMatchObject({ ok: false, status: 502, raw: { step: "upload" } });
    expect(calls.some((c) => c.url === "https://api.x.com/2/tweets")).toBe(false);
  });
});

describe("publishXMedia — stale persisted token on the media upload", () => {
  function staleThenFresh(fresh: string) {
    const calls = mediaFetchMock();
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      if (String(url).endsWith("/media/upload/initialize") && auth !== `Bearer ${fresh}`) {
        calls.push({ url: String(url), init: init ?? {} });
        return { ok: false, status: 401, json: async () => ({ title: "Unauthorized" }), text: async () => "" } as unknown as Response;
      }
      return base(url, init);
    });
    return calls;
  }

  it("a 401 on initialize force-refreshes once and re-uploads with the new token, then posts", async () => {
    m.getConnectorToken.mockResolvedValueOnce("tok_stale").mockResolvedValue("tok_new");
    const calls = staleThenFresh("tok_new");
    const r = await publishXMedia(TENANT, "look", "https://signed.example/x.png", "image");
    expect(r).toMatchObject({ ok: true, raw: { id: "t-9", media_id: "m-1" } });
    expect(m.forceRefreshConnector).toHaveBeenCalledTimes(1);
    expect(m.forceRefreshConnector).toHaveBeenCalledWith(TENANT, "x_social");
    const inits = calls.filter((c) => c.url.endsWith("/media/upload/initialize"));
    expect(inits.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(["Bearer tok_stale", "Bearer tok_new"]);
    expect(calls.filter((c) => c.url === "https://api.x.com/2/tweets")).toHaveLength(1);
  });

  it("does not loop when the refresh yields the same token: one refresh, one upload attempt, the 401 stands", async () => {
    m.getConnectorToken.mockResolvedValue("tok_stale");
    const calls = staleThenFresh("tok_never");
    const r = await publishXMedia(TENANT, "look", "https://signed.example/x.png", "image");
    expect(r).toMatchObject({ ok: false, status: 401, raw: { step: "initialize" } });
    expect(m.forceRefreshConnector).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url.endsWith("/media/upload/initialize"))).toHaveLength(1);
    expect(calls.some((c) => c.url === "https://api.x.com/2/tweets")).toBe(false);
  });
});
