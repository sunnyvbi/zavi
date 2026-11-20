"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { getVerifiedUser } from "@/lib/verifiedUser";

export function useActiveTenant(): string | null | undefined {
  const [tid, setTid] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const sb = createBrowserSupabase();

    const resolve = async () => {
      const user = await getVerifiedUser(sb);
      if (cancelled) return;
      if (!user) return;
      const v = await getActiveTenantId(sb);
      if (!cancelled) setTid(v);
    };

    void resolve();
    const { data: sub } = sb.auth.onAuthStateChange(() => {
      void resolve();
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return tid;
}
