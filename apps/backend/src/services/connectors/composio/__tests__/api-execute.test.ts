import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../api-key", () => ({ getComposioApiKey: () => "k" }));
vi.mock("@/services/mcp/streamable-guards", () => ({ assertStreamableUrlAllowed: vi.fn() }));
import { composioExecuteTool, composioProxy } from "../api";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });

describe("composioExecuteTool", () => {
  it("POSTs v3.1 execute with user_id + connected_account_id + arguments verbatim", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ successful: true, data: { id: "re_1" }, error: null }), { status: 200 }));
    const args = { charge: "ch_1", amount: 500, metadata: { a: [1, 2] } };
    const r = await composioExecuteTool({ tool_slug: "STRIPE_CREATE_REFUND", user_id: "T1", connected_account_id: "ca_1", arguments: args });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3.1/tools/execute/STRIPE_CREATE_REFUND");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body)).toEqual({ user_id: "T1", connected_account_id: "ca_1", arguments: args });
    expect(r).toEqual({ ok: true, status: 200, data: { id: "re_1" }, error: null, outcome_unknown: false });
  });
  it("successful:true wrapping the vendor's own refusal is a definite refusal, not Done", async () => {
    const body = { successful: true, error: null, data: { data: { error: "Your plan does not allow API calls. Upgrade at mixpanel.com/pricing", request: "/api/query/events/names?project_id=1" } } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await composioExecuteTool({ tool_slug: "MIXPANEL_TOP_EVENTS", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, error: "Your plan does not allow API calls. Upgrade at mixpanel.com/pricing", outcome_unknown: false });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ successful: true, error: null, data: { id: "i1", error: "none", title: "t" } }), { status: 200 }));
    expect((await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} })).ok).toBe(true);
  });
  it("maps successful:false to ok:false without throwing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ successful: false, data: null, error: "bad" }), { status: 200 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("bad");
    expect(r.outcome_unknown).toBe(false);
  });
  it("HTTP 4xx with an error body is a definite refusal", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad args" } }), { status: 400 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, status: 400, outcome_unknown: false });
  });
  it("HTTP 200 whose body is not JSON is an UNKNOWN outcome (the write may have run)", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, status: 200, outcome_unknown: true });
  });
  it("HTTP 200 with no boolean `successful` is an UNKNOWN outcome", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "x" } }), { status: 200 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
  });
  it("HTTP 200 successful:false with NO error body is an UNKNOWN outcome", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ successful: false, data: null, error: null }), { status: 200 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
  });
  it("a 5xx with an unparseable body (gateway timeout) is an UNKNOWN outcome", async () => {
    fetchMock.mockResolvedValue(new Response("Gateway Timeout", { status: 504 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, status: 504, outcome_unknown: true });
  });
  it("a 5xx with a JSON error body is still an UNKNOWN outcome (the write may have run)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "internal" } }), { status: 500 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, status: 500, outcome_unknown: true });
  });
  it("a 5xx with an empty JSON object is an UNKNOWN outcome", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 502 }));
    const r = await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(r).toMatchObject({ ok: false, status: 502, outcome_unknown: true });
  });
});

describe("composioProxy", () => {
  it("sends extra headers as header parameters and returns the Location header", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 200, data: {}, headers: { Location: "https://www.googleapis.com/upload/x?upload_id=U" } }), { status: 200 }));
    const r = await composioProxy({ account: { tenant_id: "T1", toolkit: "youtube", connected_account_id: "ca" } as any, method: "POST", endpoint: "https://www.googleapis.com/upload/youtube/v3/videos", body: { a: 1 }, headers: { "X-Upload-Content-Type": "video/mp4" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).parameters).toEqual([{ name: "X-Upload-Content-Type", value: "video/mp4", type: "header" }]);
    expect(r.location).toBe("https://www.googleapis.com/upload/x?upload_id=U");
  });
  it("sends endpoint/method/connected_account_id and returns upstream status", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 201, data: { id: "c1" } }), { status: 200 }));
    const r = await composioProxy({ account: { tenant_id: "T1", toolkit: "instagram", connected_account_id: "ca" } as any, method: "POST", endpoint: "https://graph.instagram.com/v22.0/1/media?caption=x" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      connected_account_id: "ca", method: "POST", endpoint: "https://graph.instagram.com/v22.0/1/media?caption=x",
    });
    expect(r).toEqual({ ok: true, status: 201, json: { id: "c1" } });
  });
  it("vendor error envelope {error:{message,status}} → ok:false with that status and message (docs.composio.dev proxy schema, checked 2026-09-25)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad token", status: 401 } }), { status: 401 }));
    const r = await composioProxy({ account: { tenant_id: "T1", toolkit: "instagram", connected_account_id: "ca" } as any, method: "GET", endpoint: "https://graph.instagram.com/v22.0/me" });
    expect(r).toEqual({ ok: false, status: 401, json: { error: { message: "bad token", status: 401 } } });
  });
});

describe("transport failures never throw (the social worker must finalize, not retry blindly)", () => {
  it("fetch rejects → execute returns ok:false status 0; proxy returns ok:false status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} }))
      .toEqual({ ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true });
    expect(await composioProxy({ account: { tenant_id: "T1", toolkit: "instagram", connected_account_id: "ca" } as any, method: "GET", endpoint: "https://graph.instagram.com/v22.0/me" }))
      .toEqual({ ok: false, status: 0, json: { error: "composio_transport_error" } });
  });
});

describe("composioProxy endpoint allowlist", () => {
  const acct = (toolkit: string) => ({ tenant_id: "T1", toolkit, connected_account_id: "ca" }) as any;
  it("refuses a foreign or non-HTTPS host without calling Composio", async () => {
    for (const endpoint of ["https://evil.example/steal", "http://graph.instagram.com/me", "//evil.example/x", "https://www.googleapis.com/x"]) {
      const r = await composioProxy({ account: acct("instagram"), method: "GET", endpoint });
      expect(r).toEqual({ ok: false, status: 0, json: { error: "composio_proxy_endpoint_not_allowed" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("allows the toolkit's own hosts and relative paths", async () => {
    const { isProxyEndpointAllowed } = await import("../api");
    expect(isProxyEndpointAllowed("youtube", "https://www.googleapis.com/upload/youtube/v3/videos")).toBe(true);
    expect(isProxyEndpointAllowed("instagram", "https://graph.facebook.com/v22.0/1/media")).toBe(true);
    expect(isProxyEndpointAllowed("instagram", "/me")).toBe(true);
    expect(isProxyEndpointAllowed("google_analytics", "https://analyticsdata.googleapis.com/v1beta/properties/1:runReport")).toBe(true);
    expect(isProxyEndpointAllowed("google_analytics", "https://analyticsadmin.googleapis.com/v1beta/accountSummaries")).toBe(true);
    expect(isProxyEndpointAllowed("google_search_console", "https://searchconsole.googleapis.com/webmasters/v3/sites")).toBe(true);
    expect(isProxyEndpointAllowed("google_search_console", "https://www.googleapis.com/webmasters/v3/sites")).toBe(true);
    expect(isProxyEndpointAllowed("google_analytics", "https://searchconsole.googleapis.com/x")).toBe(false);
  });
});

describe("composioProxy: Reddit Ads host, PATCH, timeout signal and rate-limit headers", () => {
  const acct = (toolkit: string) => ({ tenant_id: "T1", toolkit, connected_account_id: "ca" }) as any;
  it("allows only plain HTTPS ads-api.reddit.com endpoints for the reddit_ads toolkit", async () => {
    const { isProxyEndpointAllowed } = await import("../api");
    expect(isProxyEndpointAllowed("reddit_ads", "https://ads-api.reddit.com/api/v3/me")).toBe(true);
    expect(isProxyEndpointAllowed("reddit_ads", "/api/v3/me")).toBe(true);
    for (const bad of [
      "http://ads-api.reddit.com/api/v3/me",
      "https://oauth.reddit.com/api/v1/me",
      "https://user:pw@ads-api.reddit.com/api/v3/me",
      "https://ads-api.reddit.com:8443/api/v3/me",
      "https://ads-api.reddit.com/api/v3/me#frag",
      "https://graph.instagram.com/v22.0/me",
    ]) expect(isProxyEndpointAllowed("reddit_ads", bad), bad).toBe(false);
    expect(isProxyEndpointAllowed("instagram", "https://ads-api.reddit.com/api/v3/me")).toBe(false);
    expect(isProxyEndpointAllowed("instagram", "https://graph.instagram.com:444/v22.0/me")).toBe(false);
  });
  it("sends PATCH with the body and forwards the caller's abort signal; other consumers send none", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "g1" }, status: 200 }), { status: 200 }));
    const signal = AbortSignal.timeout(5000);
    const r = await composioProxy({ account: acct("reddit_ads"), method: "PATCH", endpoint: "https://ads-api.reddit.com/api/v3/ad_groups/g1", body: { data: { goal_value: 1 } } }, signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3.1/tools/execute/proxy");
    expect(JSON.parse(init.body)).toEqual({ connected_account_id: "ca", method: "PATCH", endpoint: "https://ads-api.reddit.com/api/v3/ad_groups/g1", body: { data: { goal_value: 1 } } });
    expect(init.signal).toBe(signal);
    expect(r).toEqual({ ok: true, status: 200, json: { id: "g1" } });
    fetchMock.mockClear();
    await composioProxy({ account: acct("instagram"), method: "GET", endpoint: "https://graph.instagram.com/v22.0/me" });
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
    await composioExecuteTool({ tool_slug: "X_Y", user_id: "T1", connected_account_id: "ca", arguments: {} });
    expect(fetchMock.mock.calls[1][1].signal).toBeUndefined();
  });
  it("keeps only the vendor's rate-limit headers, lower-cased, on both success and error replies", async () => {
    const headers = { "Retry-After": "7", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700000000", "X-RateLimit-Used": "600", "Set-Cookie": "session=secret", "x-ratelimit-reset": 42 };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "slow down", status: 429 }, headers }), { status: 200 }));
    const r = await composioProxy({ account: acct("reddit_ads"), method: "GET", endpoint: "https://ads-api.reddit.com/api/v3/me" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.rate_limit).toEqual({ "retry-after": "7", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000", "x-ratelimit-used": "600" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "me" }, status: 200, headers: { "X-RateLimit-Remaining": "599", "Authorization": "Bearer leaked" } }), { status: 200 }));
    expect(await composioProxy({ account: acct("reddit_ads"), method: "GET", endpoint: "https://ads-api.reddit.com/api/v3/me" })).toEqual({ ok: true, status: 200, json: { id: "me" }, rate_limit: { "x-ratelimit-remaining": "599" } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "me" }, status: 200 }), { status: 200 }));
    expect(await composioProxy({ account: acct("instagram"), method: "GET", endpoint: "https://graph.instagram.com/v22.0/me" })).toEqual({ ok: true, status: 200, json: { id: "me" } });
  });
});
