"use client";

import { cn } from "@/lib/cn";
import type { ChannelTabKey } from "./ChannelTabs";

const TAB = "inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-ca-action font-semibold transition-[background-color,border-color,transform,box-shadow] duration-ca-press ease-ca-standard active:scale-[0.96] focus-visible:shadow-ca-focus focus-visible:outline-none compact:px-2.5";

export function ChannelTabBar({
  tabs,
  active,
  onSelect,
  count,
  settingsCount = 0,
  libraryCount = 0,
  label,
}: {
  tabs: ReadonlyArray<readonly [ChannelTabKey, string]>;
  active: ChannelTabKey;
  onSelect: (tab: ChannelTabKey) => void;
  count: number;
  settingsCount?: number;
  libraryCount?: number;
  label: string;
}) {
  if (tabs.length < 2) return null;
  return (
    <div role="tablist" aria-label={`${label} views`} className="inline-flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-full bg-ca-surface p-0.5">
      {tabs.map(([key, text]) => {
        const selected = key === active;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(key)}
            className={cn(TAB, selected ? "bg-ca-bg text-ca-primary shadow-ca-sm" : "text-ca-secondary hover:text-ca-primary")}
          >
            {text}
            {key === "overview" && count > 0 && <span data-testid="channel-tab-count" className="font-normal">({count})</span>}
            {key === "library" && libraryCount > 0 && <span data-testid="channel-tab-library-count" className="font-normal">({libraryCount})</span>}
            {key === "settings" && settingsCount > 0 && (
              <span data-testid="channel-tab-settings-new" className="font-normal">{settingsCount} new</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
