"use client";

import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { SplitCardItem } from "./SplitCard";
import { AD_PREVIEW_PANE_CLASS } from "./ads/adPreviewStyles";
import { ActionHelpProvider } from "./ActionHelp";
import { slipStageClasses } from "@/components/agents/slip/SlipParts";
import { channelSlipStage } from "./channelSlip";
import { isSlow } from "./StatusBanner";
import type { ActionItem } from "./types";

export function ActionCardLayout({ item, main, preview, footer, banner, slab, approving = false, compact = false, advertising = false, previewTestId = "split-right" }: {
  item: SplitCardItem;
  slab?: ReactNode;
  approving?: boolean;
  banner?: ReactNode;
  main: ReactNode;
  preview?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  advertising?: boolean;
  previewTestId?: string;
}) {
  const split = preview !== null && preview !== undefined && preview !== false;
  const working = (item.exec_status === "queued" || item.exec_status === "dispatching") && item.exec_waiting !== "approvals";
  const dim = working ? "pointer-events-none opacity-60 transition-opacity motion-reduce:transition-none" : undefined;
  const stage = channelSlipStage(item, { approving });
  const slow = isSlow(item as ActionItem);
  const tone = stage ? slipStageClasses(stage) : null;
  return <article data-testid={`action-${item.id}`} data-action-type={item.action_type} data-source={item.source} data-layout={advertising ? split ? "ads-split" : "ads-single" : split ? "split" : "single"} data-card-design="channel-reference" className="ads-container min-w-0" aria-busy={working || undefined}>
    <ActionHelpProvider>{(help) => <Card className="overflow-hidden !rounded-2xl border-[#efe2c3] bg-white shadow-[0_1px_2px_rgba(43,36,22,0.06),0_10px_28px_-16px_rgba(43,36,22,0.25)]">
      {slab && (
        <div data-testid="slip-band" data-stage={stage ?? "none"} data-slow={slow ? "true" : undefined} className={cn("border-b border-[#efe2c3]", tone?.slab ?? "bg-[#fbf6ea]")}>
          <div className={cn("min-w-0", compact ? "px-5 py-4 sm:px-6" : "px-6 py-5 sm:px-8")}>{slab}</div>
        </div>
      )}
      {banner}
      <div data-testid="split-grid" className={cn("grid min-w-0 grid-cols-1", split ? "ads-review-grid ads-wide:grid-cols-ad-review ads-wide:ads-review-grid-wide" : "ads-single-grid")}>
        <div data-testid="split-left" className={cn("ads-grid-main min-w-0", compact ? "px-5 sm:px-6" : "px-6 sm:px-8", slab ? (compact ? "pt-4" : "pt-5") : compact ? "pt-6" : "pt-8", dim)}>{main}</div>
        {split && <div data-testid={previewTestId} className={cn(AD_PREVIEW_PANE_CLASS, dim)}>{preview}</div>}
        <div data-testid="split-footer" className={cn("ads-grid-foot min-w-0", compact ? "px-5 pb-5 sm:px-6" : "px-6 pb-6 sm:px-8")}>{footer}{help}</div>
      </div>
    </Card>}</ActionHelpProvider>
  </article>;
}
