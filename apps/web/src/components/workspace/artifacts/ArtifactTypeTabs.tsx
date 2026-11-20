"use client";

import { cn } from "@/lib/cn";
import { TabIndicator, useTabIndicator } from "../layout/TabIndicator";
import type { ArtifactFilter } from "./types";

export const TYPE_TABS: ReadonlyArray<{ value: ArtifactFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "website", label: "Websites" },
  { value: "presentation", label: "Slides" },
  { value: "dashboard", label: "Dashboards" },
  { value: "spreadsheet", label: "Sheets" },
  { value: "document", label: "Reports" },
  { value: "file", label: "Files" },
];

export function ArtifactTypeTabs({
  value,
  onChange,
  className,
}: {
  value: ArtifactFilter;
  onChange: (value: ArtifactFilter) => void;
  className?: string;
}) {
  const { listRef, geometry } = useTabIndicator<HTMLDivElement>(value);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Artifact type"
      className={cn("relative flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
    >
      <TabIndicator geometry={geometry} variant="pill" />
      {TYPE_TABS.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.value)}
            className={cn(
              "relative z-10 h-8 shrink-0 rounded-full px-3 text-[13px] font-medium transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted",
              selected ? "text-cream" : "text-inkMuted hover:bg-ink/[0.04] hover:text-ink",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
