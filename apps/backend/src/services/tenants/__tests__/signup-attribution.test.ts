vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
import { logEvent } from "@/services/logging/logEvent";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { describeAttribution, parseSignupAttribution, persistSignupAttribution } from "../signup-attribution";

describe("parseSignupAttribution", () => {
  it("keeps allow-listed fields and drops everything else", () => {
    expect(
      parseSignupAttribution({
        utm_source: " google ",
        utm_medium: "cpc",
        click_id: "gclid",
        referrer_host: "News.YCombinator.com",
        landing_path: "/pricing",
        first_seen_at: "2026-09-29T20:00:00Z",
        ip: "1.2.3.4",
        email: "x@y.com",
      }),
    ).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      click_id: "gclid",
      referrer_host: "news.ycombinator.com",
      landing_path: "/pricing",
      first_seen_at: "2026-09-29T20:00:00Z",
    });
  });

  it("rejects bad shapes", () => {
    expect(parseSignupAttribution(null)).toBeNull();
    expect(parseSignupAttribution("utm_source=google")).toBeNull();
    expect(parseSignupAttribution([])).toBeNull();
    expect(parseSignupAttribution({ utm_source: 5 })).toBeNull();
    expect(
      parseSignupAttribution({
        click_id: "abc123value",
        referrer_host: "evil.com/path?q=1",
        landing_path: "https://x.com",
        first_seen_at: "not a date",
      }),
    ).toBeNull();
    expect(
      parseSignupAttribution({
        landing_path: "/pricing?email=a@b.com",
      }),
    ).toBeNull();
  });

  it("caps lengths", () => {
    const a = parseSignupAttribution({ utm_campaign: "x".repeat(500) });
    expect(a?.utm_campaign).toHaveLength(100);
  });
});

describe("parseSignupAttribution from", () => {
  it("keeps a live entry point and drops malformed codes", () => {
    expect(parseSignupAttribution({ from: "live-upcar" })).toEqual({ from: "live-upcar" });
    expect(parseSignupAttribution({ from: "evil.com" })).toBeNull();
    expect(parseSignupAttribution({ from: "live-UPCAR" })).toBeNull();
    expect(parseSignupAttribution({ from: "live-a?b=c" })).toBeNull();
    expect(parseSignupAttribution({ from: `live-${"a".repeat(60)}` })).toBeNull();
  });
});

describe("describeAttribution", () => {
  it("unknown is not direct", () => {
    expect(describeAttribution(null)).toContain("unknown");
    expect(describeAttribution({ landing_path: "/" })).toBe("direct (no UTM, no outside referrer) · landed /");
  });
  it("names the on-site entry point instead of calling it direct", () => {
    expect(describeAttribution({ from: "live-upcar" })).toBe("via live-upcar");
    expect(describeAttribution({ utm_source: "x", from: "live-upcar", landing_path: "/live/upcar" })).toBe("x · via live-upcar · landed /live/upcar");
  });
});


vi.mock("@/services/settings", () => ({ setTenantSetting: vi.fn(async () => undefined) }));
import { setTenantSetting } from "@/services/settings";

const urlTags = { utm_source: "x", utm_medium: "creator", utm_campaign: "launch2", utm_content: "creator_alex" };
beforeEach(() => { vi.mocked(setTenantSetting).mockReset(); vi.mocked(logEvent).mockReset(); });

describe("persistSignupAttribution query fallback", () => {
  it("keeps body campaigns together and retains consented metadata", async () => {
    const body = { utm_source: "email", landing_path: "/pricing", referrer_host: "news.example.com" };
    await persistSignupAttribution("tenant", "user", body, urlTags);
    expect(setTenantSetting).toHaveBeenCalledWith("tenant", "signup_attribution", body, "user");
  });
  it("combines query campaigns with body metadata, not query metadata", async () => {
    await persistSignupAttribution("tenant", "user", { landing_path: "/pricing" }, {
      ...urlTags, from: "live-demo", referrer_host: "unconsented.example", landing_path: "/wrong", click_id: "gclid",
    });
    expect(setTenantSetting).toHaveBeenCalledWith("tenant", "signup_attribution", { ...urlTags, from: "live-demo", landing_path: "/pricing" }, "user");
  });
  it("preserves the existing body entry marker", async () => {
    await persistSignupAttribution("tenant", "user", { from: "live-first" }, { ...urlTags, from: "live-second" });
    expect(setTenantSetting).toHaveBeenCalledWith("tenant", "signup_attribution", { ...urlTags, from: "live-first" }, "user");
  });
  it("drops malformed query values and caps strings", async () => {
    await persistSignupAttribution("tenant", "user", null, { utm_source: ["x", "email"], utm_medium: { nested: "social" }, utm_campaign: "a".repeat(200), from: "invalid!" });
    expect(setTenantSetting).toHaveBeenCalledWith("tenant", "signup_attribution", { utm_campaign: "a".repeat(100) }, "user");
  });
  it.each([undefined, [], "utm_source=x", { referrer_host: "example.com", landing_path: "/", click_id: "gclid" }])("does not invent attribution from %j", async (query) => {
    await persistSignupAttribution("tenant", "user", undefined, query);
    expect(setTenantSetting).not.toHaveBeenCalled();
  });
  it("does not fail signup when the settings write fails", async () => {
    vi.mocked(setTenantSetting).mockRejectedValueOnce(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(persistSignupAttribution("tenant", "user", undefined, urlTags)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});


it("keeps a generic launch channel at both tenant-creation write sinks", async () => {
  for (const raw of [{ from: "filter-coffee" }, { from: "newsletter-launch2", utm_source: "email" }]) {
    expect(parseSignupAttribution(raw)).toEqual(raw);
    await persistSignupAttribution("tenant", "user", raw);
    expect(setTenantSetting).toHaveBeenLastCalledWith("tenant", "signup_attribution", raw, "user");
  }
  expect(parseSignupAttribution({ from: "x".repeat(51) })).toBeNull();
});


it("saves only allow-listed browser diagnostics and never trusts diagnostics from URL queries", async () => {
  expect(parseSignupAttribution({capture_status:"email@private.example"})).toBeNull();
  await persistSignupAttribution("tenant","user",{capture_status:"analytics_disabled"});
  expect(setTenantSetting).toHaveBeenCalledWith("tenant","signup_attribution",{capture_status:"analytics_disabled"},"user");
  vi.mocked(setTenantSetting).mockClear();
  await persistSignupAttribution("tenant","user",undefined,{capture_status:"analytics_disabled"});
  expect(setTenantSetting).not.toHaveBeenCalled();
  expect(describeAttribution({capture_status:"analytics_disabled"})).toContain("unknown");
});
it("logs missing input and write failures separately without raw source or error text", async () => {
  await persistSignupAttribution("tenant","user",undefined);
  expect(logEvent).toHaveBeenLastCalledWith(expect.objectContaining({code:"signup_attribution.missing"}));
  vi.mocked(setTenantSetting).mockRejectedValueOnce(new Error("secret database details"));
  await persistSignupAttribution("tenant","user",{from:"private-campaign"});
  expect(logEvent).toHaveBeenLastCalledWith(expect.objectContaining({code:"signup_attribution.persist_failed",tenant_id:"tenant"}));
  expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toMatch(/secret database details|private-campaign/);
  vi.mocked(logEvent).mockRejectedValueOnce(new Error("log store unavailable"));
  await expect(persistSignupAttribution("tenant","user",undefined)).resolves.toBeUndefined();
});
