
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redditSocialAuthorizeUrl, redditSocialExchangeCode } from "../oauth";

const ENV = ["REDDIT_SOCIAL_CLIENT_ID", "REDDIT_SOCIAL_CLIENT_SECRET"] as const;
const prev: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) prev[k] = process.env[k];
  process.env.REDDIT_SOCIAL_CLIENT_ID = "rid";
  process.env.REDDIT_SOCIAL_CLIENT_SECRET = "rsecret";
});
afterEach(() => {
  for (const k of ENV) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.unstubAllGlobals();
});

describe("redditSocialAuthorizeUrl", () => {
  it("requests a PERMANENT grant with identity + submit and echoes state/redirect", () => {
    const u = new URL(redditSocialAuthorizeUrl("st-1", "http://localhost:3001/api/connectors/reddit_social/callback"));
    expect(u.origin + u.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(u.searchParams.get("client_id")).toBe("rid");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("duration")).toBe("permanent");
    expect(u.searchParams.get("scope")).toBe("identity submit");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/connectors/reddit_social/callback");
  });
});

describe("redditSocialExchangeCode", () => {
  function stub(tokenJson: Record<string, unknown>, me = { id: "abc12", name: "DeveloperZavi" }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/api/v1/access_token")) {
          return { ok: true, status: 200, text: async () => JSON.stringify(tokenJson) };
        }
        if (String(url).includes("/api/v1/me")) return { ok: true, status: 200, json: async () => me };
        throw new Error(`unexpected ${url}`);
      }),
    );
    return calls;
  }

  it("uses HTTP Basic (client_id:secret), a real User-Agent, and stores token + refresh + username", async () => {
    const calls = stub({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "identity submit" });
    const r = await redditSocialExchangeCode("code-1", "http://localhost:3001/cb");

    const tokenCall = calls.find((c) => c.url.includes("access_token"))!;
    const h = tokenCall.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from("rid:rsecret").toString("base64")}`);
    expect(h["User-Agent"]).toMatch(/^web:com\.zaviagent\.social:v[\d.]+ \(by \/u\/\w+\)$/);
    const form = new URLSearchParams(String(tokenCall.init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe("http://localhost:3001/cb");

    expect(r.secrets["reddit_social.access_token"]).toBe("at");
    expect(r.secrets["reddit_social.refresh_token"]).toBe("rt");
    expect(r.secrets["reddit_social.username"]).toBe("DeveloperZavi");
    expect(r.metadata.team_name).toBe("u/DeveloperZavi");
    expect(r.metadata.scopes).toEqual(["identity", "submit"]);
    expect(r.expiresInSec).toBe(3600);
  });

  it("api/v1/me is called against oauth.reddit.com with the bearer + User-Agent", async () => {
    const calls = stub({ access_token: "at", refresh_token: "rt" });
    await redditSocialExchangeCode("c", "http://x/cb");
    const me = calls.find((c) => c.url.includes("/api/v1/me"))!;
    expect(me.url.startsWith("https://oauth.reddit.com/")).toBe(true);
    const h = me.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer at");
    expect(h["User-Agent"]).toMatch(/by \/u\//);
  });

  it("refuses when Reddit omits the refresh_token (duration=permanent not honoured)", async () => {
    stub({ access_token: "at" });
    await expect(redditSocialExchangeCode("c", "http://x/cb")).rejects.toThrow(/refresh_token/);
  });

  it("surfaces Reddit's 200-with-error shape (invalid_grant) as a failure", async () => {
    stub({ error: "invalid_grant" });
    await expect(redditSocialExchangeCode("c", "http://x/cb")).rejects.toThrow(/invalid_grant/);
  });
});
