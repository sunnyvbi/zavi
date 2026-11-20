import { signupAttribution } from "@/lib/marketing/liveFrom";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFirstTouch, captureFirstTouch, FIRST_TOUCH_KEY, readFirstTouch, firstTouchForSignup } from "./first-touch";
import { isAnalyticsStorageKey } from "@/lib/consent";

const NOW = "2026-09-29T20:00:00.000Z";

describe("buildFirstTouch", () => {
  it("keeps UTM tags, the click-ID name only, and an outside referrer host only", () => {
    expect(
      buildFirstTouch(
        "https://www.zaviagent.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=SECRETVALUE",
        "https://news.ycombinator.com/item?id=123",
        NOW,
      ),
    ).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "brand",
      click_id: "gclid",
      referrer_host: "news.ycombinator.com",
      landing_path: "/pricing",
      first_seen_at: NOW,
    });
  });

  it("drops our own site as a referrer", () => {
    const ft = buildFirstTouch("https://www.zaviagent.com/start", "https://growth.zaviagent.com/", NOW);
    expect(ft.referrer_host).toBeUndefined();
    expect(ft.landing_path).toBe("/start");
  });

  it("survives junk", () => {
    expect(buildFirstTouch("not a url", "also not", NOW)).toEqual({ first_seen_at: NOW });
  });
});

describe("captureFirstTouch", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.cookie = "zavi_consent_v1=; Max-Age=0; Path=/";
  });

  it("stores once and never overwrites the first touch", () => {
    captureFirstTouch();
    const first = readFirstTouch();
    expect(first).not.toBeNull();
    window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify({ ...first, utm_source: "kept" }));
    captureFirstTouch();
    expect(readFirstTouch()?.utm_source).toBe("kept");
  });

  it("stores nothing when analytics were declined", () => {
    document.cookie = `zavi_consent_v1=${encodeURIComponent(
      JSON.stringify({ v: 1, analytics: false, ts: NOW }),
    )}; Path=/`;
    captureFirstTouch();
    expect(window.localStorage.getItem(FIRST_TOUCH_KEY)).toBeNull();
  });

  it("is analytics storage, so withdrawal purges it", () => {
    expect(isAnalyticsStorageKey(FIRST_TOUCH_KEY)).toBe(true);
  });
});

describe("creator channel retention", () => {
  afterEach(() => { window.localStorage.clear(); window.history.replaceState({}, "", "/"); document.cookie = "zavi_consent_v1=; Max-Age=0; Path=/"; });
  it("keeps a creator label when a visitor returns without URL tags", () => {
    window.history.replaceState({}, "", "/?from=cr-demo");
    captureFirstTouch();
    window.history.replaceState({}, "", "/start");
    expect(firstTouchForSignup()?.from).toBe("cr-demo");
  });
  it("adds the first explicit channel to an earlier untagged visit without replacing its campaign", () => {
    window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify({first_seen_at: NOW, utm_source: "search", landing_path: "/pricing"}));
    window.history.replaceState({}, "", "/?from=cr-demo"); captureFirstTouch();
    window.history.replaceState({}, "", "/?from=cr-other"); captureFirstTouch();
    expect(readFirstTouch()).toEqual({first_seen_at: NOW, utm_source: "search", landing_path: "/pricing", from: "cr-demo"});
  });
  it("never retains a creator label when analytics are rejected", () => {
    document.cookie = `zavi_consent_v1=${encodeURIComponent(JSON.stringify({v:3, analytics:false, ts:NOW}))}; Path=/`;
    window.history.replaceState({}, "", "/?from=cr-demo"); captureFirstTouch();
    expect(readFirstTouch()).toBeNull();
    expect(firstTouchForSignup()).toBeUndefined();
  });
});

describe("signup capture diagnostics", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); document.cookie="zavi_consent_v1=; Max-Age=0; Path=/"; });
  it("does not infer browser consent during server rendering", () => {
    vi.stubGlobal("window", undefined);
    expect(signupAttribution(undefined, {})).toEqual({capture_status:"not_captured"});
  });
  it("reports rejected analytics without retaining source data, while explicit URL tags still work", () => {
    document.cookie = `zavi_consent_v1=${encodeURIComponent(JSON.stringify({v:3,analytics:false,ts:NOW}))}; Path=/`;
    expect(signupAttribution(firstTouchForSignup(),{})).toEqual({capture_status:"analytics_disabled"});
    expect(signupAttribution(firstTouchForSignup(),{from:"cr-demo"})).toEqual({from:"cr-demo"});
  });
  it("distinguishes blocked storage from a browser with no capture", () => {
    expect(signupAttribution(firstTouchForSignup(),{})).toEqual({capture_status:"not_captured"});
    vi.spyOn(Storage.prototype,"getItem").mockImplementation(() => {throw new Error("blocked");});
    expect(signupAttribution(firstTouchForSignup(),{})).toEqual({capture_status:"storage_unavailable"});
  });
  it("uses the retained channel on a return, but keeps an explicit current signup channel authoritative", () => {
    const ft={first_seen_at:NOW,from:"cr-first",landing_path:"/"};
    expect(signupAttribution(ft,{})).toEqual(ft);
    expect(signupAttribution(ft,{from:"cr-second"})).toEqual({...ft,from:"cr-second"});
  });
  it("honors browser GPC before retaining a creator label", () => {
    vi.stubGlobal("navigator",{globalPrivacyControl:true});
    window.history.replaceState({},"","/?from=cr-demo");captureFirstTouch();
    expect(readFirstTouch()).toBeNull();
    expect(signupAttribution(firstTouchForSignup(),{})).toEqual({capture_status:"analytics_disabled"});
    window.history.replaceState({},"","/");
  });
});
