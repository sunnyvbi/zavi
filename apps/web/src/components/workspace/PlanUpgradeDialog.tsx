"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { trackEvent } from "@/lib/analytics/events";
import { isMember } from "@/lib/members";
import {
  PRICING_FALLBACK,
  fetchLivePricingClient,
  termChargeUsd,
  type BillingTerm,
  type LivePricing,
} from "@/lib/marketing/pricing";
import { planBadgeLabel, type LockTier } from "@/lib/workspace/planUpgrade";
import { upgradeHash } from "@/lib/workspace/pendingPlan";
import { useWorkspace } from "./WorkspaceShell";

type PaidTier = Exclude<LockTier, "free">;

const TIER_NAME: Record<PaidTier, string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

export type PlanWork = {
  total: number;
  channels: number;
  company: string | null;
  clicked?: { name: string; count: number };
};

const nActions = (n: number) => `${n} ${n === 1 ? "action" : "actions"}`;

const nf = new Intl.NumberFormat("en-US");

function chargeLine(pricing: LivePricing, tier: PaidTier, term: BillingTerm): string | null {
  const t = pricing.tiers.find((x) => x.slug === tier);
  if (!t) return null;
  const charge = nf.format(termChargeUsd(t, term));
  return term === "6mo"
    ? `$${charge} billed today for ${pricing.sixMonthMonths} months ($${nf.format(t.sixMonthPerMonthUsd)}/mo)`
    : `$${charge} billed today, then $${nf.format(t.usd)} every month`;
}

export function PlanUpgradeDialog({
  feature,
  tier,
  title,
  work,
  onGoToPlans,
  onClose,
}: {
  feature: string;
  tier: PaidTier;
  title?: string;
  work?: PlanWork;
  onGoToPlans?: (term: BillingTerm) => void;
  onClose: () => void;
}) {
  const { role, tenantId } = useWorkspace();
  const canUpgrade = !isMember(role);
  const [pricing, setPricing] = useState<LivePricing>(PRICING_FALLBACK);
  const [term, setTerm] = useState<BillingTerm>("6mo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = TIER_NAME[tier];
  const leadsWithWork = Boolean(work && work.total > 0);
  const heading =
    leadsWithWork && work
      ? `${nActions(work.total)} ready for you`
      : (title ?? `${feature} is on the ${planBadgeLabel(tier)}`);

  useEffect(() => {
    let cancelled = false;
    void fetchLivePricingClient().then((p) => {
      if (!cancelled) setPricing(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const sixMonthOk = pricing.sixMonthAvailable;
  const chosenTerm: BillingTerm = sixMonthOk ? term : "monthly";
  const charge = chargeLine(pricing, tier, chosenTerm);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const upgrade = () => {
    if (busy) return;
    trackEvent("pricing_plan_selected", { tier, term: chosenTerm, location: "paywall", tenant_id: tenantId });
    if (onGoToPlans) {
      onGoToPlans(chosenTerm);
      return;
    }
    setBusy(true);
    window.location.assign(`/workspace?tab=settings#${upgradeHash({ tier, term: chosenTerm })}`);
  };

  return (
    <div
      className="dialog-scrim fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={leadsWithWork ? heading : (title ?? `${feature} needs the ${planBadgeLabel(tier)}`)}
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex w-full max-w-sm flex-col items-center gap-2 rounded-2xl border border-rule bg-cream px-6 py-6 text-center shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-bone text-ink">
          <Lock className="h-[18px] w-[18px]" aria-hidden />
        </span>
        {}
        <span className="font-display text-[16px] text-ink">{heading}</span>
        <span className="text-[13px] text-inkMuted">
          {leadsWithWork ? `Upgrade to ${name} to see them.` : `Upgrade to ${name} to open it.`}
        </span>
        {sixMonthOk && (
        <div role="group" aria-label="Billing period" className="mt-1 flex items-center gap-1 rounded-full bg-bone p-1">
          {(["monthly", "6mo"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={chosenTerm === t}
              disabled={busy}
              onClick={() => setTerm(t)}
              className={`rounded-full px-3 py-1 text-[13px] text-ink ${chosenTerm === t ? "bg-cream font-semibold" : "font-medium"}`}
            >
              {t === "6mo" ? `${pricing.sixMonthMonths} months` : "Monthly"}
            </button>
          ))}
        </div>
        )}
        {charge && (
          <span data-testid="plan-upgrade-charge" className="text-[13px] font-medium text-ink">
            {charge}
          </span>
        )}
        {canUpgrade ? (
          <button
            type="button"
            autoFocus
            onClick={() => void upgrade()}
            disabled={busy}
            className="mt-2 inline-flex h-10 min-h-10 items-center rounded-cta bg-ink px-4 text-[16px] font-semibold text-cream transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-wait"
          >
            {busy
              ? "Opening checkout…"
              : work && leadsWithWork
                ? "See them"
                : `Upgrade to ${name}`}
          </button>
        ) : (
          <span className="mt-1 text-[13px] text-inkMuted">
            Ask a workspace owner or admin to upgrade.
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="mt-1 inline-flex min-h-10 items-center justify-center px-4 text-[13px] text-inkMuted underline-offset-2 hover:underline disabled:opacity-60"
        >
          Not now
        </button>
        {error && (
          <p role="alert" className="text-[13px] text-inkMuted">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
