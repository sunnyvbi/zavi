"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { TENANT_DISABLED_EVENT, TENANT_DISABLED_MESSAGE } from "@/lib/tenantDisabled";

export function TenantDisabledNotice() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const on = () => setShown(true);
    window.addEventListener(TENANT_DISABLED_EVENT, on);
    return () => window.removeEventListener(TENANT_DISABLED_EVENT, on);
  }, []);
  if (!shown) return null;

  async function signOut() {
    await createBrowserSupabase().auth.signOut({ scope: "local" }).catch(() => undefined);
    window.location.assign("/login");
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tenant-disabled-title"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-2xl">
        <h2 id="tenant-disabled-title" className="text-lg font-semibold text-gray-900">
          Workspace disabled
        </h2>
        <p className="mt-2 text-sm text-gray-700">{TENANT_DISABLED_MESSAGE}</p>
        <button
          type="button"
          onClick={signOut}
          className="mt-5 h-12 w-full rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-800"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
