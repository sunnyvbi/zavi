
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let token = "stale";
const refreshSession = vi.fn(async () => {
  token = "fresh";
  return { data: { session: { access_token: token } }, error: null };
});
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: token } } }),
      refreshSession,
    },
  }),
}));
const captureEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/posthog", () => ({ captureEvent }));

import { READ_BACKOFF_MS, readWithRetry } from "./channelRead";
import { approve, listChannelActions, redoChannelAction, setChannelAction } from "./channelActionsApi";

const fetchMock = vi.fn();
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bearerOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get("Authorization");
const methodOf = (call: unknown[]) => ((call[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();

beforeEach(() => {
  token = "stale";
  refreshSession.mockClear();
  captureEvent.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reads", () => {
  it("a 401 refreshes the session once, then the read succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401))
      .mockResolvedValueOnce(json(200, { actions: [], more: 0, store: "channel_actions" }));
    const list = await listChannelActions("x_organic");
    expect(list.store).toBe("channel_actions");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchMock.mock.calls[1])).toBe("Bearer fresh");
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("retries a 5xx up to twice more, then succeeds quietly", async () => {
    fetchMock
      .mockResolvedValueOnce(json(502))
      .mockResolvedValueOnce(json(503))
      .mockResolvedValueOnce(json(200, { actions: [], more: 0, store: "channel_actions" }));
    await listChannelActions("seo");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("gives up after three attempts and records which read failed, with no body", async () => {
    fetchMock.mockResolvedValue(json(500, { error: { code: "db_timeout", message: "secret detail" } }));
    await expect(listChannelActions("meta_ads")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(captureEvent).toHaveBeenCalledTimes(1));
    const [event, props] = captureEvent.mock.calls[0];
    expect(event).toBe("channel_read_failed");
    expect(props).toMatchObject({ read: "actions", slug: "meta_ads", status: 500, code: "db_timeout", attempts: 3 });
    expect(JSON.stringify(props)).not.toContain("secret detail");
    expect(JSON.stringify(props)).not.toContain("stale");
  });

  it("does not retry a 429: the provider is rate limiting and an instant retry only extends the block", async () => {
    fetchMock.mockResolvedValue(json(429, { error: { code: "linkedin_ads_http_error", message: "LinkedIn Ads is busy right now." } }));
    const res = await readWithRetry("/api/agents/linkedin_ads/dashboard", { read: "dashboard", slug: "linkedin_ads" });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([["linkedin_ads_busy"], ["meta_ads_rate_limited"], ["throttled"]])("does not retry a 5xx whose code says the provider is busy (%s)", async (code) => {
    fetchMock.mockResolvedValue(json(503, { error: { code, message: "busy" } }));
    const res = await readWithRetry("/api/channels/linkedin_ads/actions", { read: "actions", slug: "linkedin_ads" });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([["meta_ads"], ["google_ads"], ["x_organic"]])("still retries a 429 on %s, then succeeds quietly", async (slug) => {
    fetchMock
      .mockResolvedValueOnce(json(429, { error: { code: "rate_limited" } }))
      .mockResolvedValueOnce(json(200, { actions: [], more: 0, store: "channel_actions" }));
    const res = await readWithRetry(`/api/channels/${slug}/actions`, { read: "actions", slug });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("still retries a busy-coded 5xx with Retry-After on another channel", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "meta_ads_rate_limited" } }), { status: 503, headers: { "Retry-After": "60" } }))
      .mockResolvedValueOnce(json(200, {}));
    const res = await readWithRetry("/api/channels/meta_ads/history", { read: "history", slug: "meta_ads" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 5xx that carries Retry-After", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503, headers: { "Retry-After": "60" } }));
    await readWithRetry("/api/channels/linkedin_ads/history", { read: "history", slug: "linkedin_ads" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404: that is an old backend, not a blip", async () => {
    fetchMock.mockResolvedValue(json(404));
    const res = await readWithRetry("/api/channels/instagram_organic/history", {
      read: "history",
      slug: "instagram_organic",
    });
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits 500ms, then 1.5s, between attempts", async () => {
    expect(READ_BACKOFF_MS).toEqual([500, 1500]);
    const g = globalThis as { __ZAVI_READ_BACKOFF_MS__?: number[] };
    const saved = g.__ZAVI_READ_BACKOFF_MS__;
    delete g.__ZAVI_READ_BACKOFF_MS__;
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(json(500)).mockResolvedValueOnce(json(500)).mockResolvedValueOnce(json(200));
      const done = readWithRetry("/api/channels/x_organic/metrics", { read: "metrics", slug: "x_organic" });
      await vi.advanceTimersByTimeAsync(499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1499);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      g.__ZAVI_READ_BACKOFF_MS__ = saved;
    }
  });
});

describe("writes are never retried", () => {
  it.each([
    ["set status", () => setChannelAction("a1", { action: "acted", request_id: "r1" })],
    ["redo", () => redoChannelAction("a1", "note")],
    ["approve", () => approve("a1", "r1")],
  ])("%s: a 500 is sent once", async (_name, call) => {
    fetchMock.mockResolvedValue(json(500));
    await expect(call()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(methodOf(fetchMock.mock.calls[0])).toBe("POST");
  });
});
