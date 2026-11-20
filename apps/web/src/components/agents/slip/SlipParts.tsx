"use client";

import type { ReactNode } from "react";
import type { SlipHero, SlipStage } from "./decisionSlip";

const SLAB: Record<SlipStage, string> = {
  waiting: "bg-[#fbf6ea]",
  queued: "bg-[#f4f6fb]",
  sending: "bg-[#f4f6fb]",
  unknown: "bg-[#fdf6e3]",
  done: "bg-[#eef8f1]",
  failed: "bg-[#fdeef0]",
  rejected: "bg-[#f5f5f4]",
  closed: "bg-[#f5f5f4]",
  held: "bg-[#faf6ee]",
  partial: "bg-[#fdf6e3]",
};
const PILL: Record<SlipStage, string> = {
  waiting: "bg-[#8a5a10] text-white",
  queued: "bg-[#dbeafe] text-[#1e40af]",
  sending: "bg-[#dbeafe] text-[#1e40af]",
  unknown: "bg-[#fef3c7] text-[#92400e]",
  done: "bg-[#d1fae5] text-[#065f46]",
  failed: "bg-[#ffe4e6] text-[#9f1239]",
  rejected: "bg-[#e7e5e4] text-[#44403c]",
  closed: "bg-[#e7e5e4] text-[#44403c]",
  held: "bg-[#efe6d2] text-[#5c4a1f]",
  partial: "bg-[#fef3c7] text-[#92400e]",
};
export function slipStageClasses(stage: SlipStage): { slab: string; pill: string } {
  return { slab: SLAB[stage], pill: PILL[stage] };
}

const CHIP: Record<"up" | "down" | "flat", string> = {
  up: "bg-[#d1fae5] text-[#047857]",
  down: "bg-[#e0f2fe] text-[#0369a1]",
  flat: "bg-white text-[#7a6a4a]",
};

export function SlipCard({ children, label, decisionId }: { children: ReactNode; label: string; decisionId: string }) {
  return (
    <section
      role="region"
      aria-label={label}
      data-decision-id={decisionId}
      data-testid="approval-slip"
      className="w-full min-w-0 overflow-hidden rounded-2xl border border-[#efe2c3] bg-white text-[#2b2416] shadow-[0_1px_2px_rgba(43,36,22,0.06),0_10px_28px_-16px_rgba(43,36,22,0.25)]"
    >
      {children}
    </section>
  );
}

export function SlipSlab({
  stage,
  status,
  platform,
  mark,
  logo,
  target,
  title,
  hero,
  children,
  literal = false,
  roomy = false,
  statusTestId = "slip-status",
  titleTestId,
}: {
  literal?: boolean;
  roomy?: boolean;
  statusTestId?: string;
  titleTestId?: string;
  stage: SlipStage;
  status: string;
  platform: string;
  mark: string;
  logo?: { src: string; tile: string };
  target: string | null;
  title: string;
  hero: SlipHero | null;
  children?: ReactNode;
}) {
  const ended = stage === "failed" || stage === "rejected" || stage === "closed";
  const shown = hero
    ? literal
      ? hero
      : stage === "failed"
      ?
        { eyebrow: "You asked for", amount: hero.amount, unit: hero.unit, was: hero.was, chip: null }
      : ended
      ? { eyebrow: "Stays at", amount: hero.before, unit: hero.beforeUnit, was: null, chip: null }
      : stage === "done"
        ? { eyebrow: "Now spending", amount: hero.amount, unit: hero.unit, was: null, chip: null }
        : hero
    : null;
  return (
    <div data-testid="slip-slab" data-stage={stage} className={SLAB[stage]}>
      <div className={roomy ? "px-5 py-4" : "px-4 pt-3.5 pb-4 sm:px-5"}>
        <div className={`flex justify-between gap-2 ${roomy ? "items-baseline" : "items-center"}`}>
          <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold">
            {logo ? (
              <span aria-hidden className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] ${logo.tile}`}>
                <img data-testid="slip-logo" src={logo.src} alt="" className="h-3.5 w-3.5" />
              </span>
            ) : (
              <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-[#2b2416] text-[11px] font-extrabold text-white">
                {mark}
              </span>
            )}
            <span className="min-w-0 shrink truncate text-[#7a6a4a]">{platform}</span>
            {target && (
              <>
                <span aria-hidden className="text-[#a8977a]">
                  ·
                </span>
                <span dir="auto" className="min-w-0 truncate">
                  {target}
                </span>
              </>
            )}
          </div>
          <span data-testid={statusTestId} className={`max-w-[60%] shrink-0 rounded-full px-2.5 py-1 text-right text-[11px] font-semibold leading-tight ${PILL[stage]}`}>
            {status}
          </span>
        </div>
        {shown ? (
          <>
            <div className={`${roomy ? "mt-4" : "mt-3"} text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a8977a]`}>{shown.eyebrow}</div>
            <div className={`${roomy ? "mt-2" : "mt-1"} flex flex-wrap items-end justify-between gap-x-3 gap-y-1`}>
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span data-testid="slip-amount" className="text-[40px] font-extrabold leading-none tracking-[-0.03em] tabular-nums">
                  {shown.amount}
                </span>
                {shown.unit && <span className="text-[15px] font-semibold text-[#7a6a4a]">{shown.unit}</span>}
              </div>
              {(shown.was || shown.chip) && (
                <div className="flex items-center gap-2 pb-0.5">
                  {shown.was && <span className="text-[13px] font-semibold tabular-nums text-[#a8977a] line-through">{shown.was}</span>}
                  {shown.chip && <span className={`rounded-md px-1.5 py-0.5 text-[12.5px] font-bold tabular-nums ${CHIP[shown.chip.tone]}`}>{shown.chip.text}</span>}
                </div>
              )}
            </div>
            <p dir="auto" data-testid={titleTestId} className={`${roomy ? "mt-2" : "mt-1.5"} break-words text-[13px] font-semibold leading-snug text-[#2b2416]`}>
              {title}
            </p>
          </>
        ) : (
          <p dir="auto" data-testid={titleTestId} className={`${roomy ? "mt-4" : "mt-3"} break-words text-[18px] font-bold leading-snug tracking-[-0.01em]`}>
            {title}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

export function SlipSection({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="px-4 pt-3.5 sm:px-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#a8977a]">{label}</div>
      <div className="mt-1 min-w-0">{children}</div>
    </div>
  );
}

export function SlipFlag({ children, tone = "note", testId }: { children: ReactNode; tone?: "note" | "risk"; testId?: string }) {
  return (
    <div
      className={`mx-4 mt-3 flex gap-2 rounded-xl border px-3 py-2.5 text-[13px] leading-snug sm:mx-5 ${
        tone === "risk" ? "border-[#f3b7ae] bg-[#fdf1ef] text-[#5c1a12]" : "border-[#e8c46a] bg-[#fdf9ee] text-[#2b2416]"
      }`}
    >
      <span aria-hidden className={`mt-[1px] shrink-0 font-bold ${tone === "risk" ? "text-[#b3261e]" : "text-[#8a5a10]"}`}>
        ⚑
      </span>
      <div data-testid={testId} className="min-w-0">
        {children}
      </div>
    </div>
  );
}

export const SLIP_PRIMARY =
  "flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[#0f1729] px-3 py-2.5 text-center text-[14px] font-bold leading-tight text-white transition hover:bg-[#1c2740] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f1729] focus-visible:ring-offset-2";
export const SLIP_SECONDARY =
  "flex min-h-[40px] w-full items-center justify-center rounded-xl border border-[#e6d6b0] bg-white px-3 py-2 text-center text-[13px] font-semibold text-[#2b2416] transition hover:bg-[#fff8ea] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d8881e]";
export const SLIP_QUIET =
  "inline-flex min-h-[44px] items-center rounded-lg px-2 text-[13px] font-semibold text-[#7a6a4a] transition hover:text-[#b3261e] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d8881e]";

export function SlipFooter({ children }: { children: ReactNode }) {
  return <div className="px-4 pt-3.5 pb-3 sm:px-5">{children}</div>;
}

export type SlipStep = { label: string; sub: string | null; state: "done" | "now" | "todo" | "fail" | "warn" };

export function SlipTracker({ steps }: { steps: SlipStep[] }) {
  return (
    <ol data-testid="slip-tracker" className="px-4 pt-4 sm:px-5">
      {steps.map((st, i) => (
        <li key={st.label} className="relative flex gap-3 pb-3 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden className={`absolute left-[9px] top-[20px] h-[calc(100%-18px)] w-[2px] ${st.state === "done" ? "bg-[#2b2416]" : "bg-[#eadfc8]"}`} />}
          <StepDot state={st.state} />
          <div className="-mt-[1px] min-w-0 flex-1">
            <div className={`text-[13.5px] font-semibold ${st.state === "todo" ? "text-[#a8977a]" : st.state === "fail" ? "text-[#9f1239]" : st.state === "warn" ? "text-[#92400e]" : "text-[#2b2416]"}`}>{st.label}</div>
            {st.sub && <div className={`text-[12px] ${st.state === "fail" ? "text-[#be123c]" : st.state === "warn" ? "text-[#92400e]" : "text-[#7a6a4a]"}`}>{st.sub}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepDot({ state }: { state: SlipStep["state"] }) {
  const base = "relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white";
  if (state === "done") return <span aria-label="done" className={`${base} bg-[#2b2416]`}>✓</span>;
  if (state === "now") return <span aria-label="in progress" className={`${base} animate-pulse bg-[#2563eb]`}>•</span>;
  if (state === "fail") return <span aria-label="failed" className={`${base} bg-[#e11d48]`}>✕</span>;
  if (state === "warn") return <span aria-label="unknown" className={`${base} bg-[#f59e0b]`}>?</span>;
  return <span aria-hidden className="relative z-10 h-5 w-5 shrink-0 rounded-full border-2 border-[#eadfc8] bg-white" />;
}

export function SlipReceipt({
  title,
  rows,
  limitsNow = [],
}: {
  title: string;
  rows: { label: string; before: string | null; after: string }[];
  limitsNow?: { label: string; value: string }[];
}) {
  if (!rows.length && !limitsNow.length) return null;
  return (
    <div data-testid="slip-receipt" className="mx-4 mt-3 max-h-80 overflow-auto rounded-xl border border-dashed border-[#d9c9a3] px-3 py-2.5 sm:mx-5">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#a8977a]">{title}</div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span dir="auto" className="min-w-0 shrink-0 text-[#7a6a4a]">
              {r.label}
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-1.5 break-words text-right tabular-nums [overflow-wrap:anywhere]">
              {r.before && <span className="text-[#a8977a] line-through">{r.before}</span>}
              {r.before && <span aria-hidden className="text-[#a8977a]">→</span>}
              <span dir="auto" className="font-bold text-[#2b2416]">
                {r.after}
              </span>
            </span>
          </div>
        ))}
      </div>
      {limitsNow.length > 0 && (
        <div data-testid="slip-limits-now" className={rows.length ? "mt-2.5 border-t border-[#eadfc8] pt-2" : ""}>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#a8977a]">Ad limits after you approved</div>
          {limitsNow.map((l) => (
            <div key={l.label} className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="text-[#7a6a4a]">{l.label}</span>
              <span className="font-bold tabular-nums text-[#2b2416]">{l.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
