"use client";

import { useEffect, useRef } from "react";
import { trackEvent, trackEventDeferred } from "@/lib/analytics/events";

export type AuthState = "loading" | "out" | "needs_onboarding" | "onboarded" | "error";

type StartAnalyticsState = {
  authState: AuthState;
  committing: boolean;
  websiteLoading: boolean;
  step: "idea" | "website";
  brainstormOpen: boolean;
  websiteStage: "website" | "about";
  newMode: boolean;
};

export function failureReason(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network";
  return "server";
}

export function useStartAnalytics(state: StartAnalyticsState) {
  const usedBrainstorm = useRef(false);
  const { authState, committing, websiteLoading, step, brainstormOpen, websiteStage, newMode } = state;
  const screen = authState === "loading" || authState === "onboarded"
    ? null
    : authState === "error"
      ? "account_error"
      : committing
        ? "setting_up_workspace"
        : websiteLoading
          ? "website_scan"
          : step === "idea"
            ? brainstormOpen ? "idea_brainstorm" : "idea"
            : websiteStage === "website" ? "website_intake" : "review";
  const signedIn = authState === "needs_onboarding";

  useEffect(() => {
    if (!screen) return;
    return trackEventDeferred("onboarding_step_viewed", {
      step: screen,
      signed_in: signedIn,
      add_company: newMode,
    });
  }, [screen, signedIn, newMode]);

  function markBrainstormUsed() {
    usedBrainstorm.current = true;
    trackEvent("onboarding_brainstorm_idea_used");
  }

  function trackIdeaSubmitted() {
    trackEvent("onboarding_idea_submitted", {
      signed_in: signedIn,
      from_brainstorm: usedBrainstorm.current,
    });
  }

  return { markBrainstormUsed, trackIdeaSubmitted };
}
