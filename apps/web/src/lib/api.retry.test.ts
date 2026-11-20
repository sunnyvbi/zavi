import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  }),
}));

import { apiFetch } from "./api";

describe("apiFetch retryOnNetworkError", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a GET network error 3 times by default", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const p = apiFetch("/api/x");
    const settled = expect(p).rejects.toThrow("Failed to fetch");
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not repeat an unkeyed mutation after its side effect succeeds but the response is lost", async () => {
    let charges = 0;
    fetchMock.mockImplementation(async () => {
      charges++;
      throw new TypeError("Failed to fetch");
    });
    const settled = expect(apiFetch("/api/workspace/autopilot/refine-product", { method: "POST", body: "{}" })).rejects.toThrow("Failed to fetch");
    await vi.runAllTimersAsync();
    await settled;
    expect(charges).toBe(1);
  });

  it("makes exactly one attempt when retryOnNetworkError is false (uploads)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      apiFetch("/api/chat/upload-video", { method: "POST", body: "x", retryOnNetworkError: false }),
    ).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not forward retryOnNetworkError to fetch and still sends the bearer", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/chat/upload-doc", { method: "POST", retryOnNetworkError: false });
    const init = fetchMock.mock.calls[0][1] as RequestInit & Record<string, unknown>;
    expect("retryOnNetworkError" in init).toBe(false);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });
});
