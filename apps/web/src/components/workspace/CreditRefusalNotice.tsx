"use client";

import { useWorkspaceOptional } from "./WorkspaceShell";
import { MoneyExchangeWarningIcon } from "./LowCreditsWarning";
import { isMember } from "@/lib/members";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import type { CreditRefusal } from "@/lib/workspace/creditRefusal";

export const BILLING_URL = "/workspace?tab=settings#billing";

export function CreditRefusalNotice({
  refusal,
  className = "",
  onOpenBilling,
}: {
  refusal: CreditRefusal;
  className?: string;
  onOpenBilling?: () => void;
}) {
  const ws = useWorkspaceOptional();
  const canManageBilling = ws ? !isMember(ws.role) : true;

  function goBilling() {
    if (onOpenBilling) onOpenBilling();
    else if (ws) openBillingSettings(ws.openTab);
    else window.location.href = BILLING_URL;
  }

  const subline = canManageBilling
    ? refusal.subline
    : [refusal.subline, "Ask your workspace owner to add credits."].filter(Boolean).join(". ");

  return (
    <div
      role="alert"
      className={`credit-card flex w-full flex-wrap items-center gap-3 rounded-[16px] border border-rule bg-cream p-4 font-sans shadow-[0px_1px_2px_rgba(14,15,17,0.05)] ${className}`}
    >
      <div className="flex min-w-[min(15rem,100%)] flex-1 items-start gap-3">
        <MoneyExchangeWarningIcon />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[14px] leading-[22px] tracking-[0.15px] text-ink [word-break:break-word]">
            <span className="font-semibold">{refusal.headline}</span>
            <span className="font-normal">{refusal.detail}</span>
          </p>
          {subline && (
            <p className="text-[13px] leading-5 tracking-[0.01px] text-inkMuted">{subline}</p>
          )}
        </div>
      </div>
      {canManageBilling && (
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={goBilling}
            className="flex h-10 shrink-0 items-center justify-center rounded-cta border border-rule bg-transparent px-4 text-[16px] font-medium leading-5 tracking-[0.01px] text-ink transition-colors hover:bg-creamDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Buy Credits
          </button>
          <button
            type="button"
            onClick={goBilling}
            className="flex h-10 shrink-0 items-center justify-center rounded-cta bg-ink px-4 text-[16px] font-semibold leading-5 tracking-[0.01px] text-cream transition-colors hover:bg-inkSoft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Upgrade Plan
          </button>
        </div>
      )}
    </div>
  );
}
