
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";

type Status =
  | { kind: "loading" }
  | { kind: "missing_key" }
  | { kind: "submitting" }
  | { kind: "already_tenanted" }
  | { kind: "success" }
  | { kind: "error"; code: string; message: string };

export default function InviteBetaPage() {
  return (
    <Suspense fallback={<Shell><Spinner /></Shell>}>
      <InviteBetaInner />
    </Suspense>
  );
}

function InviteBetaInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const key = searchParams.get("key");
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const redeem = useCallback(
    async (k: string) => {
      setStatus({ kind: "submitting" });
      try {
        const res = await apiFetch("/api/beta/redeem-secret", {
          method: "POST",
          body: JSON.stringify({ key: k }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: { code?: string; message?: string } }
            | null;
          const code = body?.error?.code ?? "unknown";
          const message = body?.error?.message ?? "Could not redeem invite.";
          setStatus({ kind: "error", code, message });
          return;
        }
        setStatus({ kind: "success" });
        router.replace("/start");
      } catch (e) {
        setStatus({
          kind: "error",
          code: "network",
          message: (e as Error).message || "Network error.",
        });
      }
    },
    [router],
  );

  useEffect(() => {
    if (!key) {
      setStatus({ kind: "missing_key" });
      return;
    }
    const supabase = createBrowserSupabase();
    let cancelled = false;

    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData?.user) {
        const next = encodeURIComponent("/invite/beta?key=" + key);
        router.replace(`/login?next=${next}`);
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("active_tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (!cancelled && profile?.active_tenant_id) {
        setStatus({ kind: "already_tenanted" });
        return;
      }
      if (!cancelled) await redeem(key);
    })();

    return () => {
      cancelled = true;
    };
  }, [key, redeem, router]);

  if (status.kind === "loading" || status.kind === "submitting") {
    return (
      <Shell>
        <Spinner />
        <p className="mt-4 text-base text-[#525252]">Checking your invite…</p>
      </Shell>
    );
  }
  if (status.kind === "missing_key") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Invalid invite link</h1>
        <p className="mt-2 text-base text-[#525252]">
          The invite URL is missing the key parameter.
        </p>
        <CTA href="/talk-to-team" label="Book a call" />
      </Shell>
    );
  }
  if (status.kind === "already_tenanted") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">You already have a workspace</h1>
        <p className="mt-2 text-base text-[#525252]">
          You&apos;re already onboarded. No need to redeem this invite.
        </p>
        <CTA href="/workspace" label="Open workspace" />
      </Shell>
    );
  }
  if (status.kind === "success") {
    return (
      <Shell>
        <Spinner />
        <p className="mt-4 text-base text-[#525252]">Redirecting to onboarding…</p>
      </Shell>
    );
  }
  const errText =
    status.code === "invite_invalid"
      ? "This invite link is invalid. It may have been rotated by the Zavi team."
      : status.code === "invite_unavailable"
        ? "Invite redemption is currently disabled. Contact the Zavi team."
        : status.message;
  return (
    <Shell>
      <h1 className="text-xl font-semibold">Couldn&apos;t redeem your invite</h1>
      <p className="mt-2 text-base text-[#525252]">{errText}</p>
      <CTA href="/talk-to-team" label="Book a call" />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-md px-6 py-24 text-center text-[#171717]">
        {children}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-[#171717] border-t-transparent" />
  );
}

function CTA({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mt-6 inline-flex items-center justify-center rounded-full bg-[#171717] px-4 py-2.5 text-base font-medium text-white transition-colors hover:bg-[#404040]"
    >
      {label}
    </Link>
  );
}
