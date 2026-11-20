"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

export const SEARCH_HOLD_LINE = "Your site is live. Google won't list it until you check it.";
export const SEARCH_HOLD_FAILED = "That didn't save. Try again.";

export function SearchHoldNote({ siteId, onReleased }: { siteId: string; onReleased?: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "done" | "failed">("idle");
  if (state === "done") return null;
  const release = async () => {
    if (state === "saving") return;
    setState("saving");
    try {
      const res = await apiFetch(`/api/workspace/autopilot/sites/${encodeURIComponent(siteId)}/looks-good`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
      onReleased?.();
    } catch {
      setState("failed");
    }
  };
  return (
    <div
      data-testid="search-hold-note"
      role="status"
      className="absolute left-1/2 top-14 z-20 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-rule bg-cream py-1 pl-3 pr-1 text-[12px] leading-4 text-inkSoft shadow-sm"
    >
      <span className="min-w-0">{state === "failed" ? SEARCH_HOLD_FAILED : SEARCH_HOLD_LINE}</span>
      <button
        type="button"
        data-testid="search-hold-release"
        onClick={() => void release()}
        disabled={state === "saving"}
        className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-3 text-[12px] font-semibold text-cream disabled:opacity-60"
      >
        {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
        Looks good
      </button>
    </div>
  );
}
