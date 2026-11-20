import { afterEach, describe, expect, it, vi } from "vitest";
import { FREE_FIXTURE, PAID_FIXTURE } from "../fixtures";
import { formatComparison, formatMetricValue, formatRelativeSync } from "../format";
import { fixtureFromSearch } from "../client";

describe("App Home fixtures", () => {
  it("paid fixture only shows paid-channel work on a tier that allows it", () => {
    expect(PAID_FIXTURE.billing.tier).toBe("pro");
    expect(PAID_FIXTURE.status.channels.every((c) => c.state !== "plan_locked")).toBe(true);
    expect(PAID_FIXTURE.metrics.ad_spend.availability).toBe("live");
  });

  it("free fixture locks paid channels, has no approvals and no ad spend number", () => {
    expect(FREE_FIXTURE.billing.tier).toBe("free");
    expect(FREE_FIXTURE.status.channels.filter((c) => c.state === "plan_locked").every((c) => c.locked_tier)).toBe(true);
    expect(FREE_FIXTURE.approvals.rows).toHaveLength(0);
    expect(FREE_FIXTURE.metrics.ad_spend.value).toBeNull();
    expect(FREE_FIXTURE.metrics.ad_spend.availability).toBe("plan_locked");
  });

  it("money-changing approvals are never one-click", () => {
    for (const row of PAID_FIXTURE.approvals.rows) {
      if (row.needs_owner_admin) expect(row.one_click_approvable).toBe(false);
    }
  });

  it("daily allowance comes from the pricing contract, not a literal", () => {
    expect(FREE_FIXTURE.billing.daily_allowance).toBe(FREE_FIXTURE.pricing.freeDailyCredits);
    expect(PAID_FIXTURE.billing.daily_allowance).toBe(PAID_FIXTURE.pricing.freeDailyCredits);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("App Home formatting", () => {
  it("formats currency and counts", () => {
    expect(formatMetricValue(PAID_FIXTURE.metrics.sales)).toBe("$4,820");
    expect(formatMetricValue(PAID_FIXTURE.metrics.orders)).toBe("38");
    expect(formatMetricValue(FREE_FIXTURE.metrics.ad_spend)).toBeNull();
  });

  it("formats comparisons as percent for money and absolute for counts", () => {
    expect(formatComparison(PAID_FIXTURE.metrics.sales)).toEqual({ text: "12%", up: true });
    expect(formatComparison(PAID_FIXTURE.metrics.orders)).toEqual({ text: "6", up: true });
    expect(formatComparison(PAID_FIXTURE.metrics.zavi_actions)).toBeNull();
  });

  it("describes the last sync relative to now", () => {
    const now = new Date("2026-10-29T09:00:00.000Z");
    expect(formatRelativeSync("2026-10-29T08:48:00.000Z", now)).toBe("synced 12 min ago");
    expect(formatRelativeSync(null, now)).toBe("not synced yet");
  });

  it("fixture query includes the disconnected setup screen outside production", () => {
    expect(fixtureFromSearch("?fixture=free")).toBe("free");
    expect(fixtureFromSearch("?fixture=setup")).toBe("setup");
    expect(fixtureFromSearch("")).toBe("paid");
  });

  it("never serves a fixture in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(fixtureFromSearch("?fixture=free")).toBeNull();
    expect(fixtureFromSearch("")).toBeNull();
  });
});
