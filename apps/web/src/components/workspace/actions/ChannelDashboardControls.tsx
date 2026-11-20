"use client";

import { RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { periodLabel, type GadsRange } from "../agent/google-ads/types";
import { ChannelControlsSlot } from "../layout/ChannelHeaderRow";
import { OnTab } from "../layout/channelPage";
import { DateRangeMenu, toolbarButton } from "./DateRangeMenu";
import type { CustomSpan, PickedRange } from "./dateRange";

export function ChannelDashboardControls({
  ranges,
  range,
  pickedId,
  onPick,
  onRefresh,
  refreshing,
  scan,
  allowCustom = false,
  custom = null,
  period = null,
  hideRange = false,
}: {
  ranges: GadsRange[];
  range: GadsRange;
  pickedId: string;
  onPick: (range: PickedRange) => void;
  onRefresh: () => void;
  refreshing: boolean;
  scan: boolean;
  allowCustom?: boolean;
  custom?: CustomSpan | null;
  period?: { from: string; to: string } | null;
  hideRange?: boolean;
}) {
  return (
    <OnTab tab="analytics">
      <ChannelControlsSlot>
        <span className="inline-flex shrink-0 flex-nowrap items-center gap-2 compact:flex-nowrap">
          {!hideRange && <DateRangeMenu label={periodLabel(range)} ranges={ranges} pickedId={pickedId} onPick={onPick} allowCustom={allowCustom} custom={custom} period={period} />}
          {!scan && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              data-testid="channel-refresh"
              className={cn(toolbarButton, "px-3 font-semibold disabled:opacity-60 compact:w-9 compact:justify-center compact:px-0")}
            >
              <RotateCw className={cn("size-4 shrink-0", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden />
              <span className="compact:sr-only">{refreshing ? "Reading…" : "Refresh"}</span>
            </button>
          )}
        </span>
      </ChannelControlsSlot>
    </OnTab>
  );
}
