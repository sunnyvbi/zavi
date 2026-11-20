"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { onTabReturn } from "@/lib/workspace/onTabReturn";
import { useWorkspace } from "./WorkspaceShell";
import { isMember } from "@/lib/members";
import { useActiveTenant } from "./brain/useActiveTenant";
import {
  CREDIT_BANNER_DISMISS_KEY,
  creditBannerDismissSignature,
  creditBannerState,
  creditPercentLeft,
  isCreditBannerDismissible,
} from "@/lib/workspace/runEstimate";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { PLANS_HASH } from "@/lib/workspace/pendingPlan";

const LOW_CREDIT_THRESHOLD = 0.2;

type Credits = {
  remaining: number;
  allowance: number;
  resetDate: string | null;
  softWarn: boolean;
  unlimited: boolean;
};

function fmtCredits(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

function fmtResetDate(d: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function LowCreditsWarning({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const { openTab, role, creditsEnforced } = useWorkspace();
  const canManageBilling = !isMember(role);
  const [credits, setCredits] = useState<Credits | null>(null);
  const tenantId = useActiveTenant();
  const [dismissedState, setDismissedState] = useState<string | null>(null);

  useEffect(() => {
    if (!canManageBilling) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch("/api/billing/credits");
        if (cancelled || !res.ok) return;
        const j = (await res.json()) as {
          effective_available_display?: unknown;
          included_allowance?: unknown;
          credits_total?: unknown;
          period_end?: unknown;
          soft_warn?: unknown;
          unlimited?: unknown;
        };
        const remaining =
          typeof j.effective_available_display === "number" &&
          Number.isFinite(j.effective_available_display)
            ? j.effective_available_display
            : null;
        const allowance =
          typeof j.credits_total === "number" && Number.isFinite(j.credits_total) && j.credits_total > 0
            ? j.credits_total
            : typeof j.included_allowance === "number" && Number.isFinite(j.included_allowance)
              ? j.included_allowance
              : null;
        if (remaining === null || allowance === null) return;
        setCredits({
          remaining,
          allowance,
          resetDate: typeof j.period_end === "string" ? j.period_end : null,
          softWarn: j.soft_warn === true,
          unlimited: j.unlimited === true,
        });
      } catch {
      }
    };
    void load();
    const interval = window.setInterval(load, 60_000);
    const stopListening = onTabReturn(() => {
      if (document.visibilityState !== "hidden") void load();
    });
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      stopListening();
    };
  }, [canManageBilling]);

  function goBilling() {
    openBillingSettings(openTab);
  }

  function goPlans() {
    openBillingSettings(openTab, PLANS_HASH);
  }

  const eligible = canManageBilling && creditsEnforced && credits?.unlimited !== true;
  const bannerState =
    credits && eligible
      ? creditBannerState(credits.remaining, credits.allowance, LOW_CREDIT_THRESHOLD)
      : "none";
  const depleted = bannerState === "depleted";
  const low = bannerState === "low";
  const approaching = !!credits && eligible && !depleted && !low && credits.softWarn;

  const effectiveState = depleted
    ? "depleted"
    : low
      ? "low"
      : approaching
        ? "approaching"
        : "none";

  const dismissSignature = creditBannerDismissSignature(
    effectiveState,
    tenantId,
    credits?.resetDate ?? null,
  );
  const dismissible = isCreditBannerDismissible(effectiveState);

  useEffect(() => {
    const locallyDismissed = dismissedState === effectiveState;

    if (!dismissSignature) {
      if (!locallyDismissed) setDismissedState(null);
      return;
    }
    if (locallyDismissed) {
      try {
        window.localStorage.setItem(CREDIT_BANNER_DISMISS_KEY, dismissSignature);
      } catch {
      }
      return;
    }

    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(CREDIT_BANNER_DISMISS_KEY);
    } catch {
    }
    setDismissedState(stored === dismissSignature ? effectiveState : null);
  }, [dismissSignature, effectiveState, dismissedState]);

  function onDismiss() {
    setDismissedState(effectiveState);
    if (dismissSignature) {
      try {
        window.localStorage.setItem(CREDIT_BANNER_DISMISS_KEY, dismissSignature);
      } catch {
      }
    }
    if (typeof document !== "undefined") {
      document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")?.focus();
    }
  }

  const hidden = dismissible && dismissedState === effectiveState;

  if (!credits || effectiveState === "none" || effectiveState === "depleted" || hidden) {
    return null;
  }

  const resetLabel = fmtResetDate(credits.resetDate);
  const pctLeft = creditPercentLeft(credits.remaining, credits.allowance);

  return (
    <div className={`shrink-0 pb-2 pt-1 font-sans${embedded ? "" : " px-4"}`}>
      <div
        role="status"
        aria-live="polite"
        className={`credit-card mx-auto flex w-full${
          embedded ? "" : " max-w-[42rem]"
        } flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] border border-rule bg-cream py-2.5 pl-4 pr-2.5`}
      >
        <div className="flex min-w-[min(12rem,100%)] flex-1 items-center gap-3">
          <CreditRing pct={pctLeft ?? 0} />
          <p className="min-w-0 truncate text-[14px] leading-5 text-ink">
            <span className="font-medium">
              {pctLeft === null
                ? `${fmtCredits(credits.remaining)} credits left`
                : `${pctLeft}% of credits left`}
            </span>
            {resetLabel && (
              <span className="text-[13px] text-inkMuted"> · Resets {resetLabel}</span>
            )}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={goBilling}
            className="flex h-8 items-center rounded-full px-3 text-[14px] font-medium text-ink transition-colors hover:bg-creamDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Buy credits
          </button>
          <button
            type="button"
            onClick={goPlans}
            className="flex h-8 items-center rounded-full bg-ink px-4 text-[14px] font-medium text-cream transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Upgrade
          </button>
          {dismissible && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss credit warning"
              className="flex h-8 w-8 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-creamDeep hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CreditRing({ pct }: { pct: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="11" cy="11" r={r} fill="none" strokeWidth="2.5" className="stroke-rule" />
      <circle
        cx="11"
        cy="11"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c}`}
        className="stroke-amber-400"
      />
    </svg>
  );
}

export function MoneyExchangeWarningIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="credit-card-icon shrink-0 text-warn"
    >
      <path
        d="M19.8331 1.46094C21.1394 1.46097 22.3888 1.60421 23.5284 1.86523C23.551 1.87042 23.5734 1.87576 23.5958 1.88086C24.2337 2.02659 24.7539 2.1452 25.3233 2.5957C25.664 2.8653 26.0428 3.34109 26.2296 3.7334C26.5423 4.39061 26.5419 5.04075 26.5411 5.8457V13.4199C26.5409 13.903 26.1492 14.2949 25.6661 14.2949C25.1829 14.2949 24.7913 13.903 24.7911 13.4199V5.96875C24.7911 4.98639 24.7737 4.74634 24.6495 4.48535C24.5779 4.33493 24.3681 4.07219 24.2374 3.96875C24.0006 3.7814 23.8474 3.73382 23.1378 3.57129C22.1317 3.34086 21.0136 3.21097 19.8331 3.21094C17.7032 3.21094 15.7901 3.63229 14.3692 4.2959C12.6809 5.08436 10.5091 5.54491 8.16609 5.54492C6.85967 5.54492 5.61049 5.40165 4.47078 5.14062C3.7786 4.98209 3.20847 5.49933 3.20808 5.96875V18.5371C3.20809 19.5193 3.22459 19.7596 3.34871 20.0205C3.42025 20.1708 3.63013 20.4335 3.76082 20.5371C3.99765 20.7245 4.15138 20.7719 4.8614 20.9346C5.86757 21.165 6.98543 21.2949 8.16609 21.2949C9.79455 21.2949 11.3004 21.0485 12.5577 20.6328C13.0164 20.4811 13.5113 20.7299 13.6632 21.1885C13.8148 21.6472 13.5662 22.1422 13.1075 22.2939C11.6578 22.7733 9.96471 23.0449 8.16609 23.0449C6.85968 23.0449 5.61049 22.9017 4.47078 22.6406C4.44793 22.6354 4.42497 22.6302 4.40242 22.625C3.76443 22.4793 3.24438 22.3608 2.67488 21.9102C2.33417 21.6406 1.95534 21.1648 1.76863 20.7725C1.45596 20.1153 1.45632 19.465 1.45711 18.6602C1.45715 18.6197 1.45808 18.5784 1.45808 18.5371V5.96875C1.45841 4.14066 3.31402 3.08015 4.8614 3.43457C5.86757 3.66502 6.98544 3.79492 8.16609 3.79492C10.296 3.79491 12.2082 3.37356 13.629 2.70996C15.3174 1.92139 17.4899 1.46094 19.8331 1.46094ZM13.9991 8.46094C16.0932 8.46094 17.7911 10.1588 17.7911 12.2529C17.7911 14.347 16.0932 16.0449 13.9991 16.0449C11.9051 16.0448 10.2081 14.3469 10.2081 12.2529C10.2081 10.1589 11.9051 8.46105 13.9991 8.46094ZM6.41609 12.2529C7.06037 12.253 7.58308 12.7756 7.58308 13.4199V13.4297C7.58308 14.074 7.06037 14.5966 6.41609 14.5967C5.77176 14.5967 5.2491 14.074 5.2491 13.4297V13.4199C5.2491 12.7756 5.77176 12.2529 6.41609 12.2529ZM13.9991 10.2109C12.8716 10.2111 11.9581 11.1254 11.9581 12.2529C11.9581 13.3804 12.8716 14.2948 13.9991 14.2949C15.1267 14.2949 16.0411 13.3805 16.0411 12.2529C16.0411 11.1253 15.1267 10.2109 13.9991 10.2109ZM21.5831 9.91016C22.2272 9.9104 22.7491 10.433 22.7491 11.0771V11.0879C22.749 11.732 22.2271 12.2537 21.5831 12.2539C20.9388 12.2539 20.4162 11.7321 20.4161 11.0879V11.0771C20.4161 10.4328 20.9387 9.91016 21.5831 9.91016Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.5 16.4348C19.2548 16.4348 17.4348 18.2548 17.4348 20.5C17.4348 22.7452 19.2548 24.5652 21.5 24.5652C23.7452 24.5652 25.5652 22.7452 25.5652 20.5C25.5652 18.2548 23.7452 16.4348 21.5 16.4348ZM16 20.5C16 17.4624 18.4624 15 21.5 15C24.5376 15 27 17.4624 27 20.5C27 23.5376 24.5376 26 21.5 26C18.4624 26 16 23.5376 16 20.5Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20.543 22.4096C20.543 21.8814 20.9712 21.4531 21.4995 21.4531H21.5081C22.0364 21.4531 22.4646 21.8814 22.4646 22.4096C22.4646 22.9379 22.0364 23.3662 21.5081 23.3662H21.4995C20.9712 23.3662 20.543 22.9379 20.543 22.4096Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.5006 17.3906C21.8968 17.3906 22.218 17.7118 22.218 18.108V20.0211C22.218 20.4173 21.8968 20.7385 21.5006 20.7385C21.1044 20.7385 20.7832 20.4173 20.7832 20.0211V18.108C20.7832 17.7118 21.1044 17.3906 21.5006 17.3906Z"
        fill="currentColor"
      />
    </svg>
  );
}
