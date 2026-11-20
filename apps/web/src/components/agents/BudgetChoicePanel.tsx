"use client";

import type { BudgetChoiceView, RaiseAsk } from "@/lib/approvals/decisionApi";
import { SLIP_PRIMARY, SLIP_QUIET, SLIP_SECONDARY, SlipFlag } from "./slip/SlipParts";

type Over = Extract<BudgetChoiceView, { kind: "over" }>;
export const CUTS_CANT_MAKE_ROOM = "Cuts can't make room this month: the money is already set aside for raises you approved. Raise the budget instead.";
export const CUTS_NOT_ENOUGH = "Cutting other ads can't make enough room this month. Raise the budget instead.";
export const SPEND_LEAVES_NO_ROOM = "This month's spend so far leaves no room for this raise. Raise the budget instead.";
export const DAILY_LIMIT_BLOCKS = "Your daily limit blocks this raise, not the month. Raise the daily limit instead.";
export const cutsCantWords = (why: string | null | undefined): string =>
  why === "set_aside" ? CUTS_CANT_MAKE_ROOM : why === "spent" ? SPEND_LEAVES_NO_ROOM : why === "daily_limit_only" ? DAILY_LIMIT_BLOCKS : CUTS_NOT_ENOUGH;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function raiseAskOf(v: Over): RaiseAsk {
  return {
    ...(v.raise_to_usd !== null ? { raise_budget_to_usd: v.raise_to_usd } : {}),
    ...(v.daily_limit_to_usd !== null ? { raise_daily_limit_to_usd: v.daily_limit_to_usd } : {}),
  };
}

export function raiseLabel(v: Over): string {
  if (v.raise_to_usd !== null && v.daily_limit_to_usd !== null) return `Approve and raise budget to ${usd(v.raise_to_usd)} and daily limit to ${usd(v.daily_limit_to_usd)}`;
  if (v.daily_limit_to_usd !== null) return `Approve and raise daily limit to ${usd(v.daily_limit_to_usd)}`;
  return `Approve and raise budget to ${usd(v.raise_to_usd ?? v.monthly_usd)}`;
}

export function capWords(v: Pick<Over, "month_label" | "monthly_usd" | "month_cap_usd">): string {
  const cap = typeof v.month_cap_usd === "number" && Number.isFinite(v.month_cap_usd) ? v.month_cap_usd : v.monthly_usd;
  return cap < v.monthly_usd ? `your ${usd(cap)} ${v.month_label} budget` : `your ${usd(v.monthly_usd)} budget`;
}

export function blockLines(v: Over): string[] {
  return [
    v.raise_to_usd === null
      ? null
      : v.set_aside_over
        ? `With what is already set aside for your running ads in ${v.month_label}, this goes past ${capWords(v)}.`
        : `${v.month_label} is projected at about ${usd(v.projection_usd)}, over ${capWords(v)}.`,
    v.daily_limit_to_usd !== null && v.daily_limit_usd !== null ? `This goes over your ${usd(v.daily_limit_usd)} daily ad limit.` : null,
  ].filter((x): x is string => x !== null);
}

export function monthMeter(v: Over): { capPct: number; projPct: number; cap: number } | null {
  const cap = typeof v.month_cap_usd === "number" && Number.isFinite(v.month_cap_usd) ? v.month_cap_usd : v.monthly_usd;
  if (v.raise_to_usd === null || v.set_aside_over || !(cap > 0) || !(v.projection_usd > cap)) return null;
  const max = v.projection_usd * 1.02;
  return { capPct: (cap / max) * 100, projPct: (v.projection_usd / max) * 100, cap };
}

export function BudgetChoicePanel({
  view,
  busy,
  onApproveAndRaise,
  onReject,
  onFindMoney,
  approveBlockedReason = null,
  meta = null,
}: {
  view: BudgetChoiceView;
  busy: boolean;
  onApproveAndRaise: (ask: RaiseAsk) => void;
  onReject: () => void;
  onFindMoney?: () => void;
  approveBlockedReason?: string | null;
  meta?: string | null;
}) {
  const reject = (
    <div className="mt-1 flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-[12px] text-[#a8977a]">{meta ?? ""}</span>
      <button type="button" disabled={busy} onClick={onReject} className={SLIP_QUIET}>
        Reject
      </button>
    </div>
  );
  if (view.kind === "fits") return null;
  if (view.kind === "unreadable") {
    return (
      <div data-testid="budget-choice">
        <SlipFlag>Zavi can&apos;t check your ad budget right now ({view.why}).</SlipFlag>
        <div className="px-4 pt-2 pb-3 sm:px-5">{reject}</div>
      </div>
    );
  }
  const meter = monthMeter(view);
  return (
    <div data-testid="budget-choice">
      <div className="px-4 pt-3.5 sm:px-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#a8977a]">{view.month_label}</div>
        {blockLines(view).map((l) => (
          <p key={l} className="mt-1 text-[14px] font-semibold leading-snug text-[#2b2416]">
            {l}
          </p>
        ))}
        {meter && (
          <div data-testid="month-meter" className="mt-2.5">
            <div className="relative h-2.5 w-full rounded-full bg-[#f1ead8]">
              <div className="absolute inset-y-0 left-0 rounded-l-full bg-[#2b2416]" style={{ width: `${meter.capPct}%` }} />
              <div
                className="absolute inset-y-0 rounded-r-full bg-[repeating-linear-gradient(135deg,#e11d48_0_4px,#fb7185_4px_8px)]"
                style={{ left: `${meter.capPct}%`, width: `${meter.projPct - meter.capPct}%` }}
              />
              <div className="absolute -top-1 h-[18px] w-[2px] bg-[#2b2416]" style={{ left: `${meter.capPct}%` }} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold tabular-nums">
              <span className="text-[#7a6a4a]">Budget {usd(meter.cap)}</span>
              <span className="text-[#be123c]">Over by {usd(view.projection_usd - meter.cap)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="px-4 pt-3.5 pb-3 sm:px-5">
        {view.raise_to_usd !== null && view.find_money === "none" && (
          <p data-testid="cuts-cant-make-room" className="mb-2 text-[12.5px] leading-snug text-[#5c5240]">
            {cutsCantWords(view.find_money_why)}
          </p>
        )}
        {approveBlockedReason ? (
          <p className="rounded-xl bg-[#f5efe0] px-3 py-2.5 text-[12.5px] text-[#5c5240]">{approveBlockedReason}</p>
        ) : (
          <button type="button" disabled={busy} onClick={() => onApproveAndRaise(raiseAskOf(view))} className={SLIP_PRIMARY}>
            {busy ? "Submitting…" : raiseLabel(view)}
          </button>
        )}
        {onFindMoney && view.raise_to_usd !== null && view.find_money === "available" && !approveBlockedReason && (
          <button type="button" disabled={busy} onClick={onFindMoney} className={`mt-1.5 ${SLIP_SECONDARY}`}>
            Find the money elsewhere
          </button>
        )}
        {view.raise_to_usd !== null && (
          <p className="mt-2 text-[11.5px] text-[#a8977a]">Your monthly ad budget becomes {usd(view.raise_to_usd)} from now on. Most months you&apos;ll spend less than this.</p>
        )}
        {view.daily_limit_to_usd !== null && <p className="mt-1 text-[11.5px] text-[#a8977a]">Your daily ad limit becomes {usd(view.daily_limit_to_usd)} from now on.</p>}
        {reject}
      </div>
    </div>
  );
}
