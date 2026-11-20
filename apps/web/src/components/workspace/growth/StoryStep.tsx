"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function StoryStep({
  n,
  title,
  aside,
  id,
  last = false,
  tone = "ink",
  children,
}: {
  n: number;
  title: string;
  aside?: ReactNode;
  id?: string;
  last?: boolean;
  tone?: "ink" | "needs";
  children: ReactNode;
}) {
  const headingId = `growth-story-step-${n}`;
  return (
    <section id={id} aria-label={title} className="relative scroll-mt-4 pl-12 compact:pl-10">
      {!last && (
        <span
          aria-hidden="true"
          className="absolute bottom-[-6px] left-[15px] top-[34px] w-0.5 bg-rule compact:left-[13px] compact:top-[30px]"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold text-cream compact:h-7 compact:w-7 compact:text-[13px]",
          tone === "needs" ? "bg-danger" : "bg-ink",
        )}
      >
        {n}
      </span>
      <div className="flex min-h-8 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-[3px]">
        <h2 id={headingId} className="text-[16px] font-bold tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {aside && <div className="text-[13px] text-inkMuted">{aside}</div>}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function StoryBecause({ children }: { children: ReactNode }) {
  return (
    <p className="relative py-2.5 pl-12 text-[13px] italic text-inkMuted compact:pl-10">
      <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-0 w-0.5 bg-rule compact:left-[13px]" />
      {children}
    </p>
  );
}

export function StoryBox({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-rule bg-cream", className)}>{children}</div>;
}

export function StoryRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("border-t border-rule px-4 py-3.5 first:border-t-0", className)}>{children}</div>;
}
