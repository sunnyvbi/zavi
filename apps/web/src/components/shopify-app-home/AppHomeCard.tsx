import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function AppHomeCard({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <section id={id} className={cn("border-y border-neutral-200 bg-white shadow-sm sm:rounded-xl sm:border", className)}>{children}</section>;
}

export function AppHomeCardHeader({ title, aside, className }: { title: string; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-4 pt-4", className)}>
      <h2 className="text-[15px] font-semibold text-neutral-900">{title}</h2>
      {aside}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 text-[13px] text-brand hover:underline", className)}>
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}
