"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cx } from "./shared";

type Geometry = { left: number; width: number; ready: boolean };

const ACTIVE = '[aria-selected="true"],[aria-current="page"]';

export function useTabIndicator<T extends HTMLElement>(activeKey: unknown) {
  const listRef = useRef<T | null>(null);
  const [geometry, setGeometry] = useState<Geometry>({ left: 0, width: 0, ready: false });

  const measure = useCallback(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>(ACTIVE);
    if (!list || !active) {
      setGeometry((g) => (g.ready ? { ...g, ready: false } : g));
      return;
    }
    const next = { left: active.offsetLeft, width: active.offsetWidth, ready: true };
    setGeometry((g) => (g.left === next.left && g.width === next.width && g.ready ? g : next));
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [activeKey, measure]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure]);

  return { listRef, geometry };
}

export function TabIndicator({
  geometry,
  className,
  variant = "underline",
}: {
  geometry: Geometry;
  className?: string;
  variant?: "underline" | "pill";
}) {
  return (
    <span
      aria-hidden
      data-testid="tab-indicator"
      data-variant={variant}
      className={cx(
        "pointer-events-none absolute left-0 rounded-full bg-ink transition-[transform,width,opacity] duration-300 ease-out motion-reduce:transition-none",
        variant === "pill" ? "inset-y-0" : "h-[2px]",
        geometry.ready ? "opacity-100" : "opacity-0",
        className,
      )}
      style={{ width: `${geometry.width}px`, transform: `translateX(${geometry.left}px)` }}
    />
  );
}
