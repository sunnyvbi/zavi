"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { AdPlacementPreview } from "./AdPlacementPreview";
import type { AdReviewModel } from "./adReviewModel";

const PREVIEW_LABELS = { feed: "Feed preview", search: "Search preview", video: "Video preview", vertical: "Video preview", conversation: "Ad preview" };

export function AdCreativePreview({ model, platformName, aiGenerated, onRefresh, refreshing }: { model: AdReviewModel; platformName: string; aiGenerated?: boolean; onRefresh?: () => void; refreshing?: boolean }) {
  const [selected, setSelected] = useState(0);
  const active = selected < model.creatives.length ? selected : 0;
  const creative = model.creatives[active];
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(active);
  return (
    <div className="flex min-w-0 flex-col items-center gap-4" data-testid="ad-creative-preview">
      <p className="self-start text-sm font-semibold leading-5 text-inkMuted">{model.draftOnly && creative ? "Draft preview" : PREVIEW_LABELS[model.format]}</p>
      {model.creatives.length > 1 && <div ref={listRef} className="relative inline-flex max-w-full flex-wrap gap-0.5 rounded-xl border border-rule bg-creamDeep p-0.5" role="group" aria-label="Ad previews"><SlidingIndicator box={box} className="rounded-lg bg-cream shadow-sm" />{model.creatives.map((_, index) => <button key={index} type="button" aria-pressed={active === index} onClick={() => setSelected(index)} className={cn("relative h-8 min-w-16 rounded-lg px-3 text-xs tabular-nums transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted", active === index ? "font-semibold text-ink" : "font-medium text-inkMuted hover:text-ink")}>Ad {index + 1}</button>)}</div>}
      {creative ? <AdPlacementPreview creative={creative} format={model.format} platformName={platformName} channelSlug={model.channelSlug} draftOnly={model.draftOnly} aiGenerated={aiGenerated} /> : <div className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-rule bg-cream p-6 text-center text-sm leading-relaxed text-inkMuted"><ImageOff className="size-6" aria-hidden /><p>This action does not include creative content to preview.</p></div>}
      {onRefresh && <Button type="button" variant="secondary" className="self-start text-sm" disabled={refreshing} onClick={onRefresh}>{refreshing ? "Refreshing preview…" : "Refresh preview"}</Button>}
    </div>
  );
}
