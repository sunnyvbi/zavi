"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";

export function PartTabs({
  labels,
  selected,
  onSelect,
  copyText,
  copyDisabled = false,
  children,
}: {
  labels: string[];
  selected: number;
  onSelect: (i: number) => void;
  copyText: string;
  copyDisabled?: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const base = useId();
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(selected);
  const panelId = (i: number) => `${base}-part-${i}`;
  return (
    <div data-testid="part-tabs">
      <div data-testid="part-tabs-bar" className="mb-3 flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div ref={listRef} role="tablist" aria-label="Parts" className="relative inline-flex max-w-full flex-wrap gap-0.5 rounded-xl border border-rule bg-creamDeep p-0.5">
          <SlidingIndicator box={box} className="rounded-lg bg-cream shadow-sm" />
          {labels.map((label, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === selected}
              aria-controls={panelId(i)}
              onClick={() => onSelect(i)}
              className={`relative min-h-8 rounded-lg px-4 py-1 text-[14px] transition-colors duration-300 [overflow-wrap:anywhere] ${
                i === selected ? "font-semibold text-ink" : "font-medium text-inkMuted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
          </div>
        </div>
        <button
          type="button"
          disabled={copyDisabled}
          aria-label={copied === selected ? "Copied" : "Copy"}
          title={copyDisabled ? "Fill the blanks first" : copied === selected ? "Copied" : "Copy"}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(copyText)
              .then(() => setCopied(selected))
              .catch(() => undefined);
          }}
          className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-cta text-inkSoft hover:bg-creamDeep hover:text-ink disabled:opacity-50"
        >
          {copied === selected ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <div role="tabpanel" id={panelId(selected)} aria-label={labels[selected]}>
        {children}
      </div>
    </div>
  );
}
