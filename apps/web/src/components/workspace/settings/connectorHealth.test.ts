import { describe, it, expect } from "vitest";
import {
  computeMetaAdsHealth,
  connectionState,
  needsReconnect,
  resolveExpiryMs,
  resolveRowHealth,
} from "./connectorHealth";

const DAY = 86400 * 1000;
const NOW = Date.parse("2026-09-09T00:00:00Z");
const iso = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY).toISOString();

describe("resolveExpiryMs", () => {
  it("prefers token_expires_at over connected_at + 60d", () => {
    expect(resolveExpiryMs(iso(-100), iso(5))).toBe(NOW + 5 * DAY);
  });
  it("falls back to connected_at + 60d for legacy rows", () => {
    expect(resolveExpiryMs(iso(-10), undefined)).toBe(NOW + 50 * DAY);
  });
  it("returns null with no usable signal", () => {
    expect(resolveExpiryMs(undefined, "not a date")).toBeNull();
  });
});

describe("computeMetaAdsHealth", () => {
  it("is healthy well before the warn window", () => {
    expect(computeMetaAdsHealth(undefined, iso(30), NOW)?.status).toBe("healthy");
  });
  it("is expiring inside 14 days", () => {
    expect(computeMetaAdsHealth(undefined, iso(3), NOW)).toEqual({ status: "expiring", daysToExpiry: 3 });
  });
  it("is expired once past", () => {
    expect(computeMetaAdsHealth(undefined, iso(-1), NOW)).toEqual({ status: "expired", daysToExpiry: 0 });
  });
});

describe("resolveRowHealth", () => {
  it("is undefined for a disconnected row", () => {
    expect(resolveRowHealth({ slug: "meta_ads", connected: false }, [], NOW)).toBeUndefined();
  });

  it("flags Slack scope drift with the missing scopes as the reason", () => {
    const h = resolveRowHealth({ slug: "slack", connected: true }, ["channels:join", "pins:read"], NOW);
    expect(h?.status).toBe("scope_drift");
    expect(h?.reason).toContain("channels:join, pins:read");
    expect(needsReconnect(h)).toBe(true);
  });

  it("is ok for Slack with no drift", () => {
    expect(resolveRowHealth({ slug: "slack", connected: true }, [], NOW)).toEqual({ status: "ok" });
  });

  it("marks an expired Meta Ads token as needing reconnect", () => {
    const h = resolveRowHealth(
      { slug: "meta_ads", connected: true, token_expires_at: iso(-2) },
      [],
      NOW,
    );
    expect(h?.status).toBe("expired");
    expect(needsReconnect(h)).toBe(true);
    expect(connectionState(true, h)).toEqual({ tone: "danger", text: "Needs reconnect" });
  });

  it("keeps an expiring token in Connected with a countdown state", () => {
    const h = resolveRowHealth(
      { slug: "google_ads", connected: true, token_expires_at: iso(7) },
      [],
      NOW,
    );
    expect(h?.status).toBe("expiring");
    expect(needsReconnect(h)).toBe(false);
    expect(connectionState(true, h)).toEqual({ tone: "warning", text: "Expiring in 7d" });
  });

  it("ignores expiry for connectors without a token signal", () => {
    expect(resolveRowHealth({ slug: "google_ads", connected: true }, [], NOW)).toEqual({ status: "ok" });
    expect(resolveRowHealth({ slug: "jira", connected: true, connected_at: iso(-400) }, [], NOW)).toEqual({ status: "ok" });
  });

  it("reads Connected / Not connected for the plain states", () => {
    expect(connectionState(true, { status: "ok" })).toEqual({ tone: "connected", text: "Connected" });
    expect(connectionState(false, undefined)).toEqual({ tone: "idle", text: "Not connected" });
  });

  it("shows Needs reconnect on LinkedIn Ads once the backend marks the refresh refused", () => {
    const h = resolveRowHealth(
      { slug: "linkedin_ads", connected: true, token_expires_at: "1970-01-01T00:00:00+00:00" },
      [],
      NOW,
    );
    expect(needsReconnect(h)).toBe(true);
    expect(h?.reason).toContain("LinkedIn Ads stopped accepting Zavi's access");
    expect(connectionState(true, h)).toEqual({ tone: "danger", text: "Needs reconnect" });
  });

  it("keeps LinkedIn Ads Connected while its access token is near or past expiry, because Zavi refreshes it on the next read", () => {
    for (const days of [-3, 0, 2, 40]) {
      const h = resolveRowHealth({ slug: "linkedin_ads", connected: true, token_expires_at: iso(days) }, [], NOW);
      expect(connectionState(true, h)).toEqual({ tone: "connected", text: "Connected" });
    }
    expect(resolveRowHealth({ slug: "linkedin_ads", connected: true }, [], NOW)).toEqual({ status: "ok" });
  });
});
