"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PRIMARY =
  "inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-semibold text-cream transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-40";
export const SECONDARY =
  "inline-flex h-11 items-center gap-2 rounded-xl border border-rule bg-cream px-4 text-[14px] font-semibold text-ink transition-colors hover:bg-creamDeep";

export const FooterSlot = createContext<{ el: HTMLElement | null; back: ReactNode }>({ el: null, back: null });

export function StickyActions({ skip, note, children }: { skip?: ReactNode; note?: ReactNode; children: ReactNode }) {
  const { el, back } = useContext(FooterSlot);
  const row = (
    <>
      {back}
      <span className="min-w-0 flex-1 truncate text-[13px] text-inkMuted">{note}</span>
      {skip}
      {children}
    </>
  );
  if (el) return createPortal(row, el);
  return (
    <div
      role="group"
      aria-label="Step actions"
      className="sticky bottom-0 z-10 -mx-6 mt-8 flex items-center gap-3 border-t border-rule bg-white px-6 py-4 sm:-mx-8 sm:px-8 [&_button]:whitespace-nowrap"
    >
      {row}
    </div>
  );
}

export function SkipButton({ onSkip }: { onSkip: () => void }) {
  return (
    <button
      type="button"
      onClick={onSkip}
      className="inline-flex h-12 shrink-0 items-center rounded-cta border border-rule bg-white px-6 text-[14px] font-semibold text-ink hover:border-ink"
    >
      Skip this step
    </button>
  );
}
