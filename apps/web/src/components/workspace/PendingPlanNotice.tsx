"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { isMember } from "@/lib/members";
import { isTierSlug, tierDisplayName } from "@/lib/marketing/pricing";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import {
  clearPendingPlan,
  readPendingPlan,
  upgradeHash,
  type PlanChoice,
} from "@/lib/workspace/pendingPlan";
import { useWorkspace } from "./WorkspaceShell";
import { NextChevron } from "@/components/ui/NextChevron";

export function PendingPlanNotice() {
  const { openTab, role } = useWorkspace();
  const canManageBilling = !isMember(role);
  const [choice, setChoice] = useState<PlanChoice | null>(null);

  useEffect(() => {
    if (!canManageBilling) return;
    const pending = readPendingPlan();
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/billing/credits");
        if (cancelled || !res.ok) return;
        const j = (await res.json()) as { tier?: unknown };
        const tier = isTierSlug(j.tier) ? j.tier : null;
        if (tier && tier !== "free") {
          clearPendingPlan();
          return;
        }
        setChoice(pending);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canManageBilling]);

  if (!choice) return null;

  function dismiss() {
    clearPendingPlan();
    setChoice(null);
  }

  function finish() {
    if (!choice) return;
    openBillingSettings(openTab, upgradeHash(choice));
    setChoice(null);
  }

  return (
    <div role="status" className="mx-2 mb-2 shrink-0 rounded-[12px] border border-rule bg-cream p-3 font-sans">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">
          You picked {tierDisplayName(choice.tier)} ({choice.term === "6mo" ? "6 months" : "monthly"}).
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss plan reminder"
          className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkMuted transition-colors hover:bg-creamDeep"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        onClick={finish}
        className="mt-2 flex h-10 w-full items-center justify-center rounded-cta bg-ink px-3 text-[14px] font-semibold leading-5 text-cream transition-colors hover:bg-inkSoft"
      >
        Finish choosing your plan <NextChevron />
      </button>
    </div>
  );
}
