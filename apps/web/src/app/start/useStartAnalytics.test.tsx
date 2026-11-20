// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/events", () => ({
  trackEvent: track,
  trackEventDeferred: track,
}));

import { failureReason, useStartAnalytics, type AuthState } from "./useStartAnalytics";

afterEach(() => { cleanup(); track.mockReset(); });

describe("start analytics", () => {
  it("updates event properties when auth or add-company mode changes on the same screen", () => {
    const state = { authState: "out" as AuthState, committing: false, websiteLoading: false,
      step: "website" as const, brainstormOpen: false, websiteStage: "website" as const, newMode: false };
    const hook = renderHook(useStartAnalytics, { initialProps: state });
    hook.rerender({ ...state, authState: "needs_onboarding", newMode: true });
    expect(track).toHaveBeenLastCalledWith("onboarding_step_viewed", {
      step: "website_intake", signed_in: true, add_company: true,
    });
  });

  it("tracks the brainstorm choice without sending its content", () => {
    const hook = renderHook(() => useStartAnalytics({ authState: "out", committing: false,
      websiteLoading: false, step: "idea", brainstormOpen: false, websiteStage: "website", newMode: false }));
    act(() => { hook.result.current.markBrainstormUsed(); hook.result.current.trackIdeaSubmitted(); });
    expect(track).toHaveBeenCalledWith("onboarding_idea_submitted", { signed_in: false, from_brainstorm: true });
  });

  it("reports stable failure categories", () => {
    expect(failureReason(new DOMException("request aborted", "AbortError"))).toBe("timeout");
    expect(failureReason(new TypeError("private network detail"))).toBe("network");
    expect(failureReason(null)).toBe("server");
  });
});
