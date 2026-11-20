"use client";

import { useEffect } from "react";

import { createBrowserSupabase } from "@/lib/supabase";

export function SignedOutGuard() {
  useEffect(() => {
    const sb = createBrowserSupabase();
    let left = false;
    let active = true;
    const leave = () => {
      if (left || !active) return;
      left = true;
      window.location.replace("/login");
    };
    const check = async () => {
      const { data, error } = await sb.auth.getSession();
      if (!data.session && !error) leave();
    };
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted) document.documentElement.style.visibility = "hidden";
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    const { data: sub } = sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") leave();
    });
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    void check();
    return () => {
      active = false;
      sub.subscription.unsubscribe();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return null;
}
