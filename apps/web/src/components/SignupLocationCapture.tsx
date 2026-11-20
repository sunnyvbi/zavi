"use client";
import { useEffect } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import {
  deliverSignupLocation,
  prepareSignupLocation,
} from "@/lib/signup-location";
export function SignupLocationCapture() {
  useEffect(() => {
    const sb = createBrowserSupabase();
    let stopped = false;
    const seen = new Set<string>();
    const capture = (
      session: {
        user: { id: string; email?: string; created_at: string };
        access_token: string;
      } | null,
    ) => {
      if (
        !session?.user.email ||
        seen.has(session.user.id) ||
        Date.now() - Date.parse(session.user.created_at) > 60000
      )
        return;
      seen.add(session.user.id);
      setTimeout(() => {
        if (stopped) return;
        void prepareSignupLocation(session.user.email!).then((ticket) => {
          if (ticket && !stopped)
            return deliverSignupLocation(
              session.user.id,
              ticket,
              session.access_token,
            );
        });
      }, 0);
    };
    void sb.auth
      .getSession()
      .then(({ data }) => {
        if (!stopped) capture(data.session);
      })
      .catch(() => {});
    const { data } = sb.auth.onAuthStateChange((_event, session) =>
      capture(session),
    );
    return () => {
      stopped = true;
      data.subscription.unsubscribe();
    };
  }, []);
  return null;
}
