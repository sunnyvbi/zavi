"use client";

import type { ReactNode } from "react";

export const CHIP_CLASS =
  "group flex shrink-0 snap-start items-center gap-2 whitespace-nowrap rounded-full border border-rule bg-cream py-1.5 pl-1.5 pr-4 text-[14px] font-medium compact:gap-2.5 compact:py-2 compact:pr-[18px] compact:text-[16px] tracking-[-0.012em] text-inkMuted transition-colors hover:border-inkLight/40 hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40";

export function ChipIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-creamDeep transition-colors group-hover:bg-bone compact:h-8 compact:w-8">
      {children}
    </span>
  );
}
