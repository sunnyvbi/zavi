"use client";

import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { SlackWorkspaceHint } from "@/components/auth/SlackWorkspaceHint";

export function ConnectToSlackButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setSubmitting(true);
    setError(null);
    try {
      const supabase = createBrowserSupabase();
      const next = "/workspace";
      const redirectTo = `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: e } = await supabase.auth.signInWithOAuth({
        provider: "slack_oidc",
        options: { redirectTo },
      });
      if (e) throw new Error(e.message);
    } catch (e2) {
      setError((e2 as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={connect}
        disabled={submitting}
        aria-busy={submitting || undefined}
        className={className}
      >
        {children}
        {submitting ? <span className="ml-1">Redirecting…</span> : null}
      </button>
      {}
      <SlackWorkspaceHint />
      {error && (
        <p role="alert" aria-live="polite" className="text-[13px] text-[#b91c1c]">
          {error}
        </p>
      )}
    </div>
  );
}
