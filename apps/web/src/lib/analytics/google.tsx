"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { readConsent, subscribe } from "@/lib/consent";
import { allowsGoogleAnalytics, readRegion } from "@/lib/region";
import { pageInfo } from "@/lib/analytics/pages";
import { analyticsPath, analyticsUrl } from "@/lib/analytics/url";

type Gtag = (...args: unknown[]) => void;
type GaWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag } & { [key: `ga-disable-${string}`]: boolean | undefined };

let ready = false;
let initialised = false;
let measurementId = "";

export function gaUrl(href: string): string {
  const safe = analyticsUrl(href);
  if (!safe) return "";
  const url = new URL(safe);
  if (url.origin !== window.location.origin || pageInfo(url.pathname)) return safe;
  return `${url.origin}/app`;
}

function gtag(...args: unknown[]): void {
  const w = window as unknown as GaWindow;
  w.gtag?.(...args);
}

export function gaParams(props?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === "string") out[k.slice(0, 40)] = v.slice(0, 100);
    else if (typeof v === "number" || typeof v === "boolean") out[k.slice(0, 40)] = v;
  }
  return out;
}

export function gaEvent(event: string, props?: Record<string, unknown>): void {
  if (!ready) return;
  gtag("event", event, {
    ...gaParams(props),
    page_location: gaUrl(window.location.href),
    page_referrer: gaUrl(document.referrer),
    page_title: pageInfo(window.location.pathname)?.type ?? "app",
  });
}

function loadGtag(id: string): void {
  const w = window as unknown as GaWindow;
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtagShim() {
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer!.push(arguments);
  };
  gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  gtag("js", new Date());
  gtag("config", id, {
    send_page_view: false,
    page_location: gaUrl(window.location.href),
    page_referrer: gaUrl(document.referrer),
    page_title: pageInfo(window.location.pathname)?.type ?? "app",
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);
}

function GaPageView({ live }: { live: boolean }) {
  const pathname = usePathname();
  useEffect(() => {
    if (!live || !ready || !pathname) return;
    const info = pageInfo(pathname);
    gtag("set", {
      page_location: gaUrl(window.location.href),
      page_title: info?.type ?? "app",
    });
    if (!info) return;
    gtag("event", "page_view", {
      page_path: analyticsPath(pathname),
      page_location: gaUrl(window.location.href),
      page_title: info.type,
      page_type: info.type,
      page_group: info.group,
    });
  }, [pathname, live]);
  return null;
}

export function GoogleAnalyticsProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const host = window.location.hostname;
    const isLocalhost =
      host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
    const id = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    const manualOnly = process.env.NEXT_PUBLIC_GA_ENHANCED_MEASUREMENT_DISABLED === "true";

    const init = (allowed: boolean) => {
      if (isLocalhost || !manualOnly || !id || id === "undefined") return;
      if (!allowed) return;
      if (ready) {
        setLive(true);
        return;
      }
      if (initialised) {
        window.location.reload();
        return;
      }
      measurementId = id;
      loadGtag(id);
      initialised = true;
      ready = true;
      setLive(true);
    };

    const region = readRegion();
    init(allowsGoogleAnalytics(readConsent(), region));
    const unsubscribe = subscribe((state) => {
      if (allowsGoogleAnalytics(state, region)) init(true);
      else if (ready) {
        gtag("consent", "update", { analytics_storage: "denied" });
        (window as unknown as GaWindow)[`ga-disable-${measurementId}`] = true;
        ready = false;
        setLive(false);
      }
    });
    return unsubscribe;
  }, []);

  return (
    <>
      <GaPageView live={live} />
      {children}
    </>
  );
}
