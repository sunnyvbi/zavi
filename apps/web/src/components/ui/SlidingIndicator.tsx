"use client";

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/cn";

type Box = { left: number; top: number; width: number; height: number; ready: boolean };

const ACTIVE = '[aria-selected="true"],[aria-pressed="true"],[aria-current="page"]';

export function useSlidingIndicator<T extends HTMLElement>(activeKey: unknown) {
  const listRef = useRef<T | null>(null);
  const [box, setBox] = useState<Box>({ left: 0, top: 0, width: 0, height: 0, ready: false });
  const measure = useCallback(() => {
    const active = listRef.current?.querySelector<HTMLElement>(ACTIVE);
    if (!active || !active.offsetWidth) {
      setBox((b) => (b.ready ? { ...b, ready: false } : b));
      return;
    }
    const next = { left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight, ready: true };
    setBox((b) => (b.ready && b.left === next.left && b.top === next.top && b.width === next.width && b.height === next.height ? b : next));
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
  return { listRef, box };
}

export function SlidingIndicator({ box, className }: { box: Box; className?: string }) {
  const style: CSSProperties = { width: box.width, height: box.height, transform: `translate(${box.left}px, ${box.top}px)` };
  return (
    <span
      aria-hidden
      data-testid="sliding-indicator"
      className={cn(
        "pointer-events-none absolute left-0 top-0 transition-[transform,width,height,opacity] duration-300 ease-out motion-reduce:transition-none",
        box.ready ? "opacity-100" : "opacity-0",
        className,
      )}
      style={style}
    />
  );
}
