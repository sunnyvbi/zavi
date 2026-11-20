"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { trackEvent } from "@/lib/analytics/events";
import { isMember } from "@/lib/members";
import { PRICING_FALLBACK, fetchLivePricingClient } from "@/lib/marketing/pricing";
import { lockedTierOf, type LockTier } from "@/lib/workspace/planUpgrade";
import { startPlanCheckout } from "@/lib/workspace/planCheckout";
import { cn } from "@/lib/cn";
import { useWorkspace } from "./WorkspaceShell";

type PaidTier = Exclude<LockTier, "free">;

const PLAN_NAME: Record<PaidTier, string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

function planPrice(tiers: typeof PRICING_FALLBACK.tiers, tier: PaidTier): number | null {
  return tiers.find((t) => t.slug === tier)?.usd ?? null;
}

export function ProPlanGate({
  slug,
  lockedTier: lockedTierProp,
  feature,
  children,
}: {
  slug?: string;
  lockedTier?: PaidTier | null;
  feature: string;
  children: ReactNode;
}) {
  const { role, treeAgents, tenantId } = useWorkspace();
  const tier =
    lockedTierProp !== undefined
      ? lockedTierProp
      : lockedTierOf(treeAgents.find((a) => a.slug === slug));
  const locked = tier !== null;
  const plan = tier ?? "pro";
  const contentRef = useRef<HTMLDivElement>(null);
  const [price, setPrice] = useState(() => planPrice(PRICING_FALLBACK.tiers, plan));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (locked) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [locked]);

  useEffect(() => {
    if (!locked) return;
    setPrice(planPrice(PRICING_FALLBACK.tiers, plan));
    let cancelled = false;
    void fetchLivePricingClient().then((p) => {
      if (!cancelled) setPrice(planPrice(p.tiers, plan));
    });
    return () => {
      cancelled = true;
    };
  }, [locked, plan]);

  const upgrade = async () => {
    if (busy) return;
    trackEvent("pricing_plan_selected", { tier: plan, term: "monthly", location: "paywall", tenant_id: tenantId });
    setBusy(true);
    setError(null);
    const failure = await startPlanCheckout(plan);
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const canUpgrade = !isMember(role);

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={contentRef}
        aria-hidden={locked || undefined}
        className={cn(
          "h-full min-h-0",
          locked && "pointer-events-none select-none blur-[3px]",
        )}
      >
        {children}
      </div>
      {locked && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-cream/70 px-6">
          {canUpgrade ? (
            <button
              type="button"
              onClick={() => void upgrade()}
              disabled={busy}
              className="flex max-w-sm flex-col items-center gap-2 rounded-2xl border border-rule bg-cream px-6 py-6 text-center shadow-pop transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-wait"
            >
              <NoticeBody feature={feature} plan={PLAN_NAME[plan]} price={price} />
              <span className="mt-2 inline-flex h-9 items-center rounded-[10px] bg-ink px-4 text-[16px] font-semibold text-cream">
                {busy ? "Opening checkout…" : `Upgrade to ${PLAN_NAME[plan]}`}
              </span>
            </button>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-2 rounded-2xl border border-rule bg-cream px-6 py-6 text-center shadow-pop">
              <NoticeBody feature={feature} plan={PLAN_NAME[plan]} price={price} />
              <span className="mt-1 text-[13px] text-inkMuted">
                Ask a workspace owner or admin to upgrade.
              </span>
            </div>
          )}
          {error && (
            <p role="alert" className="max-w-sm text-center text-[13px] text-inkMuted">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NoticeBody({ feature, plan, price }: { feature: string; plan: string; price: number | null }) {
  return (
    <>
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-bone text-ink">
        <Lock className="h-[18px] w-[18px]" aria-hidden />
      </span>
      {}
      <span className="font-display text-[16px] text-ink">
        {feature} is a {plan} feature
      </span>
      <span className="text-[13px] text-inkMuted">
        {price === null
          ? `Upgrade to ${plan} to open it.`
          : `Upgrade to ${plan}, $${price} a month, to open it.`}
      </span>
    </>
  );
}
