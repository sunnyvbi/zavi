// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_STATS_STORAGE_KEY,
  MonotonicClamp,
  displayValue,
  fetchLiveStats,
  parseLiveStats,
  type LiveStatsPayload,
} from "./liveStats";

const AS_OF = "2026-09-22T12:00:00.000Z";
const T0 = Date.parse(AS_OF);

const payload = (tokens = 1_000_000, steps = 400): LiveStatsPayload => ({
  as_of: AS_OF,
  metrics: {
    tokens_processed: { value: tokens, rate_per_sec: 1000 },
    agent_steps: { value: steps, rate_per_sec: 0.5 },
  },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseLiveStats", () => {
  it("accepts the contract shape", () => {
    expect(parseLiveStats(payload())).toEqual(payload());
  });

  it("rejects a missing metric, a bad date, or a non-number", () => {
    expect(parseLiveStats({ as_of: AS_OF, metrics: { tokens_processed: { value: 1, rate_per_sec: 1 } } })).toBeNull();
    expect(parseLiveStats({ ...payload(), as_of: "not a date" })).toBeNull();
    const bad = payload() as unknown as { metrics: { agent_steps: { value: unknown } } };
    bad.metrics.agent_steps.value = "400";
    expect(parseLiveStats(bad)).toBeNull();
    expect(parseLiveStats(null)).toBeNull();
  });

  it("rejects a pre-agent_steps payload and ignores the retired actions_approved key", () => {
    const old = { as_of: AS_OF, metrics: { tokens_processed: { value: 1, rate_per_sec: 1 }, actions_approved: { value: 5, rate_per_sec: 0 } } };
    expect(parseLiveStats(old)).toBeNull();
    const withExtra = { ...payload(), metrics: { ...payload().metrics, actions_approved: { value: 5, rate_per_sec: 0 } } };
    expect(parseLiveStats(withExtra)).toEqual(payload());
  });
});

describe("displayValue", () => {
  it("extrapolates tokens and agent steps from as_of", () => {
    const state = { payload: payload(), frozen: false };
    expect(displayValue(state, "tokens_processed", T0 + 10_000)).toBe(1_000_000 + 10_000);
    expect(displayValue(state, "agent_steps", T0 + 10_000)).toBe(400 + 5);
  });

  it("does not extrapolate a frozen (stored, fetch-failed) payload", () => {
    const state = { payload: payload(), frozen: true };
    expect(displayValue(state, "tokens_processed", T0 + 60_000)).toBe(1_000_000);
  });

  it("returns null with no data", () => {
    expect(displayValue(null, "tokens_processed", T0)).toBeNull();
  });
});

describe("MonotonicClamp", () => {
  it("holds instead of going down when a newer payload is lower than the estimate", () => {
    const clamp = new MonotonicClamp();
    const first = { payload: payload(1_000_000), frozen: false };
    const shownBefore = clamp.apply("tokens_processed", displayValue(first, "tokens_processed", T0 + 60_000)!);
    expect(shownBefore).toBe(1_060_000);
    const lower = { payload: { ...payload(1_050_000), as_of: new Date(T0 + 60_000).toISOString() }, frozen: false };
    expect(clamp.apply("tokens_processed", displayValue(lower, "tokens_processed", T0 + 60_000)!)).toBe(1_060_000);
    expect(clamp.apply("tokens_processed", displayValue(lower, "tokens_processed", T0 + 80_000)!)).toBe(1_070_000);
  });

  it("clamps each metric separately", () => {
    const clamp = new MonotonicClamp();
    clamp.apply("tokens_processed", 5_000);
    expect(clamp.apply("agent_steps", 3)).toBe(3);
    expect(clamp.apply("agent_steps", 2)).toBe(3);
  });
});

describe("fetchLiveStats", () => {
  it("returns live data and stores it", async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse(payload()));
    const state = await fetchLiveStats(f as unknown as typeof fetch);
    expect(state).toEqual({ payload: payload(), frozen: false });
    expect(String(f.mock.calls[0][0])).toMatch(/\/api\/public\/live-stats$/);
    expect(JSON.parse(window.localStorage.getItem(LIVE_STATS_STORAGE_KEY)!)).toEqual(payload());
  });

  it("on a 404, uses the stored payload frozen", async () => {
    window.localStorage.setItem(LIVE_STATS_STORAGE_KEY, JSON.stringify(payload(42)));
    const f = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    const state = await fetchLiveStats(f as unknown as typeof fetch);
    expect(state).toEqual({ payload: payload(42), frozen: true });
    expect(displayValue(state, "tokens_processed", T0 + 600_000)).toBe(42);
  });

  it("on a network error with nothing stored, returns null", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await fetchLiveStats(f as unknown as typeof fetch)).toBeNull();
  });

  it("a malformed 200 counts as a failure, not data", async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ as_of: AS_OF, metrics: {} }));
    expect(await fetchLiveStats(f as unknown as typeof fetch)).toBeNull();
    expect(window.localStorage.getItem(LIVE_STATS_STORAGE_KEY)).toBeNull();
  });

  it("survives storage that throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const ok = vi.fn().mockResolvedValue(jsonResponse(payload()));
    expect(await fetchLiveStats(ok as unknown as typeof fetch)).toEqual({ payload: payload(), frozen: false });
    const fail = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    expect(await fetchLiveStats(fail as unknown as typeof fetch)).toBeNull();
  });
});

describe("projection is bounded", () => {
  it("never projects more than an hour past the measured as_of", async () => {
    const { displayValue, MAX_PROJECTION_SEC } = await import("./liveStats");
    const asOf = Date.parse("2026-09-22T12:00:00.000Z");
    const state = {
      frozen: false,
      payload: {
        as_of: new Date(asOf).toISOString(),
        metrics: {
          tokens_processed: { value: 1_000_000, rate_per_sec: 1000 },
          agent_steps: { value: 10, rate_per_sec: 0.01 },
        },
      },
    } as never;
    const oneHour = displayValue(state, "tokens_processed", asOf + MAX_PROJECTION_SEC * 1000);
    const fiveHours = displayValue(state, "tokens_processed", asOf + 5 * 3600 * 1000);
    expect(oneHour).toBe(1_000_000 + 1000 * MAX_PROJECTION_SEC);
    expect(fiveHours).toBe(oneHour);
  });
});

describe("stored reading", () => {
  it("an older payload never replaces a newer stored one", async () => {
    const mod = await import("./liveStats");
    const at = (iso: string, v: number) => ({
      as_of: iso,
      metrics: { tokens_processed: { value: v, rate_per_sec: 1 }, agent_steps: { value: 1, rate_per_sec: 0 } },
    });
    window.localStorage.clear();
    mod.writeStoredLiveStats(at("2026-09-22T11:00:00.000Z", 2000));
    mod.writeStoredLiveStats(at("2026-09-22T10:00:00.000Z", 1000));
    expect(mod.readStoredLiveStats()?.metrics.tokens_processed.value).toBe(2000);
  });
});
