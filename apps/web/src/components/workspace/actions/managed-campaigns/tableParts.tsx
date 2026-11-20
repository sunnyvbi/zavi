"use client";

import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { cn } from "@/lib/cn";
import { cardButton } from "../card/styles";

export const tableHead = "whitespace-nowrap px-4 py-3 text-right text-ca-label font-normal text-ca-secondary first:pl-5 last:pr-5";
export const tableCell = "whitespace-nowrap border-t border-ca-border px-4 py-4 text-right text-ca-facts tabular-nums text-ca-xdark first:pl-5 last:pr-5";
export const tableLeft = "!text-left";
export const tableNote = "mt-1 text-ca-action text-ca-secondary";
export const tableEditButton = cn(cardButton.base, cardButton.secondary);
export const tablePrimaryButton = cn(cardButton.base, cardButton.primary);

export function LevelTabs<K extends string>({ tab, levels, label, onTab }: { tab: K; levels: ReadonlyArray<readonly [K, string]>; label: string; onTab: (key: K) => void }) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(tab);
  return (
    <div ref={listRef} role="tablist" aria-label={label} className="relative inline-flex rounded-full bg-ca-surface p-1">
      <SlidingIndicator box={box} className="rounded-full bg-ca-bg shadow-ca-sm" />
      {levels.map(([key, name]) => (
        <button key={key} role="tab" aria-selected={tab === key} type="button" onClick={() => onTab(key)} className={cn("relative rounded-full px-4 py-1.5 text-ca-label font-semibold transition-colors", tab === key ? "text-ca-xdark" : "text-ca-secondary hover:text-ca-xdark")}>
          {name}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ value }: { value: string | null }) {
  const word = value ? value.charAt(0).toUpperCase() + value.slice(1) : "Unknown";
  return <span className={cn("inline-block rounded-md px-2 py-0.5 text-ca-action", value === "active" ? "bg-ca-success-bg text-ca-success" : "bg-ca-subtle text-ca-dark")}>{word}</span>;
}

export function OnToggle({ status, busy, label, onChange, readOnly }: { status: string | null; busy: boolean; label: string; onChange: () => void; readOnly?: string }) {
  const on = status === "active";
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={readOnly} disabled={!!readOnly || busy || !["active", "paused"].includes(status ?? "")} onClick={onChange} className={cn("relative h-6 w-10 rounded-full transition-colors", readOnly ? "cursor-default" : "disabled:opacity-40", on ? "bg-ca-action" : "bg-ca-strong")}>
      <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform", on && "translate-x-4")} />
    </button>
  );
}
