"use client";

import { useEffect, useState } from "react";
import {
  PAST_WORK_DEMO_SEQUENCE,
  type PastWorkDemoPhase,
} from "./pastWorkDemoSequence";

export function usePastWorkDemo() {
  const [phase, setPhase] = useState<PastWorkDemoPhase>("prompt");
  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = 0;
    const advance = () => {
      timer = setTimeout(() => {
        current = (current + 1) % PAST_WORK_DEMO_SEQUENCE.length;
        setPhase(PAST_WORK_DEMO_SEQUENCE[current].phase);
        advance();
      }, PAST_WORK_DEMO_SEQUENCE[current].duration);
    };
    const start = () => {
      clearTimeout(timer);
      current = motion?.matches ? PAST_WORK_DEMO_SEQUENCE.length - 1 : 0;
      setPhase(PAST_WORK_DEMO_SEQUENCE[current].phase);
      if (!motion?.matches && !document.hidden) advance();
    };
    start();
    motion?.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    return () => {
      clearTimeout(timer);
      motion?.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", start);
    };
  }, []);
  return phase;
}
