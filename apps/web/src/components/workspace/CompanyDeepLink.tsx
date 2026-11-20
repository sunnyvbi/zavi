"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { switchToTenantDetailed } from "@/lib/workspace/tenantSwitch";

const PARAM = "company";
const MUTE_PARAM = "mute_alert";

function withoutParam(also: string[] = []): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM);
  for (const p of also) url.searchParams.delete(p);
  return url.pathname + (url.search ? url.search : "") + url.hash;
}

export function CompanyDeepLink({ holder = false }: { holder?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  useEffect(() => {
    const wanted = new URL(window.location.href).searchParams.get(PARAM);
    if (!wanted) return;
    let cancelled = false;
    void (async () => {
      const current = await getActiveTenantId(createBrowserSupabase()).catch(() => null);
      if (cancelled) return;
      if (current === wanted) {
        window.history.replaceState(null, "", withoutParam());
        return;
      }
      const result = await switchToTenantDetailed(wanted).catch(() => "not_converged" as const);
      if (cancelled) return;
      if (result !== "not_converged") {
        const url = new URL(window.location.href);
        const muting = url.searchParams.has(MUTE_PARAM);
        if (result === "ok" && muting) {
          window.location.replace(url.pathname + url.search + url.hash);
          return;
        }
        window.location.replace(withoutParam(result === "refused" ? [MUTE_PARAM] : []));
        return;
      }
      setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!holder) return null;
  if (!failed) return <p role="status">Opening that company…</p>;
  const signOut = async () => {
    const res = await createBrowserSupabase().auth.signOut({ scope: "local" }).catch((e: unknown) => ({ error: e }));
    if (res?.error) {
      setSignOutFailed(true);
      return;
    }
    window.location.replace("/login");
  };
  return (
    <div role="status" className="flex flex-col items-center gap-3 text-center">
      <p>Couldn&apos;t open that company. Try the link again, or sign out and sign back in.</p>
      {signOutFailed ? <p>Couldn&apos;t sign you out. Try again.</p> : null}
      <button
        type="button"
        onClick={() => void signOut()}
        className="rounded-cta border border-rule bg-cream px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-creamDeep"
      >
        Sign out
      </button>
    </div>
  );
}
