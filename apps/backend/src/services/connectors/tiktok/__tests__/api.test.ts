import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeTikTokCode,
  publishTikTokVideo,
  queryAccountStats,
  TIKTOK_PRIVATE_ONLY_MESSAGE,
  tiktokAuthorizeUrl,
  tiktokConfig,
} from "../api";

vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => "token") }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantStorage: vi.fn(),
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { token_expires_at: new Date(Date.now() + 3_600_000).toISOString() } }),
        }),
      }),
    }),
  }),
}));

const old = { ...process.env };
afterEach(() => { process.env = { ...old }; vi.unstubAllGlobals(); });

describe("TikTok OAuth", () => {
  it("requests the complete organic scope set and a fixed callback", () => {
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "secret";
    process.env.BACKEND_PUBLIC_URL = "https://api.example.com/";
    const url = new URL(tiktokAuthorizeUrl("csrf-state"));
    expect(url.origin).toBe("https://www.tiktok.com");
    expect(url.searchParams.get("state")).toBe("csrf-state");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/api/connectors/tiktok/callback");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "user.info.basic", "user.info.stats", "video.list", "video.upload", "video.publish",
    ]);
  });

  it("fails closed when server credentials are missing", () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    delete process.env.BACKEND_PUBLIC_URL;
    expect(() => tiktokConfig()).toThrow(/tiktok_misconfigured/);
  });

  it("never reads the Sandbox_ names, so a missing real pair fails closed", () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.example.com";
    process.env.Sandbox_TIKTOK_CLIENT_KEY = "sandbox-key";
    process.env.Sandbox_TIKTOK_CLIENT_SECRET = "sandbox-secret";
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    try {
      expect(() => tiktokConfig()).toThrow(/tiktok_misconfigured/);
      process.env.TIKTOK_CLIENT_KEY = "real-key";
      expect(() => tiktokConfig()).toThrow(/tiktok_misconfigured/);
      process.env.TIKTOK_CLIENT_SECRET = "real-secret";
      expect(tiktokConfig()).toMatchObject({ client_key: "real-key", client_secret: "real-secret" });
    } finally {
      delete process.env.Sandbox_TIKTOK_CLIENT_KEY;
      delete process.env.Sandbox_TIKTOK_CLIENT_SECRET;
    }
  });

  it("treats a 200 with an error body as a failed exchange, not as tokens", async () => {
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "secret";
    process.env.BACKEND_PUBLIC_URL = "https://api.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Authorization code is expired.", log_id: "x" }),
      { status: 200 },
    )));
    await expect(exchangeTikTokCode("code")).rejects.toThrow(/invalid_grant: Authorization code is expired/);
  });

  it("returns the token bundle and defaults a missing scope", async () => {
    process.env.TIKTOK_CLIENT_KEY = "client-key";
    process.env.TIKTOK_CLIENT_SECRET = "secret";
    process.env.BACKEND_PUBLIC_URL = "https://api.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ access_token: "a", refresh_token: "r", open_id: "o", expires_in: 86400 }),
      { status: 200 },
    )));
    await expect(exchangeTikTokCode("code")).resolves.toMatchObject({
      access_token: "a", refresh_token: "r", open_id: "o", expires_in: 86400, scope: "",
    });
  });
});

describe("TikTok account stats", () => {
  it("GETs /v2/user/info/ for the three counts with the bearer and no body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { user: { display_name: "Upcar", follower_count: 4568, likes_count: 7637, video_count: 75 } },
      error: { code: "ok", message: "" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryAccountStats("tenant-a")).resolves.toMatchObject({
      display_name: "Upcar", follower_count: 4568, likes_count: 7637, video_count: 75,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/user/info/?fields=display_name,avatar_url,follower_count,likes_count,video_count");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
  });

  it("reports a count TikTok omitted as null, never 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { user: { display_name: "Upcar", follower_count: 12 } },
      error: { code: "ok" },
    }), { status: 200 })));
    await expect(queryAccountStats("tenant-a")).resolves.toMatchObject({
      follower_count: 12, likes_count: null, video_count: null,
    });
  });

  it("turns a grant without user.info.stats into a reconnect instruction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: {},
      error: { code: "scope_not_authorized", message: "The user did not authorize the scope required for completing this request." },
    }), { status: 401 })));
    await expect(queryAccountStats("tenant-a")).rejects.toMatchObject({ code: "tiktok_scope_missing" });
  });
});

describe("publishTikTokVideo", () => {
  const SIGNED = "https://storage.example.com/signed/video.mp4";
  const UPLOAD = "https://upload.tiktok.example/put";
  const ok = (data: unknown) => new Response(JSON.stringify({ data, error: { code: "ok" } }), { status: 200 });
  const vendorError = (status: number, code: string) =>
    new Response(JSON.stringify({ data: {}, error: { code, message: code } }), { status });

  function vendor(over: {
    creator?: () => Response | Promise<Response>;
    init?: () => Response;
    put?: () => Response;
    statuses?: Array<Record<string, unknown> | string | Error>;
  } = {}) {
    const statuses = [...(over.statuses ?? [{ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7300000000000000001] }])];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/v2/post/publish/creator_info/query/")) {
        return over.creator ? over.creator() : ok({ creator_username: "upcar", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"] });
      }
      if (url === SIGNED) return new Response(new Uint8Array(16), { status: 200 });
      if (url.endsWith("/v2/post/publish/video/init/")) return over.init ? over.init() : ok({ publish_id: "v_pub_1", upload_url: UPLOAD });
      if (url === UPLOAD) return over.put ? over.put() : new Response("", { status: 201 });
      if (url.endsWith("/v2/post/publish/status/fetch/")) {
        const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
        if (next instanceof Error) throw next;
        if (typeof next === "string") return new Response(next, { status: 200 });
        return ok(next);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const statusCalls = () => calls.filter((u) => u.endsWith("/v2/post/publish/status/fetch/")).length;
    return { calls, statusCalls };
  }

  const publish = (opts: { pollAttempts?: number } = {}) =>
    publishTikTokVideo("tenant-a", { caption: "hi", privacy: "SELF_ONLY" }, SIGNED, { pollDelayMs: 0, ...opts });

  it("waits for PUBLISH_COMPLETE before calling the post published, and returns the public post id", async () => {
    const v = vendor({
      statuses: [
        { status: "PROCESSING_UPLOAD" },
        { status: "PROCESSING_DOWNLOAD" },
        '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}',
      ],
    });
    const r = await publish();
    expect(r).toEqual({
      ok: true,
      status: 200,
      raw: { publish_id: "v_pub_1", status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["7300000000000000001"], creator_username: "upcar" },
    });
    expect(v.statusCalls()).toBe(3);
  });

  it("reports a FAILED publish as a stable 4xx carrying TikTok's fail_reason, never as published", async () => {
    vendor({ statuses: [{ status: "PROCESSING_UPLOAD" }, { status: "FAILED", fail_reason: "file_format_check_failed" }] });
    const r = await publish();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.raw).toMatchObject({ publish_id: "v_pub_1", error: "tiktok_publish_failed", fail_reason: "file_format_check_failed" });
  });

  it("keeps polling through a status read that times out, and stops at the bound without claiming success", async () => {
    const v = vendor({ statuses: [new TypeError("fetch failed"), { status: "PROCESSING_UPLOAD" }] });
    const r = await publish({ pollAttempts: 4 });
    expect(v.statusCalls()).toBe(4);
    expect(r).toEqual({ ok: false, status: 503, raw: { publish_id: "v_pub_1", status: "PROCESSING_UPLOAD", error: "tiktok publish not confirmed" } });
  });

  it("reports a status read the vendor refuses after the upload as unconfirmed, never as a stable rejection", async () => {
    const statusRead = vi.fn(() => vendorError(401, "access_token_invalid"));
    const v = vendor();
    const inner = globalThis.fetch as unknown as (u: string) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/v2/post/publish/status/fetch/") ? statusRead() : inner(url))));
    const r = await publish({ pollAttempts: 3 });
    expect(v.calls.filter((u) => u === UPLOAD)).toHaveLength(1);
    expect(statusRead).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      ok: false,
      status: 503,
      raw: { publish_id: "v_pub_1", status: null, error: "tiktok publish not confirmed", cause: "tiktok_token_expired" },
    });
  });

  it("returns an expired token at creator_info as a 400, not a throw", async () => {
    const v = vendor({ creator: () => vendorError(401, "access_token_invalid") });
    const r = await publish();
    expect(r).toMatchObject({ ok: false, status: 400, raw: { error: "tiktok_token_expired" } });
    expect(v.calls.some((u) => u.endsWith("/video/init/"))).toBe(false);
  });

  it("returns a missing scope at creator_info as a 400", async () => {
    vendor({ creator: () => vendorError(401, "scope_not_authorized") });
    await expect(publish()).resolves.toMatchObject({ ok: false, status: 400, raw: { error: "tiktok_scope_missing" } });
  });

  it("returns a network failure at creator_info as a 5xx so it reads as unconfirmed", async () => {
    vendor({ creator: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(publish()).resolves.toMatchObject({ ok: false, status: 502, raw: { error: "tiktok_timeout" } });
  });

  it("returns an init without an upload URL as a 400 and a vendor 5xx at init as a 502", async () => {
    vendor({ init: () => ok({ publish_id: "v_pub_1" }) });
    await expect(publish()).resolves.toMatchObject({ ok: false, status: 400, raw: { error: "tiktok_upload_init_failed" } });
    vendor({ init: () => vendorError(503, "internal_error") });
    await expect(publish()).resolves.toMatchObject({ ok: false, status: 502, raw: { error: "tiktok_api_failed" } });
  });

  it("returns a byte upload the vendor refuses with a 4xx as a 400 and a 5xx as a 502", async () => {
    vendor({ put: () => new Response("bad range", { status: 416 }) });
    await expect(publish()).resolves.toMatchObject({ ok: false, status: 400, raw: { error: "tiktok_upload_failed" } });
    vendor({ put: () => new Response("oops", { status: 500 }) });
    await expect(publish()).resolves.toMatchObject({ ok: false, status: 502, raw: { error: "tiktok_upload_failed" } });
  });

  it("tells the founder to set the account private when the unaudited app is refused at init", async () => {
    vendor({ init: () => vendorError(403, "unaudited_client_can_only_post_to_private_accounts") });
    const r = await publish();
    expect(r).toEqual({
      ok: false,
      status: 400,
      raw: {
        code: "unaudited_client_can_only_post_to_private_accounts",
        error: "unaudited_client_can_only_post_to_private_accounts",
        message: TIKTOK_PRIVATE_ONLY_MESSAGE,
      },
    });
    expect(TIKTOK_PRIVATE_ONLY_MESSAGE).toBe("Set your TikTok account to private until Zavi's TikTok review clears, then post again");
  });

  it("tells the founder to set the account private when the publish fails for that reason after upload", async () => {
    vendor({ statuses: [{ status: "FAILED", fail_reason: "unaudited_client_can_only_post_to_private_accounts" }] });
    await expect(publish()).resolves.toMatchObject({
      ok: false,
      status: 400,
      raw: { code: "unaudited_client_can_only_post_to_private_accounts", message: TIKTOK_PRIVATE_ONLY_MESSAGE },
    });
  });
});
