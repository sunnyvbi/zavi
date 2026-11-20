"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { getChannel } from "@zavi/shared";
import { cn } from "@/lib/cn";

const CARD = "rounded-2xl border border-ca-border bg-ca-bg";

export function EmptyCard({ title, testId, children }: { title: string; testId?: string; children?: ReactNode }) {
  return (
    <div data-testid={testId} className={cn(CARD, "flex flex-col items-center px-6 py-10 text-center")}>
      <h4 className="text-ca-title font-semibold tracking-tight text-ca-xdark">{title}</h4>
      {children}
    </div>
  );
}

export function EmptyBody({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div data-testid={testId} className="mt-2 max-w-[60ch] text-ca-body text-ca-secondary">{children}</div>;
}

export function EmptySectionNote({ children }: { children: ReactNode }) {
  return <p className={cn(CARD, "px-6 py-10 text-center text-ca-body text-ca-secondary")}>{children}</p>;
}

const STEP_STARTS_MS = [0, 20_000, 60_000];
const BAR_PACE_MS = 45_000;

function cookingSteps(slug: string | undefined, name: string): string[] {
  const paid = slug ? getChannel(slug)?.category === "paid" : false;
  return [paid ? `Reading your ${name} account` : `Reading how ${name} is doing`, "Checking what worked and what didn't", "Writing suggestions"];
}

function useElapsed(startedAt: string | null): number {
  const [mounted] = useState(() => Date.now());
  const [now, setNow] = useState(mounted);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Math.max(0, now - (Number.isFinite(parsed) ? parsed : mounted));
}

export function CookingCard({ slug, name, startedAt, children }: { slug?: string; name?: string; startedAt: string | null; children?: ReactNode }) {
  const label = name ?? "this channel";
  const elapsed = useElapsed(startedAt);
  const current = STEP_STARTS_MS.filter((at) => elapsed >= at).length - 1;
  const filled = 4 + 90 * (1 - Math.exp(-elapsed / BAR_PACE_MS));
  return (
    <div data-testid="empty-running" aria-live="polite" className={cn(CARD, "flex items-start gap-4 p-5")}>
      <span aria-hidden className="block size-12 shrink-0 overflow-hidden rounded-xl">
        <img src="/zavi-icon.svg" alt="" className="h-full w-full" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="text-ca-title font-semibold tracking-tight text-ca-xdark">Cooking up new suggestions for {label}</p>
          <span data-testid="running-badge" className="inline-flex items-center gap-1.5 rounded-full bg-ca-subtle px-2.5 py-0.5 text-ca-eyebrow font-medium text-ca-xdark">
            <span aria-hidden className="size-1.5 rounded-full bg-ca-success motion-safe:animate-pulse" />
            Cooking
          </span>
        </div>
        <p className="mt-1 text-ca-body text-ca-secondary">Usually a few minutes. You can leave this page; they&apos;ll be waiting here.</p>
        <div aria-hidden className="mt-4 h-1.5 overflow-hidden rounded-full bg-ca-subtle">
          <div className="h-full rounded-full bg-ca-action transition-[width] duration-1000 ease-linear" style={{ width: `${filled}%` }} />
        </div>
        <ul className="mt-4 flex list-none flex-col gap-2.5 p-0">
          {cookingSteps(slug, label).map((step, n) => (
            <li key={step} data-step={n < current ? "done" : n === current ? "current" : "next"} className={cn("flex items-center gap-3 text-ca-body transition-colors duration-300", n === current ? "font-semibold text-ca-xdark" : "text-ca-secondary")}>
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                {n < current ? (
                  <Check className="size-4 text-ca-success motion-safe:animate-ca-rise" strokeWidth={2.5} />
                ) : n === current ? (
                  <span className="size-4 animate-spin rounded-full border-2 border-ca-border border-t-ca-action motion-reduce:animate-none" />
                ) : (
                  <span className="size-1.5 rounded-full bg-ca-border" />
                )}
              </span>
              {step}
            </li>
          ))}
        </ul>
        {children}
      </div>
    </div>
  );
}
