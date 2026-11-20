
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { isCreatorPath, plainNext } from "@/lib/safe-next";
import { AuthShell } from "@/components/auth/AuthShell";
import { AUTH_BODY, AUTH_H1, AUTH_SUBMIT } from "@/components/auth/authUi";
import { callbackFailure, type CallbackFailure } from "@/app/login/authMessages";

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<Shell><Status>Signing you in…</Status></Shell>}>
      <CallbackInner />
    </Suspense>
  );
}

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<CallbackFailure | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const supabase = createBrowserSupabase();
    const next = plainNext(params.get("next")) ?? "/start";
    const initialHash = typeof window !== "undefined" ? window.location.hash : "";

    if (typeof window !== "undefined") {
      const clean = new URL(window.location.href);
      const before = clean.toString();
      for (const k of ["token_hash", "type", "code", "access_token", "refresh_token", "error", "error_code", "error_description"]) {
        clean.searchParams.delete(k);
      }
      clean.hash = "";
      if (clean.toString() !== before) {
        window.history.replaceState(null, "", clean.toString());
      }
    }

    async function settleThenGo(dest: string) {
      for (let i = 0; i < 20; i++) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.replace(dest);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Sign-in did not complete. Request a new link to try again.");
    }

    async function go() {
      try {
        const hashParams = new URLSearchParams(initialHash.replace(/^#/, ""));
        const urlError =
          hashParams.get("error_description") ??
          hashParams.get("error") ??
          params.get("error_description") ??
          params.get("error");
        if (urlError) {
          setError(callbackFailure(urlError));
          return;
        }

        if (initialHash) {
          const hash = initialHash.startsWith("#") ? initialHash.slice(1) : initialHash;
          const usp = new URLSearchParams(hash);
          const access_token = usp.get("access_token");
          const refresh_token = usp.get("refresh_token");
          if (access_token && refresh_token) {
            const { error: e } = await supabase.auth.setSession({ access_token, refresh_token });
            if (e) throw new Error(e.message);
            await settleThenGo(next);
            return;
          }
        }

        const code = params.get("code");
        if (code) {
          const { error: e } = await supabase.auth.exchangeCodeForSession(code);
          if (e) throw new Error(e.message);
          await settleThenGo(next);
          return;
        }

        const token_hash = params.get("token_hash");
        const type = params.get("type");
        if (token_hash && type) {
          const { error: e } = await supabase.auth.verifyOtp({
            token_hash,
            type: type as
              | "recovery"
              | "magiclink"
              | "signup"
              | "invite"
              | "email_change"
              | "email",
          });
          if (e) throw new Error(e.message);
          await settleThenGo(next);
          return;
        }

        setError(callbackFailure("No auth payload in URL."));
      } catch (e) {
        setError(callbackFailure(e));
      }
    }
    go();
  }, [params, router]);

  if (error) {
    return (
      <Shell>
        <h1 className={AUTH_H1}>Sign-in failed</h1>
        <p className={AUTH_BODY}>{error.message}</p>
        <a href={creatorTryAgain(params.get("next"))} className={AUTH_SUBMIT}>
          {error.action}
        </a>
      </Shell>
    );
  }
  return (
    <Shell>
      <Status>Signing you in…</Status>
    </Shell>
  );
}

function creatorTryAgain(raw: string | null): string {
  const next = plainNext(raw);
  return isCreatorPath(next) ? `/creators/login?next=${encodeURIComponent(next as string)}` : "/login";
}

function Shell({ children }: { children: React.ReactNode }) {
  return <AuthShell panel={false}>{children}</AuthShell>;
}

function Status({ children }: { children: React.ReactNode }) {
  return (
    <p className={`flex items-center justify-center gap-2.5 text-center ${AUTH_BODY}`}>
      <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[#8c8c8c]" />
      {children}
    </p>
  );
}
