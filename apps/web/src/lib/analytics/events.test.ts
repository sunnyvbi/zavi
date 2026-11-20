import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mp: vi.fn(), ph: vi.fn(), ga: vi.fn() }));

vi.mock("@/lib/analytics/mixpanel", () => ({ track: h.mp }));
vi.mock("@/lib/analytics/posthog", () => ({ captureEvent: h.ph }));
vi.mock("@/lib/analytics/google", () => ({ gaEvent: h.ga }));

import { trackEvent, trackEventDeferred } from "./events";

describe("trackEvent", () => {
  beforeEach(() => {
    h.mp.mockReset();
    h.ph.mockReset();
    h.ga.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the same event to Mixpanel, PostHog and Google Analytics", () => {
    trackEvent("pricing_plan_selected", { tier: "starter", signed_in: false });
    const expected = ["pricing_plan_selected", { tier: "starter", signed_in: false }];
    expect(h.mp).toHaveBeenCalledWith(...expected);
    expect(h.ph).toHaveBeenCalledWith(...expected);
    expect(h.ga).toHaveBeenCalledWith(...expected);
  });

  it("drops undefined properties", () => {
    trackEvent("cta_clicked", { label: undefined, page_type: "home" });
    expect(h.mp).toHaveBeenCalledWith("cta_clicked", { page_type: "home" });
  });

  it("keeps product actions and other providers working when an SDK throws", () => {
    h.mp.mockImplementation(() => { throw new Error("storage unavailable"); });
    h.ph.mockImplementation(() => { throw new Error("capture failed"); });
    expect(() => trackEvent("checkout_started", { tier: "starter" })).not.toThrow();
    expect(h.ga).toHaveBeenCalledWith("checkout_started", { tier: "starter" });
  });

  it("the deferred form sends one tick later, after the providers have initialised", () => {
    vi.useFakeTimers();
    trackEventDeferred("onboarding_step_viewed", { step: "website_intake" });
    expect(h.mp).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(h.mp).toHaveBeenCalledWith("onboarding_step_viewed", { step: "website_intake" });
    expect(h.ga).toHaveBeenCalledTimes(1);
  });

  it("cancels deferred screen events after the screen unmounts", () => {
    vi.useFakeTimers();
    const cancel = trackEventDeferred("auth_screen_viewed", { screen: "sign_in" });
    cancel();
    vi.runAllTimers();
    expect(h.mp).not.toHaveBeenCalled();
    expect(h.ph).not.toHaveBeenCalled();
    expect(h.ga).not.toHaveBeenCalled();
  });
});
