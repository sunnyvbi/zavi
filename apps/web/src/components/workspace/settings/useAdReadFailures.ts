"use client";

const PLATFORM_TO_SLUG: Record<string, string> = {
  meta: "meta_ads",
  google: "google_ads",
  reddit: "reddit_ads",
  x: "x_ads",
  tiktok: "tiktok_ads",
  pinterest: "pinterest_ads",
  snapchat: "snapchat_ads",
  microsoft: "microsoft_ads",
  apple: "apple_ads",
  spotify: "spotify_ads",
  linkedin: "linkedin_ads",
};

import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";

export type AdReadFailures = {
  failed: Record<string, string>;
  slow: Record<string, string>;
  status: "loading" | "ok" | "error";
};

export function useAdReadFailures(reloadKey = 0): AdReadFailures {
  const [state, setState] = useState<AdReadFailures>({ failed: {}, slow: {}, status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ failed: {}, slow: {}, status: "loading" });
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setState({ failed: {}, slow: {}, status: "error" });
          return;
        }
        const { data, error } = await sb
          .from("ad_budgets")
          .select("read_failed, read_failure_kinds")
          .eq("tenant_id", tenantId)
          .eq("status", "active");
        if (cancelled) return;
        if (error) {
          setState({ failed: {}, slow: {}, status: "error" });
          return;
        }
        if (!cancelled) setState({ ...adReadFlags((data ?? []) as AdBudgetReadRow[], Date.now()), status: "ok" });
      } catch {
        if (!cancelled) setState({ failed: {}, slow: {}, status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  return state;
}

const READ_SLOW_MS = 3 * 3_600_000;

export type AdBudgetReadRow = {
  read_failed: Record<string, string> | null;
  read_failure_kinds?: Record<string, string> | null;
};

export function adReadFlags(rows: readonly AdBudgetReadRow[], now: number): Pick<AdReadFailures, "failed" | "slow"> {
  const failed: Record<string, string> = {};
  const slow: Record<string, string> = {};
  for (const row of rows) {
    for (const [platform, since] of Object.entries(row.read_failed ?? {})) {
      const slug = PLATFORM_TO_SLUG[platform];
      if (!slug || typeof since !== "string" || !since) continue;
      const kind = row.read_failure_kinds?.[platform];
      if (kind === "disconnected") continue;
      const login = kind === "auth" || kind === "account_gone";
      if (!login && !(now - Date.parse(since) >= READ_SLOW_MS)) continue;
      const out = login ? failed : slow;
      if (!out[slug] || since < out[slug]) out[slug] = since;
    }
  }
  for (const slug of Object.keys(failed)) delete slow[slug];
  return { failed, slow };
}

export function readSlowReason(label: string): string {
  return `${label} hasn't answered for 3 hours. Zavi keeps trying; budget raises on ${label} wait until it reads again.`;
}

export function readFailedReason(sinceIso: string): string {
  const d = new Date(sinceIso);
  const when = Number.isNaN(d.getTime())
    ? ""
    : ` since ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d)}`;
  return `Zavi could not read this account's spend${when}, so it may not be counted against your ad budget. Reconnecting usually fixes this.`;
}
