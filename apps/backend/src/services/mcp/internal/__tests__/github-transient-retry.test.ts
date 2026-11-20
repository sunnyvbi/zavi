
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { fetchWithTransientRetry, isRetriableResponse } from "../github";

function mkRes(status: number, headers?: Record<string, string>): Response {
  return { status, headers: new Headers(headers ?? {}) } as unknown as Response;
}

describe("isRetriableResponse (DEL-686)", () => {
  it("treats 5xx + 429 as retriable", () => {
    expect(isRetriableResponse(mkRes(500))).toBe(true);
    expect(isRetriableResponse(mkRes(502))).toBe(true);
    expect(isRetriableResponse(mkRes(503))).toBe(true);
    expect(isRetriableResponse(mkRes(429))).toBe(true);
  });

  it("treats 403 as retriable ONLY when GitHub signals a secondary rate limit", () => {
    expect(isRetriableResponse(mkRes(403, { "retry-after": "1" }))).toBe(true);
    expect(isRetriableResponse(mkRes(403, { "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(isRetriableResponse(mkRes(403))).toBe(false);
  });

  it("does NOT retry ordinary success/4xx (incl. 422 branch-exists, handled by the caller)", () => {
    expect(isRetriableResponse(mkRes(200))).toBe(false);
    expect(isRetriableResponse(mkRes(404))).toBe(false);
    expect(isRetriableResponse(mkRes(422))).toBe(false);
  });
});

describe("fetchWithTransientRetry (DEL-686)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on a 200 (no retry)", async () => {
    const thunk = vi.fn(async () => mkRes(200));
    const p = fetchWithTransientRetry(thunk);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).status).toBe(200);
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient 503 then succeeds (the customer's refine survives a blip)", async () => {
    let n = 0;
    const thunk = vi.fn(async () => (++n === 1 ? mkRes(503) : mkRes(200)));
    const p = fetchWithTransientRetry(thunk);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).status).toBe(200);
    expect(thunk).toHaveBeenCalledTimes(2);
  });

  it("recovers from a thrown network/timeout error then succeeds", async () => {
    let n = 0;
    const thunk = vi.fn(async () => {
      if (++n === 1) throw new Error("socket timeout (aborted)");
      return mkRes(200);
    });
    const p = fetchWithTransientRetry(thunk);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).status).toBe(200);
    expect(thunk).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt cap and returns the LAST response as-is (caller handles it)", async () => {
    const thunk = vi.fn(async () => mkRes(503));
    const p = fetchWithTransientRetry(thunk);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await p).status).toBe(503);
    expect(thunk).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last error when every attempt throws", async () => {
    const thunk = vi.fn(async () => {
      throw new Error("boom");
    });
    const p = fetchWithTransientRetry(thunk).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await p;
    expect((err as Error).message).toBe("boom");
    expect(thunk).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a plain 403 (permission denial, not transient)", async () => {
    const thunk = vi.fn(async () => mkRes(403));
    const p = fetchWithTransientRetry(thunk);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).status).toBe(403);
    expect(thunk).toHaveBeenCalledTimes(1);
  });
});
