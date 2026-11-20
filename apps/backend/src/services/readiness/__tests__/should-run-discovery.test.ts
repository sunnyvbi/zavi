import { describe, it, expect } from "vitest";
import { shouldRunDiscovery, READINESS_OPERABLE } from "../should-run-discovery";

const T0 = "2026-07-01T00:00:00.000Z";
const BEFORE = "2026-06-20T00:00:00.000Z";
const AFTER = "2026-07-05T00:00:00.000Z";

describe("park-don't-spin: when may onboarding-discovery re-fire?", () => {
  it("operable tenant → never runs", () => {
    const d = shouldRunDiscovery({
      score: READINESS_OPERABLE,
      last_discovery_at: null,
      newest_signal_at: null,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/operable/);
  });

  it("never discovered → runs once", () => {
    const d = shouldRunDiscovery({ score: 38, last_discovery_at: null, newest_signal_at: null });
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/never run/);
  });

  it("PARKS when discovery already ran and nothing new landed (the 8-identical-runs bug)", () => {
    const d = shouldRunDiscovery({
      score: 38,
      last_discovery_at: T0,
      newest_signal_at: null,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/parked/i);
    expect(d.reason).toMatch(/human-gated/i);
  });

  it("PARKS when the only signal is OLDER than the last discovery (already seen)", () => {
    const d = shouldRunDiscovery({
      score: 38,
      last_discovery_at: T0,
      newest_signal_at: BEFORE,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/parked/i);
  });

  it("RE-RUNS when a new human signal lands after the last discovery (founder set a product URL)", () => {
    const d = shouldRunDiscovery({
      score: 38,
      last_discovery_at: T0,
      newest_signal_at: AFTER,
    });
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/new human signal/i);
  });

  it("a low score alone is NOT a reason to run — only new input is", () => {
    const parked = shouldRunDiscovery({ score: 5, last_discovery_at: T0, newest_signal_at: null });
    expect(parked.run).toBe(false);
  });

  it("malformed signal timestamp is treated as no signal (parks, never crashes)", () => {
    const d = shouldRunDiscovery({
      score: 38,
      last_discovery_at: T0,
      newest_signal_at: "not-a-date",
    });
    expect(d.run).toBe(false);
  });
});
