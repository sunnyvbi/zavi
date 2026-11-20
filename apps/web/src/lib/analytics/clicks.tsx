"use client";

import { useEffect } from "react";
import { pageInfo } from "@/lib/analytics/pages";
import { trackEvent } from "@/lib/analytics/events";
import { analyticsPath, analyticsUrl } from "@/lib/analytics/url";

export function clickTarget(href: string, origin: string): string {
  try {
    const url = new URL(href, origin);
    if (!/^https?:$/.test(url.protocol)) return "";
    if (url.origin !== origin) return url.host;
    const safe = new URL(analyticsUrl(url.href));
    return `${safe.pathname}${safe.search}`;
  } catch {
    return "";
  }
}

export function clickLabel(el: Element): string {
  const explicit = el.getAttribute("data-analytics") || el.getAttribute("aria-label");
  const text = explicit || el.textContent || "";
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function ClickTracking() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const info = pageInfo(window.location.pathname);
      if (!info || info.group === "onboarding") return;
      const el = (e.target as Element | null)?.closest?.("a[href], button");
      if (!el || el.closest("[data-analytics-ignore]")) return;
      const href = el.getAttribute("href");
      trackEvent("cta_clicked", {
        page_type: info.type,
        path: analyticsPath(window.location.pathname),
        element: el.tagName === "A" ? "link" : "button",
        target: href ? clickTarget(href, window.location.origin) : undefined,
        label: info.group === "marketing" ? clickLabel(el) : undefined,
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
