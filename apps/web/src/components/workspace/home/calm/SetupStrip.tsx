"use client";

import { useState } from "react";

export function SetupStrip({
  brain,
  onFinish,
}: {
  brain: { filled: number; total: number } | null;
  onFinish: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);

  if (
    dismissed ||
    !brain ||
    brain.total <= 0 ||
    brain.filled >= brain.total
  ) {
    return null;
  }

  const pct = Math.round((brain.filled / brain.total) * 100);

  return (
    <div className="mb-6 flex items-center gap-4 rounded-2xl border border-[#f0f0f0] bg-white p-3">
      <div
        className="h-2 w-[67px] shrink-0 overflow-hidden rounded-full bg-[#f0f0f0]"
        aria-hidden
      >
        <div
          className="h-full rounded-full bg-[#0e0f11]"
          style={{ width: `${Math.max(pct, 4)}%` }}
        />
      </div>
      <div className="min-w-0 flex-1 text-[16px] leading-5 tracking-[0.14px] text-[#1f1f1f]">
        <b className="font-semibold">{pct}% set up.</b>{" "}
        Finish your company brain so your team can run more on its own.
      </div>
      <button
        type="button"
        onClick={onFinish}
        className="h-10 shrink-0 rounded-cta bg-[#0e0f11] px-4 text-[16px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
      >
        Finish Setup
      </button>
      <button
        type="button"
        aria-label="Dismiss setup"
        onClick={() => setDismissed(true)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink"
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
          <path d="M6 6 18 18M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
