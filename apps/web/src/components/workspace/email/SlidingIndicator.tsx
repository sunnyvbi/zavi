"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { cn } from "@/lib/cn";

export type ActiveBox = { x: number; y: number; w: number; h: number; row: boolean };

const sameBox = (a: ActiveBox | null, b: ActiveBox | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.row === b.row);

export function useActiveBox<T extends HTMLElement>(selector: string, key: unknown): [ActiveBox | null, (el: T | null) => void] {
  const [host, setHost] = useState<T | null>(null);
  const [box, setBox] = useState<ActiveBox | null>(null);
  useLayoutEffect(() => {
    if (!host) return setBox(null);
    const measure = () => {
      const el = host.querySelector<HTMLElement>(selector);
      const next = !el || !el.offsetWidth
        ? null
        : { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, row: getComputedStyle(host).flexDirection.startsWith("row") };
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    host.querySelectorAll<HTMLElement>(":scope > :not([aria-hidden])").forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [host, selector, key]);
  return [box, setHost];
}

export function SlidingIndicator({ box, kind, className }: { box: ActiveBox | null; kind: "pill" | "rail"; className?: string }) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    if (!box || animate) return;
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [box, animate]);
  if (!box) return null;
  const style =
    kind === "pill"
      ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }
      : box.row
        ? { transform: `translate(${box.x}px, ${box.y + box.h - 2}px)`, width: box.w, height: 2 }
        : { transform: `translate(${box.x}px, ${box.y}px)`, width: 2, height: box.h };
  return (
    <span
      aria-hidden
      data-testid={`sliding-indicator-${kind}`}
      className={cn(
        "pointer-events-none absolute left-0 top-0",
        animate && "transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
        className,
      )}
      style={style}
    />
  );
}
