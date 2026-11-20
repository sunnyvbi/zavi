"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import mixpanel from "mixpanel-browser";
import type { User } from "@supabase/supabase-js";
import { createBrowserSupabase } from "@/lib/supabase";
import { getVerifiedUser } from "@/lib/verifiedUser";
import { allowsAnalytics, hasAnalyticsConsent, subscribe } from "@/lib/consent";
import { pageInfo } from "@/lib/analytics/pages";
import { analyticsPath } from "@/lib/analytics/url";
import { firstThisSession } from "@/lib/analytics/session";

let ready = false;
let initialised = false;

export function track(event: string, props?: Record<string, unknown>): void {
  if (ready) mixpanel.track(event, props);
}

export function resetAnalyticsIdentity(): void {
  if (ready) mixpanel.reset();
}

function onSession(user: User): void {
  if (!ready) return;
  mixpanel.identify(user.id);
  mixpanel.people.set({ $email: user.email });
}

function PageView({ live }: { live: boolean }) {
  const pathname = usePathname();
  useEffect(() => {
    if (!live || !ready || !pathname) return;
    const info = pageInfo(pathname);
    if (!info) return;
    const path = analyticsPath(pathname);
    if (firstThisSession(`mp_pv:${path}`)) {
      track("page_viewed", { path, page_type: info.type, page_group: info.group });
    }
  }, [pathname, live]);
  return null;
}

export function MixpanelProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const host = window.location.hostname;
    const isLocalhost =
      host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
    const token = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;

    let sub: { unsubscribe: () => void } | null = null;

    const init = (allowed: boolean) => {
      if (ready || isLocalhost || !token || token === "undefined") return;
      if (!allowed) return;
      if (initialised) {
        window.location.reload();
        return;
      }
      mixpanel.init(token, {
        persistence: "localStorage",
        track_pageview: false,
        ip: false,
        property_blacklist: ["$current_url", "$initial_referrer", "$referrer"],
      });
      initialised = true;
      ready = true;
      setLive(true);
      const supabase = createBrowserSupabase();
      void getVerifiedUser(supabase).then((user) => {
        if (user) onSession(user);
      });
      sub = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session?.user) onSession(session.user);
      }).data.subscription;
    };

    init(hasAnalyticsConsent());
    const unsubscribe = subscribe((state) => {
      if (allowsAnalytics(state)) init(true);
      else if (ready) {
        mixpanel.opt_out_tracking();
        ready = false;
        setLive(false);
      }
    });
    return () => {
      unsubscribe();
      sub?.unsubscribe();
    };
  }, []);

  return (
    <>
      <PageView live={live} />
      {children}
    </>
  );
}
