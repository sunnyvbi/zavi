"use client";

import { useState } from "react";
import { useSetupOptional } from "./SetupProvider";

export function SetupLoadError() {
  const ctx = useSetupOptional();
  const [retrying, setRetrying] = useState(false);
  if (!ctx || !ctx.loadError || ctx.state !== null || !ctx.canManageSetup) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rule p-4 text-sm text-ink">
      <span className="flex-1">Couldn&apos;t load your setup. Try again.</span>
      <button
        type="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          try { await ctx.refresh(); } finally { setRetrying(false); }
        }}
        className="rounded-cta border border-rule px-3 py-1.5 font-semibold hover:bg-creamDeep disabled:opacity-50"
      >
        {retrying ? "Retrying..." : "Retry"}
      </button>
    </div>
  );
}
