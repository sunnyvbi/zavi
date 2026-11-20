import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { cn } from "../../lib/utils";

export function Accordion({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("divide-y divide-border border-y border-border", className)}>{children}</div>;
}

export function AccordionItem({ title, children, defaultOpen }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-left text-base font-medium [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <Plus aria-hidden className="size-5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-45" />
      </summary>
      <div className="pb-5 pr-8 text-muted-foreground">{children}</div>
    </details>
  );
}
