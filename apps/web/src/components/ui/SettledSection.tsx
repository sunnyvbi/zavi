"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SkeletonBar = { w: string; h: string; mt?: string; className?: string };

export function SkeletonBars({
  bars,
  minHeight,
  ariaLabel,
  onDeep = false,
}: {
  bars: SkeletonBar[];
  minHeight?: number;
  ariaLabel?: string;
  onDeep?: boolean;
}) {
  return (
    <div
      role={ariaLabel ? "status" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      style={minHeight ? { minHeight } : undefined}
    >
      {bars.map((b, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={cn(
            "animate-pulse rounded-md [animation-duration:2.4s] motion-reduce:animate-none",
            onDeep ? "bg-rule" : "bg-creamDeep",
            b.w,
            b.h,
            b.mt ?? (i === 0 ? "" : "mt-3"),
            b.className,
          )}
        />
      ))}
    </div>
  );
}

export function SettledSection({
  ready,
  skeleton,
  holdOnRefresh = true,
  className,
  children,
}: {
  ready: boolean;
  skeleton: ReactNode;
  holdOnRefresh?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const last = useRef<ReactNode>(null);
  const everReady = useRef(false);
  if (ready) {
    everReady.current = true;
    last.current = children;
  }
  const [shown, setShown] = useState(false);
  const revealed = everReady.current;
  useEffect(() => {
    if (!revealed || shown) return;
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [revealed, shown]);

  if (!revealed) return <>{skeleton}</>;
  return (
    <div
      className={cn(
        className,
        "transition-opacity duration-300 ease-out motion-reduce:transition-none",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      {ready || !holdOnRefresh ? children : last.current}
    </div>
  );
}
