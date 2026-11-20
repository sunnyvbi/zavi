"use client";

import { useEffect } from "react";
import { apiFetch } from "@/lib/api";

const fired = new Set<string>();

export function __resetOnboardingEmailVisitForTest(): void {
  fired.clear();
}

function stripParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("src")) return;
  url.searchParams.delete("src");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function OnboardingEmailVisit({ src }: { src: string }) {
  useEffect(() => {
    if (fired.has(src)) return;
    fired.add(src);
    void (async () => {
      try {
        await apiFetch("/api/onboarding-emails/visit", {
          method: "POST",
          body: JSON.stringify({ src }),
        });
      } catch {
      }
      stripParam();
    })();
  }, [src]);
  return null;
}
