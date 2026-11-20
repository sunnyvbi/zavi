"use client";

import { COOKED_LABEL, COOKING_LABEL, WAITING_FOR_FILE } from "./setupCopy";

export function CookingBar({
  pct, ready = false, waiting = false, sub = null,
}: { pct: number; ready?: boolean; waiting?: boolean; sub?: string | null }) {
  return (
    <div className="sticky top-4 z-20 mx-auto mb-4 w-[280px] rounded-2xl border border-rule bg-cream px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[14px]">🍳</span>
        <span className="flex-1 text-[14px] font-semibold text-ink">{ready ? COOKED_LABEL : waiting ? WAITING_FOR_FILE : COOKING_LABEL}</span>
        <span className="text-[12px] font-semibold tabular-nums text-inkMuted">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Growth strategy progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-rule"
      >
        <div className="h-full rounded-full bg-ink transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
      {sub && <p className="mt-2 text-[13px] leading-5 text-inkMuted">{sub}</p>}
    </div>
  );
}
