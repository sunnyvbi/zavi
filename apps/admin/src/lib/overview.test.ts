import { describe, it, expect } from "vitest";
import { activityText, dayLabel, deltaTone, navBadges, netScore, relTime, signedPct, sparkPoints, type Overview } from "./overview";

function overview(p: { pending?: number; failed?: number; stuck?: number }): Overview {
  return {
    decisions: { pending: p.pending ?? 0, pending_older_48h: 0, daily_new: [] },
    runs: { failed_24h: p.failed ?? 0 },
    stuck_runs: { count: p.stuck ?? 0, sla_minutes: 15, oldest: [] },
  } as unknown as Overview;
}

describe("navBadges", () => {
  it("no data means no badges", () => {
    expect(navBadges(null)).toEqual({});
  });
  it("hides zero counts and colours errors red", () => {
    expect(navBadges(overview({}))).toEqual({});
    expect(navBadges(overview({ pending: 39, failed: 3, stuck: 2 }))).toEqual({
      "/decisions": { count: 39, tone: "amber" },
      "/errors": { count: 3, tone: "red" },
      "/stuck-runs": { count: 2, tone: "amber" },
    });
  });
});

describe("navBadges crons", () => {
  it("counts down + degraded crons, red when any is down", () => {
    const base = overview({});
    expect(navBadges({ ...base, crons: { healthy: 9, degraded: 2, down: 0, failing: [], recent_failures: [] } })["/crons"]).toEqual({ count: 2, tone: "amber" });
    expect(navBadges({ ...base, crons: { healthy: 9, degraded: 1, down: 1, failing: [], recent_failures: [] } })["/crons"]).toEqual({ count: 2, tone: "red" });
    expect(navBadges({ ...base, crons: { healthy: 9, degraded: 0, down: 0, failing: [], recent_failures: [] } })["/crons"]).toBeUndefined();
  });
});

describe("deltaTone", () => {
  it("runs (neutral) stay gray whether up or down", () => {
    expect(deltaTone(-64, "neutral")).toBe("neutral");
    expect(deltaTone(40, "neutral")).toBe("neutral");
  });
  it("spend: up is bad, down is good, zero is neutral", () => {
    expect(deltaTone(38, "up-is-bad")).toBe("bad");
    expect(deltaTone(-93, "up-is-bad")).toBe("good");
    expect(deltaTone(0, "up-is-bad")).toBe("neutral");
  });
  it("up-is-good flips the colours", () => {
    expect(deltaTone(5, "up-is-good")).toBe("good");
    expect(deltaTone(-5, "up-is-good")).toBe("bad");
  });
});

describe("formatters", () => {
  it("net score", () => {
    expect(netScore(3, 2)).toBe(20);
    expect(netScore(0, 0)).toBeNull();
  });
  it("signed percent", () => {
    expect(signedPct(12)).toBe("+12%");
    expect(signedPct(-11)).toBe("-11%");
    expect(signedPct(0)).toBe("0%");
  });
  it("sparkline points span the box and survive flat or tiny series", () => {
    expect(sparkPoints([])).toBe("");
    expect(sparkPoints([5])).toBe("0,14 200,14");
    expect(sparkPoints([2, 2, 2])).toBe("0.0,14.0 100.0,14.0 200.0,14.0");
    expect(sparkPoints([0, 10])).toBe("0.0,26.0 200.0,2.0");
  });
  it("relative time and day labels", () => {
    const now = Date.parse("2026-10-14T18:00:00Z");
    expect(relTime("2026-10-14T17:45:00Z", now)).toBe("15 min ago");
    expect(relTime("2026-10-14T12:00:00Z", now)).toBe("6 h ago");
    expect(relTime("2026-10-12T18:00:00Z", now)).toBe("2 d ago");
    expect(dayLabel("2026-10-01", false)).toBe("Oct 1");
    expect(dayLabel("2026-10-05", true)).toBe("Oct 5");
    expect(dayLabel("2026-10-05", false)).toBe("5");
  });
  it("activity text only uses whitelisted detail", () => {
    expect(activityText("connector.connected", { slug: "slack" })).toBe("Connected slack");
    expect(activityText("deliverable.produced", { mime: "pdf" })).toBe("Produced a deliverable");
    expect(activityText("tenant.signed_up", {})).toBe("tenant signed up");
  });
});
