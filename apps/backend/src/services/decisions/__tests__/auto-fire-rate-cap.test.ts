import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

import {
  checkAutoFireRateCap,
  AUTO_FIRE_RATE_CAP,
  AUTO_FIRE_WINDOW_MS,
} from "../auto-fire-rate-cap";

function mockCountResult(result: { count: number | null; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve(result);
  mocks.serviceClientMock.mockReturnValue({ from: () => chain });
}

beforeEach(() => {
  mocks.serviceClientMock.mockReset();
});

describe("checkAutoFireRateCap", () => {
  it("under cap → allowed:true with the count", async () => {
    mockCountResult({ count: 3, error: null });
    const r = await checkAutoFireRateCap("t-1", "operator.post-slack-message");
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(3);
    expect(r.cap).toBe(AUTO_FIRE_RATE_CAP);
    expect(r.reason).toBeUndefined();
  });

  it("exactly at cap → NOT allowed (>= boundary), reason over_cap", async () => {
    mockCountResult({ count: AUTO_FIRE_RATE_CAP, error: null });
    const r = await checkAutoFireRateCap("t-1", "operator.file-jira-issue");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("over_cap");
    expect(r.count).toBe(AUTO_FIRE_RATE_CAP);
  });

  it("over cap → NOT allowed, reason over_cap", async () => {
    mockCountResult({ count: AUTO_FIRE_RATE_CAP + 5, error: null });
    const r = await checkAutoFireRateCap("t-1", "operator.file-linear-issue");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("over_cap");
  });

  it("zero recent fires → allowed (a fresh low-volume tenant is never blocked)", async () => {
    mockCountResult({ count: 0, error: null });
    const r = await checkAutoFireRateCap("t-1", "operator.post-slack-message");
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(0);
  });

  it("null count from PostgREST → treated as 0 → allowed", async () => {
    mockCountResult({ count: null, error: null });
    const r = await checkAutoFireRateCap("t-1", "operator.post-slack-message");
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(0);
  });

  it("count ERROR → FAIL CLOSED (not allowed, reason count_error)", async () => {
    mockCountResult({ count: null, error: { message: "relation timeout" } });
    const r = await checkAutoFireRateCap("t-1", "operator.post-slack-message");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("count_error");
    expect(r.count).toBe(-1);
  });

  it("serviceClient throws → FAIL CLOSED (not allowed, reason count_error)", async () => {
    mocks.serviceClientMock.mockImplementation(() => {
      throw new Error("client unavailable");
    });
    const r = await checkAutoFireRateCap("t-1", "operator.post-slack-message");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("count_error");
  });

  it("honors a custom cap argument (boundary at the supplied cap)", async () => {
    mockCountResult({ count: 5, error: null });
    expect((await checkAutoFireRateCap("t-1", "x", 5)).allowed).toBe(false);
    mockCountResult({ count: 4, error: null });
    expect((await checkAutoFireRateCap("t-1", "x", 5)).allowed).toBe(true);
  });

  it("default cap is a sensible generous value (30) and window is 1h", () => {
    expect(AUTO_FIRE_RATE_CAP).toBe(30);
    expect(AUTO_FIRE_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});
