import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshSession = vi.fn(async () => ({ data: { session: { access_token: "fresh" } }, error: null }));
vi.mock("./supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "tok" } } }),
      refreshSession,
    },
  }),
}));

import { apiFetch, IDEMPOTENCY_HEADER, newIdempotencyKey } from "./api";

const keyOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get(IDEMPOTENCY_HEADER);

describe("apiFetch idempotent", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    refreshSession.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends ONE key and reuses it on every network retry of the same call", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const p = apiFetch("/api/channel-actions/a/redo", { method: "POST", body: "{}", idempotent: true });
    await vi.runAllTimersAsync();
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map(keyOf);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps the same key when a 401 forces a token refresh and resend", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await apiFetch("/api/channel-actions/a/redo", { method: "POST", body: "{}", idempotent: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(fetchMock.mock.calls[0])).toBe(keyOf(fetchMock.mock.calls[1]));
  });

  it("two separate calls (two user actions) get two different keys", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/x", { method: "POST", body: "{}", idempotent: true });
    await apiFetch("/api/x", { method: "POST", body: "{}", idempotent: true });
    expect(keyOf(fetchMock.mock.calls[0])).not.toBe(keyOf(fetchMock.mock.calls[1]));
  });

  it("sends no key unless asked (older behaviour unchanged) and never forwards the option", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/x", { method: "POST", body: "{}" });
    const init = fetchMock.mock.calls[0][1] as RequestInit & Record<string, unknown>;
    expect(keyOf(fetchMock.mock.calls[0])).toBeNull();
    expect("idempotent" in init).toBe(false);
  });

  it("a caller-supplied key wins over a minted one", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/x", {
      method: "POST",
      body: "{}",
      idempotent: true,
      headers: { [IDEMPOTENCY_HEADER]: "caller-key-123" },
    });
    expect(keyOf(fetchMock.mock.calls[0])).toBe("caller-key-123");
  });

  it("newIdempotencyKey is unique and matches the server's accepted shape", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
  });
});
