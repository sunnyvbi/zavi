import { describe, expect, it } from "vitest";
import {
  liveFromInNext,
  liveFromParam,
  liveStartHref,
  signupAttribution,
  urlAttribution,
  withUrlAttribution,
  onboardingAttributionHref,
} from "./liveFrom";

describe("liveFrom", () => {
  it("accepts only a clean live-<slug> marker", () => {
    expect(liveFromParam("live-upcar")).toBe("live-upcar");
    expect(liveFromParam("upcar")).toBeNull();
    expect(liveFromParam("live-Upcar")).toBeNull();
    expect(liveFromParam("live-x&y=1")).toBeNull();
    expect(liveFromParam(null)).toBeNull();
  });

  it("sends a typed site to the website step with the scan prefilled", () => {
    expect(liveStartHref("upcar", " acme.com ")).toBe("/start?step=website&website=acme.com&from=live-upcar");
    expect(liveStartHref("upcar", "")).toBe("/start?from=live-upcar");
  });

  it("reads from and the utm tags out of a URL, and nothing else", () => {
    expect(
      urlAttribution("?utm_source=x&utm_medium=social&utm_campaign=launch2&from=live-upcar&step=idea&gclid=1"),
    ).toEqual({ utm_source: "x", utm_medium: "social", utm_campaign: "launch2", from: "live-upcar" });
    expect(urlAttribution("?from=evil.com&utm_source=%20")).toEqual({});
    expect(urlAttribution(new URLSearchParams("utm_content=creator1"))).toEqual({ utm_content: "creator1" });
    expect(urlAttribution({ utm_source: "email", utm_term: ["a", "b"], step: undefined })).toEqual({ utm_source: "email" });
    expect(urlAttribution("?utm_source=" + "x".repeat(200)).utm_source).toHaveLength(100);
  });

  it("carries the attribution through a login next or a CTA href and reads from back", () => {
    const a = urlAttribution("?utm_source=x&utm_campaign=launch2&from=live-upcar");
    const next = withUrlAttribution("/start?card=abc", a);
    expect(next).toBe("/start?card=abc&utm_source=x&utm_campaign=launch2&from=live-upcar");
    expect(liveFromInNext(next)).toBe("live-upcar");
    expect(urlAttribution(next.slice(next.indexOf("?")))).toEqual(a);
    expect(withUrlAttribution("/start", { from: "live-upcar" })).toBe("/start?from=live-upcar");
    expect(withUrlAttribution("/start", {})).toBe("/start");
    expect(liveFromInNext("/workspace?from=live-upcar")).toBeNull();
    expect(liveFromInNext("/onboarding/past-work?website=a.com&resume=website&from=live-upcar")).toBe("live-upcar");
    expect(liveFromInNext("/start?from=evil")).toBeNull();
  });

  it("sends the URL attribution even when consent gave nothing", () => {
    expect(signupAttribution(undefined, { from: "live-upcar", utm_source: "x" })).toEqual({ from: "live-upcar", utm_source: "x" });
    expect(signupAttribution(undefined, {})).toEqual({capture_status: "not_captured"});
    const ft = { landing_path: "/", first_seen_at: "2026-10-11T00:00:00Z" };
    expect(signupAttribution(ft, { from: "live-upcar" })).toEqual({ ...ft, from: "live-upcar" });
    expect(signupAttribution(ft, {})).toEqual(ft);
  });

  it("keeps the stored campaign together instead of borrowing another channel's campaign or creator", () => {
    const ft = { utm_source: "producthunt", landing_path: "/", first_seen_at: "2026-10-11T00:00:00Z" };
    expect(signupAttribution(ft, { utm_source: "x", utm_medium: "creator", utm_campaign: "launch2", utm_content: "creator_alex", from: "live-demo" })).toEqual({ ...ft, from: "live-demo" });
    const metadata = { landing_path: "/", referrer_host: "example.org", first_seen_at: "2026-10-11T00:00:00Z" };
    expect(signupAttribution(metadata, { utm_source: "x", utm_campaign: "launch2" })).toEqual({ ...metadata, utm_source: "x", utm_campaign: "launch2" });
  });

  it("puts tags before a fragment and preserves an explicit destination's campaign without duplicates", () => {
    expect(withUrlAttribution("/start?step=idea#form", { utm_source: "x" })).toBe("/start?step=idea&utm_source=x#form");
    expect(withUrlAttribution("/start?utm_source=email#form", { utm_source: "x", utm_content: "creator_alex" })).toBe("/start?utm_source=email#form");
    expect(withUrlAttribution("/start?utm_source=&from=invalid!", { utm_source: "x", utm_campaign: "launch2", from: "live-demo" })).toBe("/start?utm_source=x&from=live-demo&utm_campaign=launch2");
  });

  it("only decorates exact, safe onboarding destinations", () => {
    for (const path of ["/workspace", "/creator", "/oauth/consent?req=abc", "/starter", "//evil.example/start", "/%2fstart"]) {
      expect(onboardingAttributionHref(path, { utm_source: "x" })).toBe(path);
    }
    expect(onboardingAttributionHref("/start", { utm_source: "x" })).toBe("/start?utm_source=x");
    expect(onboardingAttributionHref("/onboarding/past-work?website=example.com", { utm_source: "x" })).toBe("/onboarding/past-work?website=example.com&utm_source=x");
  });
});

describe("launch channel codes", () => {
  it("carries a generic source through signup even without consented browser metadata", () => {
    const tags = urlAttribution("from=filter-coffee&utm_source=newsletter&utm_campaign=launch2");
    expect(tags.from).toBe("filter-coffee");
    expect(signupAttribution(undefined, tags)).toEqual({from: "filter-coffee", utm_source: "newsletter", utm_campaign: "launch2"});
    expect(urlAttribution(withUrlAttribution("/start", tags).split("?")[1])).toEqual(tags);
    expect(liveFromInNext("/start?from=filter-coffee")).toBeNull();
  });
  it.each(["UPPER", "a@b.com", "x/y", "x&admin=1", "x".repeat(51)])("drops invalid source %s", from => {
    expect(urlAttribution(new URLSearchParams({from})).from).toBeUndefined();
  });
});
