"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LinkButton } from "@/components/ui/LinkButton";
import { liveTier, tierDisplayName } from "@/lib/marketing/pricing";
import { formatCredits, formatDate } from "@/lib/shopify-app-home/format";
import type { ShopifyAppHome, ShopifyBillingTerm } from "@/lib/shopify-app-home/types";
import type { PaidTierSlug } from "@/lib/marketing/pricing";
import { cn } from "@/lib/cn";
import { AppHomeCard, AppHomeCardHeader } from "./AppHomeCard";

const SOURCE_LABEL: Record<string, string> = { shopify: "Billed by Shopify", stripe: "Billed by card", app_store: "Billed by App Store", play_store: "Billed by Google Play", comp: "Complimentary" };

function tierBlurb(includes: string[]): string {
  return includes.find((line) => !line.endsWith(":")) ?? "";
}

function PlanAction({ label, href, onClick, disabled, title }: { label: string; href: string | null; onClick: () => void; disabled: boolean; title?: string }) {
  if (href) return <LinkButton className="h-9 px-3.5" href={href}>{label}</LinkButton>;
  return <Button className="h-9 px-3.5" disabled={disabled} title={title} onClick={onClick}>{label}</Button>;
}

function actionDisabled(data: ShopifyAppHome): { disabled: boolean; title?: string } {
  if (!data.billing.can_manage) return { disabled: true, title: "A linked Zavi owner or admin must change the plan." };
  if (data.billing.billing_lock_reason === "paid_elsewhere") return { disabled: true, title: "Cancel the current paid plan where it was purchased before switching to Shopify billing." };
  if (data.billing.billing_lock_reason === "grandfathered") return { disabled: true, title: "This workspace has a lifetime plan. Contact Zavi before switching it to Shopify billing." };
  if (data.billing.billing_lock_reason === "refund_blocked") return { disabled: true, title: "Shopify billing is unavailable for this workspace. Contact Zavi support." };
  return { disabled: false };
}

function FreePlan({ data, onManage }: { data: ShopifyAppHome; onManage: () => void }) {
  const paid = data.pricing.tiers.filter((t) => t.slug !== "free");
  const action = actionDisabled(data);
  return (
    <div className="space-y-3 px-4 pb-4 pt-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[17px] font-semibold text-neutral-900">{tierDisplayName("free")}</p>
        <p className="text-[13px] text-neutral-700">{formatCredits(data.billing.daily_allowance)} credits a day</p>
      </div>
      <ul className="space-y-2">
        {paid.map((t) => (
          <li key={t.slug} className="rounded-lg border border-neutral-200 px-3 py-2.5">
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="font-semibold text-neutral-900">{t.name}</span>
              <span className="font-semibold text-neutral-900">${t.usd}/mo</span>
            </div>
            <p className="text-[12px] text-neutral-500">{formatCredits(t.monthlyCredits)} credits · {tierBlurb(t.includes)}</p>
          </li>
        ))}
      </ul>
      {data.billing.manage_url ? (
        <LinkButton variant="primary" className="h-9 w-full" href={data.billing.manage_url}>Upgrade</LinkButton>
      ) : (
        <Button variant="primary" className="h-9 w-full" disabled={action.disabled} title={action.title} onClick={onManage}>Upgrade</Button>
      )}
      <p className="text-[12px] text-neutral-500">You approve the charge on Shopify's page. It appears on your Shopify bill.</p>
    </div>
  );
}

function PaidPlan({ data, onManage }: { data: ShopifyAppHome; onManage: () => void }) {
  const tier = liveTier(data.pricing, data.billing.tier);
  const pct = data.billing.credits_total > 0 ? Math.min(100, Math.round((data.billing.credits_used / data.billing.credits_total) * 100)) : 0;
  return (
    <div className="space-y-3 px-4 pb-4 pt-3 text-[13px]">
      <p className="text-[17px] font-semibold text-neutral-900">{tier.name}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <span className="text-neutral-700">Credits used this cycle</span>
          <span className="text-neutral-900">{formatCredits(data.billing.credits_used)} / {formatCredits(data.billing.credits_total)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-neutral-900" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[12px] text-neutral-500">Plus {formatCredits(data.billing.daily_allowance)} free credits every day.</p>
      </div>
      <dl className="space-y-1">
        <div className="flex justify-between"><dt className="text-neutral-700">Renews</dt><dd className="text-neutral-900">{formatDate(data.billing.period_end)}</dd></div>
        {data.billing.source === "shopify" && <div className="flex justify-between"><dt className="text-neutral-700">Charges</dt><dd className="text-neutral-900">On your Shopify bill</dd></div>}
      </dl>
      <PlanAction label="Change plan" href={data.billing.manage_url} onClick={onManage} {...actionDisabled(data)} />
    </div>
  );
}

function PlanChooser({ data, onSubscribe, onClose }: {
  data: ShopifyAppHome;
  onSubscribe: (tier: PaidTierSlug, term: ShopifyBillingTerm) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
}) {
  const firstTier = data.billing.tier === "free" ? "starter" : data.billing.tier as PaidTierSlug;
  const [tier, setTier] = useState<PaidTierSlug>(firstTier);
  const [term, setTerm] = useState<ShopifyBillingTerm>("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = data.pricing.tiers.filter((plan): plan is typeof plan & { slug: PaidTierSlug } => plan.slug !== "free");
  const selected = plans.find((plan) => plan.slug === tier) ?? plans[0];
  const annual = selected.sixMonthUsd * 2;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await onSubscribe(tier, term);
      if (!result.ok) setError(result.message);
    } catch {
      setError("Could not open Shopify billing. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-[14px] font-semibold text-neutral-900">Choose your Zavi plan</p><p className="text-[12px] text-neutral-500">Shopify shows the exact charge before anything starts.</p></div>
        <button type="button" className="rounded p-1 text-neutral-500 hover:bg-neutral-200" aria-label="Close plan chooser" onClick={onClose}>×</button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-neutral-200 p-1">
        {plans.map((plan) => <button key={plan.slug} type="button" onClick={() => setTier(plan.slug)} className={cn("rounded-md px-2 py-2 text-[12px] font-semibold", tier === plan.slug ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-600")}>{plan.name}</button>)}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setTerm("monthly")} className={cn("rounded-lg border p-3 text-left", term === "monthly" ? "border-neutral-900 bg-white" : "border-neutral-200")}>
          <span className="block text-[13px] font-semibold">Monthly</span><span className="text-[12px] text-neutral-500">${selected.usd} every 30 days</span>
        </button>
        <button type="button" onClick={() => setTerm("annual")} className={cn("rounded-lg border p-3 text-left", term === "annual" ? "border-neutral-900 bg-white" : "border-neutral-200")}>
          <span className="block text-[13px] font-semibold">Annual</span><span className="text-[12px] text-neutral-500">${annual}/year · ${Math.round(annual / 12)}/mo</span>
        </button>
      </div>
      <p className="mt-3 text-[12px] text-neutral-600">No trial. {formatCredits(selected.monthlyCredits)} monthly credits, plus the daily grant.</p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <Button variant="primary" className="mt-3 h-9 w-full" disabled={busy} onClick={() => void submit()}>{busy ? "Opening Shopify…" : `Continue with ${selected.name}`}</Button>
    </div>
  );
}

export function PlanCard({ data, onSubscribe }: {
  data: ShopifyAppHome;
  onSubscribe: (tier: PaidTierSlug, term: ShopifyBillingTerm) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [choosing, setChoosing] = useState(false);
  const source = data.billing.source ? SOURCE_LABEL[data.billing.source] : null;
  return (
    <AppHomeCard id="shopify-plan-card">
      <AppHomeCardHeader title="Plan" aside={source && <Badge>{source}</Badge>} />
      {data.billing.tier === "free" ? <FreePlan data={data} onManage={() => setChoosing(true)} /> : <PaidPlan data={data} onManage={() => setChoosing(true)} />}
      {choosing && <PlanChooser data={data} onSubscribe={onSubscribe} onClose={() => setChoosing(false)} />}
    </AppHomeCard>
  );
}
