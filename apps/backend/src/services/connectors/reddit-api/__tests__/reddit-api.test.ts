import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const OLD_ENV = { ...process.env };
const UA = "web:com.zaviagent.data:v1.0 (by /u/ZaviTest)";

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

const tokenOk = () => jsonResponse({ access_token: "app-tok", expires_in: 3600 });

async function load() {
  const client = await import("../client");
  const endpoints = await import("../endpoints");
  client.resetRedditRateLimitStateForTests();
  return { client, endpoints };
}

beforeEach(() => {
  vi.resetModules();
  process.env.REDDIT_API_CLIENT_ID = "cid";
  process.env.REDDIT_API_CLIENT_SECRET = "csec";
  process.env.REDDIT_API_USER_AGENT = UA;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("refuses to send traffic without a descriptive User-Agent", async () => {
    process.env.REDDIT_API_USER_AGENT = "node-fetch";
    const { redditApiUserAgent } = await import("../constants");
    expect(() => redditApiUserAgent()).toThrow(/REDDIT_API_USER_AGENT/);
  });

  it("refuses to run without app credentials", async () => {
    delete process.env.REDDIT_API_CLIENT_SECRET;
    const { redditApiCreds } = await import("../constants");
    expect(() => redditApiCreds()).toThrow(/REDDIT_API_CLIENT_ID/);
  });
});

describe("redditApiGet", () => {
  it("uses client_credentials once, then reuses the token with the UA on oauth.reddit.com", async () => {
    const calls = mockFetch((url) =>
      url.includes("access_token") ? tokenOk() : jsonResponse({ data: { display_name: "smallbusiness" } }),
    );
    const { client } = await load();
    await client.redditApiGet("/r/smallbusiness/about");
    await client.redditApiGet("/r/smallbusiness/about");

    const tokenCalls = calls.filter((c) => c.url.includes("access_token"));
    expect(tokenCalls).toHaveLength(1);
    expect(String(tokenCalls[0].init.body)).toBe("grant_type=client_credentials");

    const apiCalls = calls.filter((c) => !c.url.includes("access_token"));
    expect(apiCalls).toHaveLength(2);
    const u = new URL(apiCalls[0].url);
    expect(u.host).toBe("oauth.reddit.com");
    expect(u.searchParams.get("raw_json")).toBe("1");
    const headers = apiCalls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(UA);
    expect(headers.Authorization).toBe("Bearer app-tok");
  });

  it("rejects paths that could send the bearer token off-host", async () => {
    mockFetch(() => tokenOk());
    const { client } = await load();
    await expect(client.redditApiGet("https://evil.example/x")).rejects.toThrow(/invalid path/);
    await expect(client.redditApiGet("//evil.example/x")).rejects.toThrow(/invalid path/);
  });

  it("records rate-limit headers", async () => {
    mockFetch((url) =>
      url.includes("access_token")
        ? tokenOk()
        : jsonResponse({}, {
            headers: { "x-ratelimit-used": "12", "x-ratelimit-remaining": "88", "x-ratelimit-reset": "300" },
          }),
    );
    const { client } = await load();
    await client.redditApiGet("/r/test/about", {}, { now: () => 1_000 });
    expect(client.getRedditRateLimitState()).toEqual({
      used: 12,
      remaining: 88,
      resetAt: 301_000,
      observedAt: 1_000,
    });
  });

  it("refuses to wait more than a minute for a spent window", async () => {
    mockFetch((url) =>
      url.includes("access_token")
        ? tokenOk()
        : jsonResponse({}, {
            headers: { "x-ratelimit-used": "100", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "500" },
          }),
    );
    const { client } = await load();
    await client.redditApiGet("/r/test/about", {}, { now: () => 0 });
    await expect(client.redditApiGet("/r/test/about", {}, { now: () => 0 })).rejects.toMatchObject({
      code: "reddit_api_rate_limited",
    });
  });

  it("refreshes the token once on 401", async () => {
    let tokens = 0;
    let api = 0;
    mockFetch((url) => {
      if (url.includes("access_token")) {
        tokens++;
        return jsonResponse({ access_token: `tok-${tokens}`, expires_in: 3600 });
      }
      api++;
      return api === 1 ? jsonResponse({}, { status: 401 }) : jsonResponse({ ok: true });
    });
    const { client } = await load();
    await expect(client.redditApiGet("/r/test/about")).resolves.toEqual({ ok: true });
    expect(tokens).toBe(2);
  });

  it("maps 403/404 to a not-available state instead of a crash", async () => {
    mockFetch((url) => (url.includes("access_token") ? tokenOk() : jsonResponse({}, { status: 403 })));
    const { client } = await load();
    await expect(client.redditApiGet("/r/private/about")).rejects.toMatchObject({
      code: "reddit_api_not_available",
    });
  });
});

describe("endpoints", () => {
  it("validates names and ids before they reach a URL path", async () => {
    mockFetch(() => tokenOk());
    const { endpoints } = await load();
    await expect(endpoints.subredditAbout("../api/v1/me")).rejects.toThrow(/Invalid subreddit/);
    await expect(endpoints.thread("abc/../../x")).rejects.toThrow(/Invalid post id/);
    await expect(endpoints.info(["t3_ok", "bad id"])).rejects.toThrow(/Invalid fullname/);
    await expect(endpoints.info(Array.from({ length: 101 }, (_, i) => `t3_${i}`))).rejects.toThrow(/at most 100/);
  });

  it("accepts r/ prefixes and parses rules", async () => {
    const calls = mockFetch((url) =>
      url.includes("access_token")
        ? tokenOk()
        : jsonResponse({ rules: [{ short_name: "No self-promotion", description: "Ban.", kind: "all" }] }),
    );
    const { endpoints } = await load();
    const rules = await endpoints.subredditRules("r/smallbusiness");
    expect(rules[0].short_name).toBe("No self-promotion");
    expect(calls.at(-1)!.url).toContain("/r/smallbusiness/about/rules");
  });

  it("restricts subreddit search to that subreddit and keeps only well-formed posts", async () => {
    const calls = mockFetch((url) =>
      url.includes("access_token")
        ? tokenOk()
        : jsonResponse({
            data: {
              after: "t3_next",
              children: [
                {
                  kind: "t3",
                  data: {
                    name: "t3_abc", id: "abc", subreddit: "smallbusiness", title: "Best way to rent out my car",
                    permalink: "/r/smallbusiness/comments/abc/x/", created_utc: 1, locked: false, archived: false,
                  },
                },
                { kind: "t3", data: { id: "broken" } },
              ],
            },
          }),
    );
    const { endpoints } = await load();
    const res = await endpoints.searchPosts({ q: "rent out my car", subreddit: "smallbusiness" });
    expect(res.after).toBe("t3_next");
    expect(res.items.map((p) => p.id)).toEqual(["abc"]);
    const u = new URL(calls.at(-1)!.url);
    expect(u.pathname).toBe("/r/smallbusiness/search");
    expect(u.searchParams.get("restrict_sr")).toBe("1");
    expect(u.searchParams.get("type")).toBe("link");
  });
});
