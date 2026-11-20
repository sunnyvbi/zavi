"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserAdminSupabase } from "@/lib/supabase-admin";
import { adminApiFetch } from "@/lib/api-admin";

export const ADMIN_DENIAL_KEY = "zavi.admin.denied";

export function AdminGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = createBrowserAdminSupabase();
      const { data } = await sb.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        setSignedIn(false);
        router.replace("/login");
        return;
      }

      let probe: Response | null = null;
      try {
        probe = await adminApiFetch("/api/admin/whoami");
      } catch {
        probe = null;
      }
      if (cancelled) return;
      if (probe && (probe.status === 401 || probe.status === 403)) {
        const body = (await probe.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        try {
          window.sessionStorage.setItem(
            ADMIN_DENIAL_KEY,
            body.error?.code === "not_staff"
              ? "This account is not a Zavi admin. Customer accounts sign in at zaviagent.com/login."
              : (body.error?.message ?? "Admin access denied."),
          );
        } catch {
        }
        await sb.auth.signOut({ scope: "local" });
        if (cancelled) return;
        setSignedIn(false);
        router.replace("/login");
        return;
      }

      setSignedIn(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (signedIn === null) {
    return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  }
  if (!signedIn) return null;
  return <>{children}</>;
}
