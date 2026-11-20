"use client";

import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { resetAnalyticsIdentity } from "@/lib/analytics/mixpanel";
import { trackEvent } from "@/lib/analytics/events";

type Variant = "workspace" | "marketing" | "creator";

export function UserMenu({
  email,
  variant = "workspace",
  compact = false,
}: {
  email: string;
  variant?: Variant;
  compact?: boolean;
}) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      trackEvent("logged_out");
      resetAnalyticsIdentity();
      const supabase = createBrowserSupabase();
      await supabase.auth.signOut({ scope: "local" });
      window.location.replace(isCreator ? "/creators/login" : "/login");
    } finally {
      setSigningOut(false);
    }
  }

  const handle = email.includes("@") ? email.split("@")[0] || email : email;

  const isMarketing = variant === "marketing";
  const isCreator = variant === "creator";
  const avatarOnly = isMarketing && compact;
  const summaryCls = isMarketing
    ? `cursor-pointer list-none inline-flex size-10 items-center justify-center gap-2 rounded-full border border-ink/15 bg-white p-0 text-[16px] font-medium text-ink/80 hover:border-ink/40 hover:text-ink transition-colors select-none ${
        avatarOnly ? "" : "sm:size-auto sm:justify-start sm:px-3.5 sm:py-2"
      }`
    : isCreator
      ? "cursor-pointer list-none inline-flex items-center gap-1 rounded-full border border-border bg-white px-3 py-1 text-[12px] font-semibold text-foreground select-none"
      : "cursor-pointer list-none inline-flex items-center gap-2 rounded-md border border-ink/10 bg-white px-2 py-1 text-[12px] text-inkMuted hover:border-ink/25 hover:text-ink transition-colors select-none";
  const handleMaxW = isMarketing ? "max-w-[140px]" : "max-w-[120px]";
  const caretCls = isMarketing ? "text-ink/40" : "text-inkMuted";
  const dropdownCls = isMarketing
    ? "absolute right-0 top-full mt-2 z-50 w-[min(15rem,calc(100vw-2rem))] min-w-[240px] max-w-[calc(100vw-2rem)] rounded-xl border border-ink/10 bg-white shadow-lg p-1.5"
    : "absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-ink/10 bg-white shadow-lg p-1.5";
  const dropdownHeaderCls = isMarketing
    ? "px-3 py-2 border-b border-ink/10 mb-1"
    : "px-2.5 py-2 border-b border-ink/10 mb-1";
  const kickerCls = isMarketing
    ? "text-[11px] font-mono uppercase tracking-[0.16em] text-ink/40"
    : "text-[11px] font-mono uppercase tracking-[0.14em] text-inkMuted";
  const emailCls = isMarketing
    ? "text-[13px] text-ink truncate"
    : "text-[13px] text-ink truncate";
  const signOutBtnCls = isMarketing
    ? "w-full text-left px-3 py-2 rounded-lg text-[13px] text-ink/80 hover:bg-cream hover:text-violet transition-colors disabled:opacity-50"
    : "w-full text-left px-2.5 py-1.5 rounded-md text-[13px] text-ink hover:bg-bone hover:text-ink disabled:opacity-50";

  const initial = (handle[0] ?? "?").toUpperCase();

  return (
    <details className="relative group">
      <summary className={summaryCls} aria-label="Account menu">
        {isMarketing && (
          <span aria-hidden="true" className={`text-[14px] font-semibold text-ink ${avatarOnly ? "" : "sm:hidden"}`}>
            {initial}
          </span>
        )}
        <span className={`truncate ${handleMaxW} ${avatarOnly ? "hidden" : isMarketing ? "hidden sm:inline" : ""}`}>{handle}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`${caretCls} ${avatarOnly ? "hidden" : isMarketing ? "hidden sm:block" : ""}`}>
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className={dropdownCls}>
        <div className={dropdownHeaderCls}>
          <div className={kickerCls}>Signed in as</div>
          <div className={emailCls}>{email}</div>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className={signOutBtnCls}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </details>
  );
}
