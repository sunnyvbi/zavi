"use client";

import { useEffect, useRef, useState } from "react";
import { withAffiliateClick } from "@/lib/analytics/affiliate";
import { apiFetch } from "@/lib/api";
import { onFullPageBack } from "@/lib/workspace/fullPageBack";
import {
  cancelPlan,
  fetchSubscription,
  fmtPlanDate,
  isShopifySource,
  isStoreSource,
  managedElsewhereCopy,
  MANAGED_IN_STORE_COPY,
  resumePlan,
  type SubscriptionState,
} from "@/lib/workspace/billingSubscription";
import { BillingConfirmDialog } from "./BillingConfirmDialog";
import {
  creditBannerState,
  creditMeterModel,
  creditResetLine,
  STATUS_LOW_CREDIT_THRESHOLD,
} from "@/lib/workspace/runEstimate";
import { UsageDetailsView } from "./UsageDetailsView";
import { UpgradePlanView } from "./UpgradePlanView";
import {
  clearPendingPlan,
  isUpgradeHash,
  parseUpgradeHash,
  type PlanChoice, PLANS_HASH } from "@/lib/workspace/pendingPlan";
import { readChannelLine } from "@/components/marketing/pricingChannels";
import {
  PRICING_FALLBACK,
  fetchLivePricingClient,
  isTierSlug,
  nextTier,
  tierRank,
  type LivePricing,
  type PaidTierSlug,
  type TierSlug,
} from "@/lib/marketing/pricing";

type Credits = {
  plan: string;
  remaining: number;
  allowance: number;
  used: number;
  purchased: number;
  total: number | null;
  resetDate: string | null;
  manageViaPortal: boolean;
  managedInStore: boolean;
  source: string | null;
  tier: TierSlug | null;
  tierName: string | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: Credits }
  | { status: "error" };

type Usage = {
  totalCredits: number;
  periodStart: string;
  periodEnd: string;
  daily: number[];
};

type UsageState =
  | { status: "loading" }
  | { status: "ready"; data: Usage }
  | { status: "error" };

type Invoice = {
  id: string;
  number: string | null;
  created: number;
  amountUsd: number;
  status: string | null;
  pdfUrl: string | null;
};

type InvoicesState =
  | { status: "loading" }
  | { status: "ready"; rows: Invoice[] }
  | { status: "error" };

const BILLING_UNAVAILABLE_COPY =
  "Self-serve billing isn't available yet. Contact support to change your plan or buy credits.";

function fmtCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return `${n}`;
}

function fmtResetDate(d: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function planLabel(plan: string): string {
  if (!plan) return "-";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function plansViewInUrl(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hash.replace(/^#/, "") === PLANS_HASH;
}

export function BillingCreditsPanel({
  openUsage = false,
  onUsageOpened,
  onFullPageChange,
  inlineBack = false,
  tenantId,
}: {
  openUsage?: boolean;
  onUsageOpened?: () => void;
  onFullPageChange?: (open: boolean, view?: "upgrade" | "usage") => void;
  inlineBack?: boolean;
  tenantId?: string;
} = {}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [picked, setPicked] = useState<PlanChoice | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [showUsageDetails, setShowUsageDetails] = useState(false);
  const [tab, setTab] = useState<PanelTabId>("billing");
  const [invoices, setInvoices] = useState<InvoicesState>({ status: "loading" });
  const [pricing, setPricing] = useState<LivePricing>(PRICING_FALLBACK);
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [returnNotice, setReturnNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fullPageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchSubscription().then((sub) => {
      if (!cancelled && (sub || reloadKey === 0)) setSubscription(sub);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const flag = url.searchParams.get("billing");
    if (flag !== "success" && flag !== "upgraded") return;
    setReturnNotice(
      flag === "upgraded"
        ? "Your plan is updated. New credits can take a minute to show."
        : "Thanks! Your plan is active. New credits can take a minute to show.",
    );
    url.searchParams.delete("billing");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    const timers = [4_000, 15_000, 45_000].map((ms) =>
      window.setTimeout(() => setReloadKey((k) => k + 1), ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetchLivePricingClient().then((p) => {
      if (!cancelled) setPricing(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!openUsage) return;
    setTab("usage");
    onUsageOpened?.();
  }, [openUsage, onUsageOpened]);

  const fullPage = showUpgrade || showUsageDetails;
  const fullPageView = showUpgrade ? "upgrade" : showUsageDetails ? "usage" : undefined;
  useEffect(() => {
    onFullPageChange?.(fullPage, fullPageView);
  }, [fullPage, fullPageView, onFullPageChange]);
  useEffect(() => {
    if (!fullPage || inlineBack) return;
    return onFullPageBack(
      () => (fullPageRef.current?.getClientRects().length ?? 0) > 0,
      () => {
        setShowUpgrade(false);
        setPicked(null);
        setShowUsageDetails(false);
      },
    );
  }, [fullPage, inlineBack]);
  useEffect(() => () => onFullPageChange?.(false), [onFullPageChange]);

  const lastSyncedShow = useRef(showUpgrade);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (lastSyncedShow.current === showUpgrade) return;
    lastSyncedShow.current = showUpgrade;
    const raw = window.location.hash.replace(/^#/, "");
    if (isUpgradeHash(raw)) return;
    const onPlans = raw === PLANS_HASH;
    if (onPlans === showUpgrade) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search + "#" + (showUpgrade ? PLANS_HASH : "billing"),
    );
  }, [showUpgrade]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => {
      const next = hashTab();
      setTab(next);
      const choice = parseUpgradeHash(window.location.hash);
      setShowUpgrade(choice !== null || plansViewInUrl());
      setPicked(choice);
      if (next === "billing") setShowUsageDetails(false);
      if (choice) {
        clearPendingPlan();
        window.setTimeout(() => {
          if (!isUpgradeHash(window.location.hash)) return;
          window.history.replaceState(
            null,
            "",
            window.location.pathname + window.location.search + "#" + PLANS_HASH,
          );
        }, 0);
      }
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const selectTab = (next: PanelTabId) => {
    setTab(next);
    setShowUpgrade(false);
    setPicked(null);
    if (next === "billing") setShowUsageDetails(false);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        next === "usage" ? "#billing-usage" : "#billing",
      );
    }
  };

  useEffect(() => {
    let cancelled = false;
    const failRead = () => {
      setState((prev) => (prev.status === "ready" ? prev : { status: "error" }));
    };
    (async () => {
      try {
        const res = await apiFetch("/api/billing/credits");
        if (cancelled) return;
        if (!res.ok) {
          failRead();
          return;
        }
        const j = (await res.json()) as {
          plan?: unknown;
          effective_available_display?: unknown;
          included_allowance?: unknown;
          included_used?: unknown;
          purchased_balance?: unknown;
          credits_total?: unknown;
          period_end?: unknown;
          manage_via_portal?: unknown;
          managed_in_store?: unknown;
          source?: unknown;
          tier?: unknown;
          tier_name?: unknown;
        };
        const remaining =
          typeof j.effective_available_display === "number" &&
          Number.isFinite(j.effective_available_display)
            ? j.effective_available_display
            : null;
        if (remaining === null) {
          failRead();
          return;
        }
        setState({
          status: "ready",
          data: {
            plan: typeof j.plan === "string" ? j.plan : "free",
            remaining,
            allowance:
              typeof j.included_allowance === "number" && Number.isFinite(j.included_allowance)
                ? j.included_allowance
                : 0,
            used:
              typeof j.included_used === "number" && Number.isFinite(j.included_used)
                ? j.included_used
                : 0,
            purchased:
              typeof j.purchased_balance === "number" && Number.isFinite(j.purchased_balance)
                ? j.purchased_balance
                : 0,
            total:
              typeof j.credits_total === "number" && Number.isFinite(j.credits_total)
                ? j.credits_total
                : null,
            resetDate: typeof j.period_end === "string" ? j.period_end : null,
            manageViaPortal: j.manage_via_portal === true,
            managedInStore: j.managed_in_store === true || isStoreSource(j.source),
            source: typeof j.source === "string" ? j.source : null,
            tier: isTierSlug(j.tier) ? j.tier : null,
            tierName: typeof j.tier_name === "string" && j.tier_name ? j.tier_name : null,
          },
        });
      } catch {
        if (!cancelled) failRead();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/billing/usage-breakdown");
        if (cancelled) return;
        if (!res.ok) {
          setUsage({ status: "error" });
          return;
        }
        const j = (await res.json()) as {
          total_credits?: unknown;
          period_start?: unknown;
          period_end?: unknown;
          daily?: unknown;
        };
        const daily = Array.isArray(j.daily)
          ? j.daily.map((d) =>
              typeof (d as { credits?: unknown })?.credits === "number"
                ? (d as { credits: number }).credits
                : 0,
            )
          : [];
        setUsage({
          status: "ready",
          data: {
            totalCredits: typeof j.total_credits === "number" ? j.total_credits : 0,
            periodStart: typeof j.period_start === "string" ? j.period_start : "",
            periodEnd: typeof j.period_end === "string" ? j.period_end : "",
            daily,
          },
        });
      } catch {
        if (!cancelled) setUsage({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/billing/invoices");
        if (cancelled) return;
        if (!res.ok) {
          setInvoices({ status: "error" });
          return;
        }
        const j = (await res.json()) as { invoices?: unknown };
        const rows = Array.isArray(j.invoices) ? j.invoices.map(toInvoice).filter(isInvoice) : [];
        if (!cancelled) setInvoices({ status: "ready", rows });
      } catch {
        if (!cancelled) setInvoices({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const usageData = usage.status === "ready" ? usage.data : null;
  const creditState = data
    ? creditBannerState(data.remaining, data.allowance, STATUS_LOW_CREDIT_THRESHOLD)
    : "none";
  const isLowCredit = creditState !== "none";
  const meter =
    data?.total != null
      ? creditMeterModel(data.remaining, data.total, 0, creditState)
      : creditMeterModel(data?.remaining ?? 0, data?.allowance ?? 0, data?.purchased ?? 0, creditState);
  const fillPct = data ? meter.fillPct : 0;
  const pctLabel = data ? meter.pctLabel : null;
  const resetLabel = data ? fmtResetDate(data.resetDate) : null;
  const periodEndLabel = fmtPlanDate(subscription?.currentPeriodEnd);
  const storePlan = (data?.managedInStore ?? false) || isStoreSource(subscription?.source);
  const storeCopy = managedElsewhereCopy(subscription?.source ?? data?.source);
  const shopifyPlan = isShopifySource(subscription?.source ?? data?.source);
  const tierName = (slug: TierSlug) =>
    pricing.tiers.find((t) => t.slug === slug)?.name ?? planLabel(slug);
  const pendingLine = !subscription
    ? null
    : subscription.cancelAtPeriodEnd
      ? `Your plan ends${periodEndLabel ? ` on ${periodEndLabel}` : " at the end of this period"}. You'll move to Free after that.`
      : subscription.scheduledChange
        ? `Your plan changes to ${tierName(subscription.scheduledChange.tier)}${
            fmtPlanDate(subscription.scheduledChange.effectiveAt)
              ? ` on ${fmtPlanDate(subscription.scheduledChange.effectiveAt)}`
              : " when this period ends"
          }.`
        : null;

  async function confirmCancel() {
    if (planBusy) return;
    setPlanBusy(true);
    setPlanError(null);
    const r = await cancelPlan();
    setPlanBusy(false);
    if (r.ok) {
      setSubscription(r.subscription);
      setCancelOpen(false);
    } else {
      setPlanError(
        r.code === "forbidden"
          ? "Only a workspace owner or admin can cancel the plan."
          : "Couldn't cancel your plan. Please try again, or contact support.",
      );
    }
  }

  async function keepPlan() {
    if (planBusy) return;
    setPlanBusy(true);
    setPlanError(null);
    const r = await resumePlan();
    setPlanBusy(false);
    if (r.ok) setSubscription(r.subscription);
    else setPlanError("Couldn't update your plan. Please try again.");
  }

  if (showUpgrade) {
    return (
      <div ref={fullPageRef}>
        <UpgradePlanView
          onBack={() => {
            setShowUpgrade(false);
            setPicked(null);
          }}
          showBack={inlineBack}
          initialTerm={picked?.term}
          pickedTier={picked?.tier}
          currentTier={subscription?.tier ?? data?.tier ?? null}
          manageViaPortal={data?.manageViaPortal ?? false}
          managedInStore={storePlan}
          subscription={subscription}
          onSubscriptionChange={setSubscription}
          pricing={pricing}
          tenantId={tenantId}
        />
      </div>
    );
  }
  if (showUsageDetails) {
    return (
      <div ref={fullPageRef}>
        <UsageDetailsView onBack={() => setShowUsageDetails(false)} showBack={inlineBack} />
      </div>
    );
  }

  return (
    <div className="font-sans">
      {}
      <div className="flex flex-col gap-2">
        <h2 className="text-[20px] font-semibold leading-7 tracking-tight text-[#0e0f11]">
          Billing &amp; Credits Usage
        </h2>
        <p className="text-[16px] leading-5 text-[#595959]">
          Manage your plan and see how your agents are working for your team.
        </p>
      </div>

      {returnNotice && (
        <p className="mt-4 rounded-[12px] border border-[#cdebdc] bg-[#f1faf5] px-4 py-2.5 text-[14px] leading-5 text-[#0b6b43]" role="status">
          {returnNotice}
        </p>
      )}

      {}
      <div className="mt-4 flex items-center gap-6 border-b border-[#f0f0f0]">
        <PanelTab
          label={"Billing & Credits"}
          active={tab === "billing"}
          onClick={() => selectTab("billing")}
        />
        <PanelTab
          label="Usage"
          active={tab === "usage"}
          onClick={() => selectTab("usage")}
        />
      </div>

      <div className="mt-6 flex flex-col gap-8">
        <div className="flex flex-col gap-[18px] lg:flex-row">
          {}
          {tab === "billing" && (
          <div className="flex w-full flex-col gap-[18px] rounded-[13.5px] border border-[#f0f0f0] bg-white p-[17px]">
            <div className="flex flex-col gap-1">
              <span className="text-[16px] font-medium leading-5 text-black">Current plan</span>
              <span className="text-[20px] font-semibold leading-7 text-black">
                {state.status === "loading" ? (
                  <Skel className="h-6 w-24 align-middle" />
                ) : data ? (
                  data.tierName ?? planLabel(data.tier ?? data.plan)
                ) : (
                  "-"
                )}
              </span>
            </div>

            {}
            <div className="flex flex-col gap-5 rounded-[16px] bg-[#f9f9f9] p-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-[20px] font-semibold leading-7 text-black">Credits</span>
                  <span
                    className={`text-[16px] font-medium leading-6 ${
                      isLowCredit ? "font-semibold text-[#cb2029]" : "text-[#595959]"
                    }`}
                  >
                    {}
                    {state.status === "loading" ? (
                      <Skel className="h-4 w-20 align-middle" />
                    ) : data ? (
                      pctLabel !== null ? (
                        `${pctLabel}% left`
                      ) : (
                        `${fmtCredits(data.remaining)} left`
                      )
                    ) : (
                      "-"
                    )}
                  </span>
                </div>
                <div
                  className={`credit-meter-track h-2 w-full overflow-hidden rounded-full bg-[#f0f0f0] ${
                    state.status === "loading" ? "animate-pulse" : ""
                  }`}
                >
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      creditState === "none" ? "bg-ink" : "bg-danger"
                    }`}
                    style={{ width: `${fillPct}%` }}
                  />
                </div>
              </div>
              {state.status === "loading" ? (
                <Skel className="h-4 w-44" />
              ) : data && (resetLabel || pendingLine) ? (
                <ul className="m-0 list-disc ps-6 text-[16px] leading-6 text-[#595959]">
                  {resetLabel && <li>{creditResetLine(resetLabel)}</li>}
                  {pendingLine && <li className="text-[#946300]">{pendingLine}</li>}
                </ul>
              ) : null}
            </div>

            {}
            {!shopifyPlan && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[#f0f0f0] bg-white px-4 py-3">
              <div className="flex min-w-[180px] flex-1 flex-col gap-1">
                <p className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
                  Need more credits?
                </p>
                <p className="text-[16px] leading-5 text-[#595959]">
                  {data?.tier === "pro"
                    ? "You're on Pro. Buy a one-time credit pack for more."
                    : storePlan
                      ? "Buy a one-time credit pack for more."
                      : "Upgrade your plan, or buy a one-time credit pack now."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {}
                <button
                  type="button"
                  onClick={() => setTopupOpen(true)}
                  className="flex h-10 shrink-0 items-center justify-center rounded-cta border border-[#e8e7e4] bg-white px-4 py-2.5 text-[16px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f7f7f7]"
                >
                  Buy Credits
                </button>
                {!storePlan && (
                  <button
                    type="button"
                    onClick={() => setShowUpgrade(true)}
                    className="flex h-10 shrink-0 items-center justify-center rounded-cta bg-[#0e0f11] px-4 py-2.5 text-[16px] font-semibold text-white transition-colors hover:bg-black"
                  >
                    {subscription || data?.tier === "pro" ? "Change plan" : "Upgrade plan"}
                  </button>
                )}
              </div>
            </div>
            )}
          </div>
          )}

          {}
          {tab === "usage" && (
          <div className="flex w-full flex-col gap-4 rounded-[13.5px] border border-[#f0f0f0] bg-white p-[17px]">
            <div className="flex items-start justify-between">
              <span className="text-[20px] font-semibold leading-7 text-[#030303]">Usage</span>
              <button
                type="button"
                onClick={() => setShowUsageDetails(true)}
                aria-label="Open full usage details"
                className="flex h-6 w-6 items-center justify-center rounded-cta text-[#595959] transition-colors hover:bg-[#f3f3f3]"
              >
                <ChevronRight />
              </button>
            </div>

            {}
            {usage.status === "loading" ? (
              <div className="h-[90px] w-full animate-pulse rounded-[8px] bg-[#f3f3f3]" />
            ) : (
              <UsageChart values={usageData?.daily ?? []} />
            )}
            <div className="-mt-1 flex items-center justify-between">
              {usage.status === "loading" ? (
                <>
                  <Skel className="h-3 w-12" />
                  <Skel className="h-3 w-12" />
                </>
              ) : (
                <>
                  <span className="text-[12px] text-[#636363]">
                    {(usageData?.periodStart && fmtResetDate(usageData.periodStart)) ||
                      usageRange().start}
                  </span>
                  <span className="text-[12px] text-[#636363]">
                    {(usageData?.periodEnd && fmtResetDate(usageData.periodEnd)) ||
                      usageRange().end}
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-[16px] font-semibold leading-5 text-[#030303]">Last 30 days</span>
              <span className="text-[16px] font-semibold leading-5 text-[#030303]">
                {usage.status === "loading" ? (
                  <Skel className="h-4 w-20 align-middle" />
                ) : usageData ? (
                  `${fmtCredits(usageData.totalCredits)} credits`
                ) : (
                  "- credits"
                )}
              </span>
            </div>

            {usage.status !== "loading" && (usageData?.totalCredits ?? 0) === 0 && (
              <p className="text-[13px] leading-5 text-[#9a9a9a]">
                No usage recorded in the last 30 days yet.
              </p>
            )}

            {}
            <button
              type="button"
              onClick={() => setShowUsageDetails(true)}
              className="mt-1 inline-flex h-10 w-auto self-start items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-3.5 text-[16px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f6f6f6]"
            >
              More Usage details
            </button>
          </div>
          )}
        </div>

        {tab === "billing" && <InvoiceTable state={invoices} />}

        {}
        {tab === "billing" && storePlan && (
          <p className="text-[14px] leading-5 text-[#595959]">{storeCopy}</p>
        )}
        {tab === "billing" && subscription && !storePlan && (
          <div className="flex flex-col items-start gap-2">
            {subscription.cancelAtPeriodEnd ? (
              <button
                type="button"
                onClick={keepPlan}
                disabled={planBusy}
                className="flex h-10 items-center justify-center rounded-cta border border-[#e8e7e4] bg-white px-4 text-[16px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f7f7f7] disabled:opacity-60"
              >
                {planBusy ? "Working…" : `Keep ${tierName(subscription.tier)}`}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setPlanError(null);
                  setCancelOpen(true);
                }}
                className="flex h-10 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-medium text-[#cb2029] transition-colors hover:bg-[#fff5f5]"
              >
                Cancel plan
              </button>
            )}
            {planError && !cancelOpen && (
              <p className="text-[13px] leading-5 text-[#cb2029]" role="alert">
                {planError}
              </p>
            )}
          </div>
        )}
      </div>

      {cancelOpen && subscription && (
        <BillingConfirmDialog
          title={`Cancel your ${tierName(subscription.tier)} plan?`}
          body={`You keep ${tierName(subscription.tier)} and its credits until ${
            periodEndLabel ?? "the end of this billing period"
          }. After that you move to Free and won't be charged again. You can keep the plan any time before then.`}
          confirmLabel="Cancel plan"
          danger
          busy={planBusy}
          error={planError}
          onConfirm={() => void confirmCancel()}
          onClose={() => setCancelOpen(false)}
        />
      )}

      {topupOpen && (
        <UpgradePlanModal
          onClose={() => setTopupOpen(false)}
          currentTier={data?.tier ?? null}
          purchase="topup"
          pricing={pricing}
        />
      )}
    </div>
  );
}

type PanelTabId = "billing" | "usage";

function hashTab(): PanelTabId {
  if (typeof window === "undefined") return "billing";
  return window.location.hash.replace(/^#/, "") === "billing-usage" ? "usage" : "billing";
}

function PanelTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`-mb-px border-b-2 pb-2 text-[16px] transition-colors ${
        active
          ? "border-[#0e0f11] font-semibold text-[#0e0f11]"
          : "border-transparent font-medium text-[#595959] hover:text-[#0e0f11]"
      }`}
    >
      {label}
    </button>
  );
}

function InvoiceTable({ state }: { state: InvoicesState }) {
  return (
    <div className="overflow-hidden rounded-[13.5px] border border-[#f0f0f0] bg-white">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-[#f0f0f0] bg-[#f9f9f9] px-[18px] py-3">
        <span className="text-[13px] font-medium leading-5 text-[#595959]">Invoice</span>
        <span className="text-center text-[13px] font-medium leading-5 text-[#595959]">Date</span>
        <span className="text-right text-[13px] font-medium leading-5 text-[#595959]">Amount</span>
      </div>

      {state.status === "loading" ? (
        <div className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-b border-[#f0f0f0] px-[18px] py-3 last:border-b-0"
            >
              <Skel className="h-4 w-20" />
              <span className="text-center">
                <Skel className="h-4 w-24 align-middle" />
              </span>
              <span className="text-right">
                <Skel className="h-4 w-14 align-middle" />
              </span>
            </div>
          ))}
        </div>
      ) : state.status === "error" ? (
        <p className="flex items-start gap-2 px-[18px] py-4 text-[16px] leading-5 text-[#946300]" role="alert">
          <WarnIcon />
          <span>
            Couldn&apos;t load your invoices just now. Refresh the page, or find them all in
            the billing portal.
          </span>
        </p>
      ) : state.rows.length === 0 ? (
        <p className="px-[18px] py-4 text-[16px] leading-5 text-[#595959]">
          No invoices yet. Your first one appears here after your first paid month.
        </p>
      ) : (
        <div className="flex flex-col">
          {state.rows.map((inv) => {
            const cells = (
              <>
                <span className="truncate text-[16px] font-medium leading-5 text-[#0e0f11]">
                  {inv.number ?? inv.id}
                </span>
                <span className="truncate text-center text-[16px] leading-5 text-[#595959]">
                  {fmtInvoiceDate(inv.created)}
                </span>
                <span className="flex items-center justify-end gap-2 text-[16px] font-medium leading-5 text-[#0e0f11]">
                  {inv.status === "open" && (
                    <span className="rounded-full bg-[#fffaf0] px-2 py-0.5 text-[11px] font-semibold text-[#946300]">
                      Due
                    </span>
                  )}
                  {fmtUsd(inv.amountUsd)}
                </span>
              </>
            );
            const row = "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-b border-[#f0f0f0] px-[18px] py-3 last:border-b-0";
            return inv.pdfUrl ? (
              <a
                key={inv.id}
                href={inv.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className={`${row} transition-colors hover:bg-[#f9f9f9]`}
                title={`Open invoice ${inv.number ?? inv.id}`}
              >
                {cells}
              </a>
            ) : (
              <div key={inv.id} className={row}>
                {cells}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 size-4 flex-none" fill="currentColor" aria-hidden>
      <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3.4a.9.9 0 0 1 .9.9v4.3a.9.9 0 1 1-1.8 0V6.3a.9.9 0 0 1 .9-.9Zm0 8.9a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}

function fmtInvoiceDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toInvoice(raw: unknown): Invoice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    number: typeof r.number === "string" ? r.number : null,
    created: typeof r.created === "number" ? r.created : 0,
    amountUsd: typeof r.amount_due_usd === "number" ? r.amount_due_usd : 0,
    status: typeof r.status === "string" ? r.status : null,
    pdfUrl: typeof r.pdf_url === "string" ? r.pdf_url : null,
  };
}

function isInvoice(v: Invoice | null): v is Invoice {
  return v !== null;
}

function usageRange(): { start: string; end: string } {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 86400 * 1000);
  return { start: fmt(start), end: fmt(end) };
}

function UsageChart({ values }: { values: number[] }) {
  const W = 398;
  const H = 90;
  const pad = 6;
  const series = values.length >= 2 ? values : [0, 0];
  const max = Math.max(...series, 1);
  const n = series.length;
  const stepX = W / (n - 1);
  const pts = series.map((v, i) => {
    const x = i * stepX;
    const norm = Math.max(0, v) / max;
    const y = H - pad - norm * (H - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[90px] w-full text-ink"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="usageFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#usageFill)" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Skel({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-block animate-pulse rounded bg-[#ececec] ${className}`} aria-hidden />
  );
}

function ChevronRight() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden
      className="shrink-0 text-[#595959]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function planSummaryLine(includes: string[]): string {
  return includes
    .map(readChannelLine)
    .filter((l) => !l.heading)
    .map((l) => (l.comingSoon ? `${l.label} (soon)` : l.label))
    .join(" · ");
}

export function defaultUpgradeTier(currentTier: TierSlug | null): PaidTierSlug | null {
  return nextTier(currentTier ?? "free");
}

export function tierSelectable(tier: PaidTierSlug, currentTier: TierSlug | null): boolean {
  return tierRank(tier) > tierRank(currentTier ?? "free");
}

export function UpgradePlanModal({
  onClose,
  currentTier,
  manageViaPortal = false,
  purchase = "subscription",
  pricing = PRICING_FALLBACK,
}: {
  onClose: () => void;
  currentTier: TierSlug | null;
  manageViaPortal?: boolean;
  purchase?: "subscription" | "topup";
  pricing?: LivePricing;
}) {
  const isTopup = purchase === "topup";
  const portalHandoff = !isTopup && manageViaPortal;
  const paidTiers = pricing.tiers.filter((t) => t.slug !== "free");
  const [selTier, setSelTier] = useState<PaidTierSlug | null>(() => defaultUpgradeTier(currentTier));
  const [selPackUsd, setSelPackUsd] = useState<number | null>(pricing.topupPacks[0]?.usd ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit = portalHandoff || (isTopup ? selPackUsd !== null : selTier !== null);
  const recommendedPackIndex =
    pricing.topupPacks.length >= 3 ? Math.floor(pricing.topupPacks.length / 2) : -1;
  const selectedTierName = paidTiers.find((t) => t.slug === selTier)?.name ?? null;

  async function startCheckout() {
    if (submitting || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const endpoint = isTopup
        ? "/api/billing/topup"
        : portalHandoff
          ? "/api/billing/portal"
          : "/api/billing/checkout";
      const res = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(
          isTopup
            ? { usd: selPackUsd }
            : portalHandoff
              ? {}
              : withAffiliateClick({ tier: selTier, origin: "workspace" }),
        ),
      });
      const j = (await res.json().catch(() => null)) as {
        url?: string;
        redirect?: string;
        error?: { code?: string; message?: string };
      } | null;
      const dest = j?.url ?? j?.redirect;
      if (res.ok && dest) {
        window.location.href = dest;
        return;
      }
      const code = j?.error?.code;
      if (res.status === 503 || code === "billing_not_configured") {
        setError(BILLING_UNAVAILABLE_COPY);
      } else if (code === "managed_in_store") {
        setError(j?.error?.message ?? MANAGED_IN_STORE_COPY);
      } else if (code === "price_not_configured") {
        setError("Plan changes aren't available yet. Contact support to change your plan.");
      } else {
        setError(j?.error?.message ?? "Couldn't start checkout. Please try again.");
      }
      setSubmitting(false);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  const title = isTopup ? "Buy Credits" : portalHandoff ? "Manage your plan" : "Choose your plan";
  const subtitle = isTopup
    ? "A one-time credit pack added to your balance. It never expires and is shared across your workspace."
    : portalHandoff
      ? "You already have a monthly plan. Upgrades and downgrades are made in the billing portal, where Stripe shows the proration before you confirm."
      : currentTier === "pro"
        ? "You're on Pro, the top plan. Buy a credit pack when you need more."
        : "Pick a monthly plan. Every plan keeps the free daily credits.";

  return (
    <div
      className="dialog-scrim fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      {}
      <div
        className="relative max-h-[calc(100vh-32px)] w-full max-w-[560px] overflow-y-auto rounded-[20px] border border-rule bg-white p-6 shadow-[0_24px_48px_rgba(16,18,20,0.18)] font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        {}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-cta text-[#0e0f11] transition-colors hover:bg-[#f0f0f0]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="flex flex-col gap-2 pr-10">
          <h3 className="text-[26px] font-bold leading-[36px] text-black">{title}</h3>
          <p className="text-[16px] leading-[22px] tracking-[-0.15px] text-[#595959]">
            {subtitle}
          </p>
        </div>

        {portalHandoff ? (
          <div className="mt-4 flex flex-col gap-1 rounded-[16px] bg-[#f9f9f9] p-4">
            <p className="text-[12px] font-medium uppercase leading-4 tracking-[1px] text-black">
              Current plan
            </p>
            <p className="text-[16px] font-semibold leading-6 text-black">
              {currentTier ? pricing.tiers.find((t) => t.slug === currentTier)?.name ?? planLabel(currentTier) : "Monthly plan"}
            </p>
          </div>
        ) : isTopup ? (
          <div role="radiogroup" aria-label="Credit pack" className="mt-6 flex flex-col gap-2.5">
            {pricing.topupPacks.map((p, i) => {
              const active = p.usd === selPackUsd;
              const recommended = i === recommendedPackIndex;
              return (
                <button
                  key={p.usd}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelPackUsd(p.usd)}
                  className={`flex w-full items-center gap-2.5 rounded-cta border p-4 text-left transition-colors ${
                    active ? "border-[#0e0f11] bg-[#f9f9f9]" : "border-[#f0f0f0] bg-white hover:border-[#d8d8d8]"
                  }`}
                >
                  <span className="text-[16px] font-medium leading-6 text-[#0e0f11]">
                    {p.credits.toLocaleString("en-US")} credits
                  </span>
                  {recommended && (
                    <span className="rounded-full bg-[#e7f1ff] px-2 py-0.5 text-[12px] font-medium leading-4 text-[#027bff]">
                      Recommended
                    </span>
                  )}
                  <span className="ml-auto text-[16px] font-semibold leading-6 text-[#0e0f11]">
                    ${p.usd.toLocaleString("en-US")}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div role="radiogroup" aria-label="Plan" className="mt-4 flex flex-col gap-2">
            {paidTiers.map((t) => {
              const slug = t.slug as PaidTierSlug;
              const selectable = tierSelectable(slug, currentTier);
              const active = slug === selTier;
              const isCurrent = slug === currentTier;
              return (
                <button
                  key={slug}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-disabled={!selectable}
                  disabled={!selectable}
                  onClick={() => setSelTier(slug)}
                  data-tier={slug}
                  className={`flex w-full flex-col gap-2 rounded-[16px] border p-4 text-left transition-colors ${
                    active
                      ? "border-[#0e0f11] bg-[#f9f9f9]"
                      : selectable
                        ? "border-[#f0f0f0] bg-white hover:border-[#d8d8d8]"
                        : "cursor-default border-[#f0f0f0] bg-white opacity-60"
                  }`}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="inline-block size-2.5 flex-none rounded-full bg-[#0E9F6E]" aria-hidden />
                    <span className="text-[16px] font-semibold leading-6 text-[#0e0f11]">{t.name}</span>
                    {isCurrent && (
                      <span className="rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[11px] font-semibold text-[#595959]">
                        Current plan
                      </span>
                    )}
                    <span className="ml-auto text-[16px] font-semibold leading-6 text-[#0e0f11]">
                      ${t.usd.toLocaleString("en-US")}
                      <span className="text-[13px] font-medium text-[#595959]"> /mo</span>
                    </span>
                  </span>
                  <span className="text-[13px] leading-5 text-[#595959]">
                    {planSummaryLine(t.includes)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <p className="mt-3 text-[13px] leading-5 text-[#cb2029]" role="alert">
            {error}
          </p>
        )}

        {(portalHandoff || canSubmit) && (
          <button
            type="button"
            onClick={startCheckout}
            disabled={submitting || !canSubmit}
            className="mt-[13px] flex h-12 w-full items-center justify-center rounded-cta bg-[#0e0f11] px-4 py-2.5 text-[16px] font-semibold tracking-[0.01px] text-white transition-colors hover:bg-black disabled:opacity-70"
          >
            {submitting
              ? portalHandoff
                ? "Opening billing portal…"
                : "Starting checkout…"
              : portalHandoff
                ? "Open billing portal"
                : isTopup
                  ? "Buy credits"
                  : `Upgrade to ${selectedTierName ?? "this plan"}`}
          </button>
        )}
      </div>
    </div>
  );
}
