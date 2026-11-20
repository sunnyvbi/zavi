"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { LinkButton } from "@/components/ui/LinkButton";
import type { LivePricing } from "@/lib/marketing/pricing";

export function FreePlanBanner({ pricing, plansUrl, onPlans }: { pricing: LivePricing; plansUrl: string | null; onPlans?: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const starter = pricing.tiers.find((t) => t.slug === "starter")?.name ?? "Starter";
  const growth = pricing.tiers.find((t) => t.slug === "growth")?.name ?? "Growth";
  const pro = pricing.tiers.find((t) => t.slug === "pro")?.name ?? "Pro";
  return (
    <div role="status" className="relative border-y border-sky-200 bg-sky-50 px-4 py-4 sm:rounded-xl sm:border">
      <div className="flex gap-3 pr-8">
        <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">i</span>
        <div className="space-y-1">
          <p className="text-[14px] font-semibold text-neutral-900">Zavi can post and run ads for you on a paid plan</p>
          <p className="text-[13px] text-neutral-700">On Free, Zavi plans and drafts. {starter} adds organic posting, {growth} adds more organic channels, and {pro} adds paid ads, email and SMS.</p>
          <div className="pt-2">
            {plansUrl ? (
              <LinkButton className="h-8 px-3" href={plansUrl}>See plans</LinkButton>
            ) : <Button className="h-8 px-3" onClick={onPlans}>See plans</Button>}
          </div>
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded p-1 text-neutral-500 hover:bg-sky-100 hover:text-neutral-900">×</button>
    </div>
  );
}
