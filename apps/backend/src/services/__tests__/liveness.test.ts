
import { describe, it, expect, afterEach } from "vitest";
import {
  getLiveness,
  currentEventLoopLagMs,
  startLivenessSampler,
  _stopLivenessSampler,
  _setLastTickForTest,
} from "../liveness";

afterEach(() => {
  _stopLivenessSampler();
});

describe("liveness probe", () => {
  it("reports ok:true with ~0 lag on a healthy loop", () => {
    startLivenessSampler();
    const live = getLiveness();
    expect(live.ok).toBe(true);
    expect(live.event_loop_lag_ms).toBeLessThan(1_000);
    expect(typeof live.uptime_s).toBe("number");
    expect(live.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it("is synchronous — returns a value, not a Promise (no DB/await on the hot path)", () => {
    startLivenessSampler();
    const live = getLiveness();
    expect(live).not.toBeInstanceOf(Promise);
    expect(live).toHaveProperty("ok");
    expect(live).toHaveProperty("event_loop_lag_ms");
  });

  it("reports rising lag as the loop falls behind, but stays ok below the ceiling", () => {
    startLivenessSampler();
    _setLastTickForTest(Date.now() - 5_000);
    const lag = currentEventLoopLagMs();
    expect(lag).toBeGreaterThan(3_000);
    expect(getLiveness().ok).toBe(true);
  });

  it("reports not-ok only when the loop is wedged past the ceiling (truly hung)", () => {
    startLivenessSampler();
    _setLastTickForTest(Date.now() - 90_000);
    const live = getLiveness();
    expect(live.ok).toBe(false);
    expect(live.event_loop_lag_ms).toBeGreaterThan(60_000);
  });

  it("honors a custom ceiling", () => {
    startLivenessSampler();
    _setLastTickForTest(Date.now() - 5_000);
    expect(getLiveness(2_000).ok).toBe(false);
    expect(getLiveness().ok).toBe(true);
  });
});
