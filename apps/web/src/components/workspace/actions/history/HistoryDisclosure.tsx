"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export function HistoryDisclosure({ id, title, count, icon: Icon, openSignal = 0, children }: { id: string; title: string; count: number; icon: LucideIcon; openSignal?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  return <section aria-label={title} className="min-w-0 overflow-hidden rounded-2xl border border-ca-border bg-ca-bg shadow-ca-sm">
    <h3><button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)} className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-5 text-left text-base font-semibold leading-6 text-ca-xdark transition-colors hover:bg-ca-subtle focus-visible:shadow-ca-focus focus-visible:outline-none">
      <Icon className="size-5 shrink-0 text-ca-secondary" aria-hidden />
      {title}<span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-ca-subtle px-2 text-ca-eyebrow font-semibold tabular-nums text-ca-dark">{count}</span>
      <ChevronDown aria-hidden className={cn("ml-auto size-4 shrink-0 text-ca-secondary transition-transform duration-200 ease-ca-spring motion-reduce:transition-none", open && "rotate-180")} />
    </button></h3>
    <div id={id} hidden={!open} className="border-t border-ca-border">{children}</div>
  </section>;
}
