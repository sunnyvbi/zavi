// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { OnboardingEmailVisit, __resetOnboardingEmailVisitForTest } from "./OnboardingEmailVisit";
import { onboardingSrcOf } from "@/lib/onboarding-email-src";

beforeEach(() => {
  __resetOnboardingEmailVisitForTest();
  apiFetch.mockReset();
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=seo&src=onb_3#top");
});

describe("OnboardingEmailVisit", () => {
  it("posts the tag exactly once per page load", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 });
    const { rerender, unmount } = render(<OnboardingEmailVisit src="onb_3" />);
    rerender(<OnboardingEmailVisit src="onb_3" />);
    unmount();
    render(<OnboardingEmailVisit src="onb_3" />);
    await waitFor(() => expect(window.location.search).not.toContain("src="));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/onboarding-emails/visit");
    const init = apiFetch.mock.calls[0][1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ src: "onb_3" });
  });

  it("strips src from the URL and keeps the rest", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 });
    render(<OnboardingEmailVisit src="onb_3" />);
    await waitFor(() => expect(window.location.search).toBe("?tab=channels&channel=seo"));
    expect(window.location.hash).toBe("#top");
  });

  it("is silent on failure and still strips src", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));
    render(<OnboardingEmailVisit src="onb_3" />);
    await waitFor(() => expect(window.location.search).toBe("?tab=channels&channel=seo"));
  });
});

describe("onboardingSrcOf", () => {
  it("keeps only a well-formed onb_<n> tag", () => {
    expect(onboardingSrcOf("onb_1")).toBe("onb_1");
    expect(onboardingSrcOf("onb_99")).toBe("onb_99");
    for (const bad of ["onb_0", "onb_01", "onb_100", "onb_3&x=1", "ONB_3", "", undefined, 3]) {
      expect(onboardingSrcOf(bad), String(bad)).toBeNull();
    }
  });
});
