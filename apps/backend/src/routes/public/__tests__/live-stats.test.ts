import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  calls: 0,
  result: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/tenant-client", () => ({
  publicLiveStatsAggregate: async () => {
    H.calls += 1;
    return H.result;
  },
}));

import { publicLiveStats, __resetLiveStatsCache } from "../live-stats";

const ROW = {
  tokens_total: 1_000_000_000,
  tokens_7d: 604_800 * 50,
  actions_total: 1234,
  actions_7d: 60_480,
  steps_total: 250_000,
  steps_7d: 604_800 / 25,
  as_of: "2026-09-22T12:00:00.000Z",
};

function makeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

async function call() {
  const res = makeRes();
  await publicLiveStats({} as any, res as any);
  return res;
}

describe("GET /api/public/live-stats", () => {
  beforeEach(() => {
    __resetLiveStatsCache();
    H.calls = 0;
    H.result = { data: ROW, error: null };
    vi.useRealTimers();
  });

  it("concurrent cache misses share one RPC call", async () => {
    const [a, b] = await Promise.all([call(), call()]);
    expect(H.calls).toBe(1);
    expect(a.body).toEqual(b.body);
  });

  it("returns exactly the allowed keys", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["as_of", "metrics"]);
    expect(Object.keys(res.body.metrics).sort()).toEqual(["actions_approved", "agent_steps", "tokens_processed"]);
    expect(Object.keys(res.body.metrics.agent_steps).sort()).toEqual(["rate_per_sec", "value"]);
    expect(Object.keys(res.body.metrics.tokens_processed).sort()).toEqual(["rate_per_sec", "value"]);
    expect(Object.keys(res.body.metrics.actions_approved).sort()).toEqual(["rate_per_sec", "value"]);
    expect(res.body.as_of).toBe("2026-09-22T12:00:00.000Z");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=60");
  });

  it("values are integers and rate_per_sec = 7d count / 604800", async () => {
    const res = await call();
    const m = res.body.metrics;
    expect(m.tokens_processed.value).toBe(1_000_000_000);
    expect(Number.isInteger(m.tokens_processed.value)).toBe(true);
    expect(m.tokens_processed.rate_per_sec).toBeCloseTo(50, 10);
    expect(m.actions_approved.value).toBe(1234);
    expect(Number.isInteger(m.actions_approved.value)).toBe(true);
    expect(m.actions_approved.rate_per_sec).toBeCloseTo(0.1, 10);
    expect(m.agent_steps.value).toBe(250_000);
    expect(m.agent_steps.rate_per_sec).toBeCloseTo(0.04, 10);
  });

  it("a second call within the hour does not re-call the RPC", async () => {
    vi.useFakeTimers();
    await call();
    vi.advanceTimersByTime(59 * 60 * 1000);
    const res = await call();
    expect(H.calls).toBe(1);
    expect(res.body.metrics.actions_approved.value).toBe(1234);
    vi.advanceTimersByTime(2 * 60 * 1000);
    await call();
    expect(H.calls).toBe(2);
  });

  it("a stale reading is answered at once and refreshed behind the response", async () => {
    vi.useFakeTimers();
    await call();
    vi.advanceTimersByTime(61 * 60 * 1000);
    H.result = { data: { ...ROW, tokens_total: 2_000_000_000 }, error: null };
    const stale = await call();
    expect(stale.body.metrics.tokens_processed.value).toBe(1_000_000_000);
    expect(H.calls).toBe(2);
    await vi.runAllTimersAsync();
    const fresh = await call();
    expect(fresh.body.metrics.tokens_processed.value).toBe(2_000_000_000);
    expect(H.calls).toBe(2);
  });

  it("an RPC error with a cache present serves the cache", async () => {
    vi.useFakeTimers();
    await call();
    vi.advanceTimersByTime(61 * 60 * 1000);
    H.result = { data: null, error: { message: "relation agent_runs secret detail" } };
    const res = await call();
    expect(H.calls).toBe(2);
    expect(res.statusCode).toBe(200);
    expect(res.body.metrics.tokens_processed.value).toBe(1_000_000_000);
  });

  it("an RPC error with no cache returns 503 and a generic body", async () => {
    H.result = { data: null, error: { message: "permission denied for relation tenants" } };
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: { code: "unavailable" } });
    expect(JSON.stringify(res.body)).not.toContain("permission");
  });

  it("a malformed row with no cache returns 503, not a made-up number", async () => {
    H.result = { data: { ...ROW, tokens_total: null }, error: null };
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: { code: "unavailable" } });
  });
});
