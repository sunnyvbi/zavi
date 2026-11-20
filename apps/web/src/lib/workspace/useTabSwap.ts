"use client";

import { useEffect, useRef } from "react";

export const TAB_SWAP_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(6px)" },
  { opacity: 1, transform: "translateY(0)" },
];
export const TAB_SWAP_TIMING: KeyframeAnimationOptions = { duration: 240, easing: "cubic-bezier(0.23,1,0.32,1)" };

export function useTabSwap<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T | null>(null);
  const seen = useRef(false);
  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(TAB_SWAP_KEYFRAMES, TAB_SWAP_TIMING);
  }, [key]);
  return ref;
}
