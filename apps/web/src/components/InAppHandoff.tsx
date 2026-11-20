"use client";

import { useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics/events";
import {
  HANDOFF_SESSION_KEY,
  handoffEnabled,
  handoffPage,
  handoffTarget,
  leaveTo,
  watchOpenAttempt,
} from "@/lib/inAppBrowser";

const ENABLED = handoffEnabled(process.env.NEXT_PUBLIC_IN_APP_HANDOFF);
const START_DELAY_MS = 400;

export function InAppHandoff({ enabled = ENABLED }: { enabled?: boolean }) {
  const landed = useRef<string | null>(null);
  if (landed.current === null && typeof window !== "undefined") landed.current = window.location.href;

  useEffect(() => {
    const userAgent = window.navigator.userAgent;
    if (!handoffTarget(handoffPage(landed.current, window.location.href), userAgent, enabled)) return;
    const os = /Android/.test(userAgent) ? "android" : "ios";
    let stopWatch: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      const target = handoffTarget(handoffPage(landed.current, window.location.href), userAgent, enabled);
      if (!target) return;
      try {
        if (window.sessionStorage.getItem(HANDOFF_SESSION_KEY)) return;
        window.sessionStorage.setItem(HANDOFF_SESSION_KEY, "1");
      } catch {
        return;
      }
      trackEvent("in_app_handoff_attempted", { app: "X", os });
      stopWatch = watchOpenAttempt(() => trackEvent("in_app_handoff_stuck", { app: "X", os }));
      leaveTo(target.href);
    }, START_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      stopWatch?.();
    };
  }, [enabled]);
  return null;
}
