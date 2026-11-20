"use client";

import { useState } from "react";
import { withAffiliateClick } from "@/lib/analytics/affiliate";
import { trackEvent } from "@/lib/analytics/events";
import { apiFetch } from "@/lib/api";
import {
  changePlan,
  classifyPlanChange,
  fmtPlanDate,
  isStoreSource,
  managedElsewhereCopy,
  MANAGED_IN_STORE_COPY,
  resumePlan,
  type SubscriptionState,
} from "@/lib/workspace/billingSubscription";
import { BillingConfirmDialog } from "./BillingConfirmDialog";
import { SixMonthDeal, StruckPrice } from "@/components/marketing/SixMonthDeal";
import {
  FeatureRow,
  PRICING_FEATURES,
  TierCredits,
  taglineFor,
  tierHasFeature,
} from "@/components/marketing/pricingFeatures";
import {
  PRICING_FALLBACK,
  termChargeUsd,
  tierRank,
  type BillingTerm,
  type LivePricing,
  type PaidTierSlug,
  type PlanTier,
  type TierSlug,
} from "@/lib/marketing/pricing";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const BOOK_A_CALL = "/support";

const RECOMMENDED_TIER: TierSlug = "growth";

const nf = new Intl.NumberFormat("en-US");

const BILLING_UNAVAILABLE =
  "Plans aren't available yet: billing isn't switched on for this workspace. Contact support and we'll sort it.";

const SIX_MONTH_UNAVAILABLE =
  "Six-month billing isn't open yet. Choose Monthly, or contact support and we'll set it up.";

type CardCta = {
  label: string;
  current: boolean;
  hidden?: boolean;
  disabled: boolean;
  onClick: () => void;
};

type PendingConfirm = { tier: TierSlug; name: string };

export function UpgradePlanView({
  onBack,
  showBack = false,
  currentTier,
  manageViaPortal = false,
  managedInStore = false,
  subscription = null,
  onSubscriptionChange,
  pricing = PRICING_FALLBACK,
  initialTerm,
  pickedTier,
  tenantId,
}: {
  onBack: () => void;
  showBack?: boolean;
  currentTier: TierSlug | null;
  manageViaPortal?: boolean;
  managedInStore?: boolean;
  subscription?: SubscriptionState | null;
  onSubscriptionChange?: (s: SubscriptionState | null) => void;
  pricing?: LivePricing;
  initialTerm?: BillingTerm;
  pickedTier?: PaidTierSlug;
  tenantId?: string;
}) {
  const [busy, setBusy] = useState<TierSlug | null>(null);
  const [error, setError] = useState<{ tier: TierSlug | null; text: string } | null>(null);
  const [term, setTerm] = useState<BillingTerm>(initialTerm ?? subscription?.term ?? "monthly");
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  const storePlan = managedInStore || isStoreSource(subscription?.source);
  const storeCopy = managedElsewhereCopy(subscription?.source);

  const nameOf = (slug: TierSlug) => pricing.tiers.find((t) => t.slug === slug)?.name ?? slug;
  const periodEnd = fmtPlanDate(subscription?.currentPeriodEnd);

  const planProps = (slug: TierSlug) => {
    const planTerm: BillingTerm = slug === "free" ? "monthly" : term;
    const t = pricing.tiers.find((x) => x.slug === slug);
    return { tier: slug, term: planTerm, amount_usd: t ? termChargeUsd(t, planTerm) : undefined, origin: "workspace", location: "in_app_upgrade", tenant_id: tenantId };
  };

  function refusal(code: string | null | undefined, status: number, message?: string | null): string {
    if (term === "6mo" && (code === "price_not_configured" || code === "price_misconfigured")) {
      return SIX_MONTH_UNAVAILABLE;
    }
    if (code === "price_not_configured") {
      return "Plan changes aren't available yet. Contact support to change your plan.";
    }
    if (status === 503 || code === "billing_not_configured") return BILLING_UNAVAILABLE;
    if (code === "forbidden") return "Only a workspace owner or admin can change the plan.";
    if (code === "managed_in_store") return message ?? MANAGED_IN_STORE_COPY;
    if (code === "pending_change") return "Keep your current plan first, then upgrade.";
    if (code === "network") return "Network error. Please try again.";
    return message ?? "Couldn't change your plan. Please try again.";
  }

  async function start(tier: PaidTierSlug) {
    if (busy) return;
    trackEvent("pricing_plan_selected", planProps(tier));
    setBusy(tier);
    setError(null);
    try {
      const res = await apiFetch(manageViaPortal ? "/api/billing/portal" : "/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify(
          manageViaPortal ? {} : withAffiliateClick({ tier, term, origin: "workspace" }),
        ),
      });
      const j = (await res.json().catch(() => null)) as {
        url?: string;
        redirect?: string;
        error?: { code?: string; message?: string };
      } | null;
      const dest = j?.url ?? j?.redirect;
      if (res.ok && dest) {
        trackEvent(manageViaPortal ? "billing_portal_opened" : "checkout_started", {
          ...planProps(tier),
          flow: "checkout",
        });
        window.location.href = dest;
        return;
      }
      setError({
        tier,
        text: refusal(j?.error?.code, res.status, j?.error?.message ?? "Couldn't start checkout. Please try again."),
      });
      setBusy(null);
    } catch {
      setError({ tier, text: "Network error. Please try again." });
      setBusy(null);
    }
  }

  async function change(tier: TierSlug, fromConfirm = false) {
    if (busy) return;
    if (!fromConfirm) trackEvent("pricing_plan_selected", planProps(tier));
    setBusy(tier);
    if (fromConfirm) setConfirmError(null);
    else setError(null);
    const r = await changePlan(tier, tier === "free" ? "monthly" : term);
    if (r.ok && r.redirect) {
      trackEvent("checkout_started", { ...planProps(tier), flow: "change_plan" });
      window.location.href = r.redirect;
      return;
    }
    setBusy(null);
    if (r.ok) {
      setConfirm(null);
      onSubscriptionChange?.(r.subscription);
      return;
    }
    const msg = refusal(r.code, r.status, r.message);
    if (fromConfirm) setConfirmError(msg);
    else setError({ tier, text: msg });
  }

  async function keepCurrent() {
    if (resuming) return;
    setResuming(true);
    setError(null);
    const r = await resumePlan();
    setResuming(false);
    if (r.ok) onSubscriptionChange?.(r.subscription);
    else setError({ tier: null, text: refusal(r.code, r.status, r.message) });
  }

  function ctaFor(t: PlanTier): CardCta {
    const slug = t.slug;
    if (storePlan) {
      const isCurrent = slug === (subscription?.tier ?? currentTier ?? "free");
      return {
        label: "Current Plan",
        current: true,
        hidden: !isCurrent,
        disabled: true,
        onClick: () => {},
      };
    }
    if (!subscription) {
      const isCurrent = slug === (currentTier ?? "free");
      const selectable = tierRank(slug) > tierRank(currentTier ?? "free");
      return {
        label: isCurrent ? "Current Plan" : busy === slug ? "Starting…" : `Start ${t.name}`,
        current: isCurrent,
        disabled: !selectable || busy !== null,
        onClick: () => slug !== "free" && start(slug as PaidTierSlug),
      };
    }
    const targetTerm: BillingTerm = slug === "free" ? "monthly" : term;
    const kind = classifyPlanChange(
      { tier: subscription.tier, term: subscription.term },
      { tier: slug, term: targetTerm },
    );
    if (kind === "same") {
      return { label: "Current Plan", current: true, disabled: true, onClick: () => {} };
    }
    const sc = subscription.scheduledChange;
    const alreadyScheduled =
      (slug === "free" && subscription.cancelAtPeriodEnd) ||
      (sc !== null && sc.tier === slug && (sc.term ?? "monthly") === targetTerm);
    if (alreadyScheduled) {
      const when = fmtPlanDate(sc?.effectiveAt) ?? periodEnd;
      return { label: when ? `Starts ${when}` : "Scheduled", current: false, disabled: true, onClick: () => {} };
    }
    const sameTier = slug === subscription.tier;
    const label =
      busy === slug
        ? kind === "upgrade"
          ? "Opening…"
          : "Scheduling…"
        : sameTier
          ? `Switch to ${targetTerm === "6mo" ? `${pricing.sixMonthMonths} months` : "monthly"}`
          : `${kind === "upgrade" ? "Upgrade" : "Downgrade"} to ${t.name}`;
    return {
      label,
      current: false,
      disabled: busy !== null,
      onClick: () => {
        if (kind === "upgrade") void change(slug);
        else {
          trackEvent("pricing_plan_selected", planProps(slug));
          setConfirmError(null);
          setConfirm({ tier: slug, name: t.name });
        }
      },
    };
  }

  const pendingLine = !subscription
    ? null
    : subscription.cancelAtPeriodEnd
      ? `Your ${nameOf(subscription.tier)} plan ends${periodEnd ? ` on ${periodEnd}` : ""}. You'll move to Free after that.`
      : subscription.scheduledChange
        ? `Your plan changes to ${nameOf(subscription.scheduledChange.tier)}${
            fmtPlanDate(subscription.scheduledChange.effectiveAt)
              ? ` on ${fmtPlanDate(subscription.scheduledChange.effectiveAt)}`
              : " when this period ends"
          }.`
        : null;

  return (
    <div className="font-sans">
      {}
      <div className="relative flex items-start">
        {showBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Billing & Credits"
          className="absolute left-0 top-0 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#f0f0f0] bg-white text-[#0e0f11] transition-colors hover:bg-[#f6f6f6]"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M19 12H5m0 0 7 7m-7-7 7-7" />
          </svg>
        </button>
        )}
        <h2 className="w-full px-12 pt-4 text-center text-[24px] font-bold leading-[34px] tracking-[-0.2px] text-[#0e0f11]">
          The Growth Agent you need
        </h2>
      </div>

      {storePlan && (
        <p
          className="mt-5 rounded-[16px] border border-[#f0f0f0] bg-[#f9f9f9] px-4 py-3 text-[14px] leading-5 text-[#595959]"
          role="status"
        >
          {storeCopy}
        </p>
      )}

      {}
      {!storePlan && (
      <div className="mt-4 flex justify-center">
        <div
          role="group"
          aria-label="Billing period"
          className="flex items-center gap-1 rounded-full bg-[#f1f1f1] p-1"
        >
          <TermSegment active={term === "monthly"} onClick={() => setTerm("monthly")}>
            Monthly
          </TermSegment>
          <TermSegment active={term === "6mo"} onClick={() => setTerm("6mo")}>
            {`${pricing.sixMonthMonths} Months`}
            <span className="rounded-full bg-[#027bff] px-2 py-0.5 text-[11px] font-bold leading-4 text-white">
              {`${pricing.sixMonthDiscountPct}% OFF`}
            </span>
          </TermSegment>
        </div>
      </div>
      )}

      {pendingLine && subscription && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[#f5e6c4] bg-[#fffaf0] px-4 py-3">
          <p className="min-w-[200px] flex-1 text-[14px] leading-5 text-[#6b4a00]">{pendingLine}</p>
          {!storePlan && (
            <button
              type="button"
              onClick={keepCurrent}
              disabled={resuming}
              className="flex h-10 shrink-0 items-center justify-center rounded-cta border border-[#e8e7e4] bg-white px-3.5 text-[14px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f7f7f7] disabled:opacity-60"
            >
              {resuming ? "Keeping…" : `Keep ${nameOf(subscription.tier)}`}
            </button>
          )}
        </div>
      )}

      {}
      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] items-stretch gap-[18px]">
        {pricing.tiers.map((t) => (
          <PlanCard
            key={t.slug}
            tier={t}
            tiers={pricing.tiers}
            term={term}
            months={pricing.sixMonthMonths}
            cta={ctaFor(t)}
            error={error?.tier === t.slug ? error.text : null}
            busy={busy === t.slug}
            highlight={t.slug === (pickedTier ?? RECOMMENDED_TIER)}
            chip={pickedTier ? "Your pick" : "Recommended"}
          />
        ))}
      </div>

      <p className="mt-3 text-[12px] leading-4 text-[#8a8a84]">
        * Daily credits reset each day and don&apos;t roll over.
      </p>

      {error && error.tier === null && (
        <p className="mt-4 text-[13px] leading-5 text-[#cb2029]" role="alert">
          {error.text}
        </p>
      )}

      {}
      <div className="mt-[18px] flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-[#f0f0f0] bg-white px-[18px] py-4">
        <p className="min-w-[220px] flex-1 text-[16px] leading-5 text-[#595959]">
          <span className="font-semibold text-[#0e0f11]">Enterprise</span> More credits, invoicing,
          security review and an SLA.
        </p>
        <a
          href={BOOK_A_CALL}
          target="_blank"
          rel="noreferrer"
          className="flex h-9 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-black"
        >
          Contact Sales
        </a>
      </div>

      {confirm && subscription && (
        <BillingConfirmDialog
          title={confirm.tier === "free" ? "Downgrade to Free?" : `Downgrade to ${confirm.name}?`}
          body={`You keep ${nameOf(subscription.tier)} and its credits until ${
            periodEnd ?? "the end of this billing period"
          }. ${
            confirm.tier === "free"
              ? "After that your plan ends and you move to the free daily credits. You won't be charged again."
              : `After that you move to ${confirm.name} and are billed for it from then on. No refund for the current period.`
          }`}
          confirmLabel={confirm.tier === "free" ? "Downgrade to Free" : `Downgrade to ${confirm.name}`}
          busy={busy !== null}
          error={confirmError}
          onConfirm={() => void change(confirm.tier, true)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function PlanCard({
  tier,
  tiers,
  term,
  months,
  cta,
  error,
  busy,
  highlight,
  chip,
}: {
  tier: PlanTier;
  tiers: readonly PlanTier[];
  term: BillingTerm;
  months: number;
  cta: CardCta;
  error: string | null;
  busy: boolean;
  highlight: boolean;
  chip: string;
}) {
  const sixMonth = term === "6mo" && tier.usd > 0;
  const recommended = highlight;
  const starterMonthly = tiers.find((t) => t.slug === "starter")?.monthlyCredits ?? 0;

  return (
    <div
      data-tier={tier.slug}
      className={`flex flex-col rounded-[20px] border p-[18px] ${
        recommended
          ? "border-[#e6effd] bg-[linear-gradient(180deg,#f8fbff_0%,#e9f2ff_100%)]"
          : "border-[#f0f0f0] bg-white"
      }`}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-[16px] font-semibold leading-6 text-[#0e0f11]">{tier.name}</h3>
        {recommended && (
          <span className="rounded-full bg-[#e7f1ff] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#027bff]">
            {chip}
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-5 text-[#595959]">{taglineFor(tier.slug, tiers)}</p>

      {}
      {}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5">
        <p className="flex items-baseline font-bold text-[#0e0f11]">
          <span className="relative -top-[10px] text-[20px] leading-[22px]">$</span>
          <span className="text-[32px] leading-[38px] tracking-[-0.5px]">
            {nf.format(sixMonth ? tier.sixMonthPerMonthUsd : tier.usd)}
          </span>
          <span className="text-[16px] font-medium leading-6">/mo</span>
        </p>
        {sixMonth && <StruckPrice usd={tier.usd} className="text-[20px] leading-6" />}
      </div>

      {}
      {term === "6mo" && (
        <div className="mt-3 min-h-[44px]">
          {sixMonth && <SixMonthDeal tier={tier} months={months} stack />}
        </div>
      )}

      {cta.hidden ? (
        <div className="mt-3.5 h-10" aria-hidden />
      ) : (
      <button
        type="button"
        onClick={cta.onClick}
        disabled={cta.disabled}
        className={`mt-3.5 flex h-10 w-full items-center justify-center rounded-full px-3 text-[16px] font-semibold transition-colors ${
          cta.current
            ? "cursor-default border border-[#e8e7e4] bg-white text-[#595959]"
            : cta.disabled && !busy
              ? "cursor-default bg-[#0e0f11] text-white opacity-40"
              : recommended
                ? "bg-[#027bff] text-white hover:bg-[#0068d6]"
                : "bg-[#0e0f11] text-white hover:bg-black"
        } ${busy ? "opacity-60" : ""}`}
      >
        {cta.label}
      </button>
      )}
      {error && (
        <p className="mt-2 text-[13px] leading-5 text-[#cb2029]" role="alert">
          {error}
        </p>
      )}

      {}
      <div className="mt-3.5">
        <TierCredits tier={tier} starterMonthly={starterMonthly} />
      </div>

      <div className="mt-3 h-px w-full bg-[#f0f0f0]" />
      <p className="mt-3.5 text-[11px] font-semibold uppercase leading-none tracking-[0.6px] text-[#8a8a84]">
        What&apos;s included
      </p>
      <div className="mt-3 flex flex-col gap-2.5">
        {PRICING_FEATURES.map((f) => (
          <FeatureRow key={f.key} feature={f} included={tierHasFeature(tier.slug, f)} />
        ))}
      </div>
    </div>
  );
}

function TermSegment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "flex items-center gap-2 rounded-full px-4 py-2 text-[14px] leading-6 text-[#0e0f11] transition-colors",
        active ? "bg-white font-semibold shadow-elevMd" : "font-medium hover:bg-white/60",
      )}
    >
      {children}
    </button>
  );
}
