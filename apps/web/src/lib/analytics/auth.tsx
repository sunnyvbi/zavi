"use client";

import { useEffect } from "react";
import type { User } from "@supabase/supabase-js";
import { allowsAnalytics, hasAnalyticsConsent, subscribe } from "@/lib/consent";
import { createBrowserSupabase } from "@/lib/supabase";
import { getVerifiedUser } from "@/lib/verifiedUser";
import { trackEvent } from "./events";
import { firstThisBrowser, firstThisSession } from "./session";

const SIGNUP_WINDOW_MS = 10 * 60_000;

export function AuthEventTracking() {
  useEffect(() => {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) return;
    const configured = [
      process.env.NEXT_PUBLIC_POSTHOG_KEY,
      process.env.NEXT_PUBLIC_MIXPANEL_TOKEN,
      process.env.NEXT_PUBLIC_GA_ENHANCED_MEASUREMENT_DISABLED === "true"
        ? process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
        : undefined,
    ].some((key) => !!key && key !== "undefined");
    if (!configured) return;
    let allowed = false;
    let epoch = 0;
    let authSub: { unsubscribe: () => void } | null = null;
    let pending: ReturnType<typeof setTimeout> | undefined;

    function cancelPending() {
      epoch++;
      clearTimeout(pending);
    }

    function onSession(user: User) {
      cancelPending();
      pending = setTimeout(() => {
        if (!allowed) return;
        const created = Date.parse(user.created_at);
        const signedIn = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : created;
        const signup = signedIn - created < 60_000 && Date.now() - created < SIGNUP_WINDOW_MS;
        const first = signup ? firstThisBrowser(`mp_signup:${user.id}`) : firstThisSession(`mp_login:${user.id}`);
        if (!first) return;
        trackEvent(signup ? "signup_completed" : "logged_in", {
          method: user.app_metadata?.provider ?? "email",
        });
      }, 0);
    }

    function update(next: boolean) {
      allowed = next;
      if (!allowed) {
        cancelPending();
        authSub?.unsubscribe();
        authSub = null;
        return;
      }
      if (authSub) return;
      const supabase = createBrowserSupabase();
      const initialEpoch = epoch;
      void getVerifiedUser(supabase).then((user) => {
        if (user && allowed && epoch === initialEpoch) onSession(user);
      }).catch(() => {});
      authSub = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session?.user && allowed) onSession(session.user);
        else if (event === "SIGNED_OUT") cancelPending();
      }).data.subscription;
    }

    update(hasAnalyticsConsent());
    const unsubscribe = subscribe((state) => update(allowsAnalytics(state)));
    return () => {
      update(false);
      unsubscribe();
    };
  }, []);
  return null;
}
