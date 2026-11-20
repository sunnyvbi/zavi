"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export const ACTION_HOW_IT_WORKS = "How it works";
const InlineInstructions = createContext(false);
export function useInlineActionInstructions() { return useContext(InlineInstructions); }
export function InlineActionInstructions({ children }: { children: ReactNode }) { return <InlineInstructions.Provider value={true}>{children}</InlineInstructions.Provider>; }

export function ActionHowItWorks({ children, testId }: { children: ReactNode; testId: string }) {
  return <details data-testid={testId} className="group/ad-instructions mt-2 min-w-0 border-t border-rule pt-1 text-inkSoft"><summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg text-sm font-semibold text-inkMuted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 group-open/ad-instructions:text-ink [&::-webkit-details-marker]:hidden">{ACTION_HOW_IT_WORKS}<ChevronDown className="size-4 shrink-0 transition-transform group-open/ad-instructions:rotate-180 motion-reduce:transition-none" aria-hidden /></summary><InlineInstructions.Provider value={true}><div className="mt-1 min-w-0 space-y-4 pb-1">{children}</div></InlineInstructions.Provider></details>;
}
