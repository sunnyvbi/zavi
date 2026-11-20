
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ getConnectorToken: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: m.getConnectorToken }));

import { publishRedditSelfPost, isRedditSocialConnected, redditParentFullname } from "../publish";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function stubSubmit(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
    }),
  );
  return calls;
}
beforeEach(() => {
  m.getConnectorToken.mockReset().mockResolvedValue("tok_r");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishRedditSelfPost", () => {
  it("posts form-encoded to oauth.reddit.com/api/submit with the Pipedream-equivalent params, kind pinned to self", async () => {
    const calls = stubSubmit({ json: { errors: [], data: { id: "1abc2", name: "t3_1abc2", url: "https://www.reddit.com/r/SaaS/comments/1abc2/t/" } } });
    const r = await publishRedditSelfPost(TENANT, "SaaS", "How we cut churn", "body text");

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.raw.id).toBe("1abc2");
    expect(r.raw.name).toBe("t3_1abc2");
    expect(r.raw.url).toBe("https://www.reddit.com/r/SaaS/comments/1abc2/t/");

    const [{ url, init }] = calls;
    expect(url).toBe("https://oauth.reddit.com/api/submit");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok_r");
    expect(h["User-Agent"]).toMatch(/by \/u\//);
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("api_type")).toBe("json");
    expect(form.get("sr")).toBe("SaaS");
    expect(form.get("kind")).toBe("self");
    expect(form.get("title")).toBe("How we cut churn");
    expect(form.get("text")).toBe("body text");
    expect(form.get("sendreplies")).toBe("true");
    expect(form.has("url")).toBe(false);
  });

  it("refreshes via getConnectorToken with the connector's slug + key", async () => {
    stubSubmit({ json: { errors: [], data: {} } });
    await publishRedditSelfPost(TENANT, "SaaS", "t", "b");
    expect(m.getConnectorToken).toHaveBeenCalledWith(TENANT, "reddit_social", "reddit_social.access_token");
  });

  it("a REJECTED submit is HTTP 200 + errors[] → ok:false with a 4xx so the worker records vendor_rejected", async () => {
    stubSubmit({ json: { errors: [["SUBREDDIT_NOEXIST", "that subreddit doesn't exist", "sr"]], data: {} } });
    const r = await publishRedditSelfPost(TENANT, "nope_nope_nope", "t", "b");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(String(r.raw.error)).toMatch(/SUBREDDIT_NOEXIST/);
  });

  it("caps the title at Reddit's 300 chars", async () => {
    const calls = stubSubmit({ json: { errors: [], data: {} } });
    await publishRedditSelfPost(TENANT, "SaaS", "a".repeat(400), "b");
    expect(new URLSearchParams(String(calls[0].init.body)).get("title")).toHaveLength(300);
  });

  it("passes a real HTTP failure through with its status", async () => {
    const r = await (async () => { stubSubmit({ message: "Too Many Requests" }, 429); return publishRedditSelfPost(TENANT, "SaaS", "t", "b"); })();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
  });

  it("throws when not connected — the resolver should have refused earlier", async () => {
    m.getConnectorToken.mockResolvedValue(null);
    await expect(publishRedditSelfPost(TENANT, "SaaS", "t", "b")).rejects.toThrow(/not connected/);
  });
});

describe("isRedditSocialConnected", () => {
  it("true when a token resolves; false on null or a throwing refresh", async () => {
    expect(await isRedditSocialConnected(TENANT)).toBe(true);
    m.getConnectorToken.mockResolvedValue(null);
    expect(await isRedditSocialConnected(TENANT)).toBe(false);
    m.getConnectorToken.mockRejectedValue(new Error("refresh failed"));
    expect(await isRedditSocialConnected(TENANT)).toBe(false);
  });
});

describe("redditParentFullname", () => {
  it("passes a fullname through, lowercased", () => {
    expect(redditParentFullname("T3_ABC123")).toBe("t3_abc123");
    expect(redditParentFullname("t1_def456")).toBe("t1_def456");
  });

  it("reads a thread permalink as the POST", () => {
    expect(
      redditParentFullname("https://www.reddit.com/r/turo/comments/abc123/some_title_slug/"),
    ).toBe("t3_abc123");
  });

  it("reads a comment permalink as the COMMENT", () => {
    expect(
      redditParentFullname("https://www.reddit.com/r/turo/comments/abc123/some_title_slug/def456/"),
    ).toBe("t1_def456");
  });

  it("accepts an old.reddit.com host", () => {
    expect(redditParentFullname("https://old.reddit.com/r/turo/comments/abc123/t/")).toBe("t3_abc123");
  });

  it("refuses a non-Reddit host", () => {
    expect(() => redditParentFullname("https://example.com/r/turo/comments/abc123/t/")).toThrow(
      /must be on reddit\.com/,
    );
  });

  it("refuses a Reddit URL that names no post", () => {
    expect(() => redditParentFullname("https://www.reddit.com/r/turo/")).toThrow(/no post id/);
  });

  it("refuses a fullname of the wrong kind", () => {
    expect(() => redditParentFullname("t5_abc")).toThrow(/fullname or a permalink/);
  });
});
