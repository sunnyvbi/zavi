"use client";

import { useEffect, useState } from "react";
import {
  displayValue,
  formatCount,
  liveStatsClamp,
  type LiveMetricKey,
  type LiveStatsState,
} from "@/lib/marketing/liveStats";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function LiveCounter({
  state,
  metric,
  className = "",
}: {
  state: LiveStatsState;
  metric: LiveMetricKey;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => setNow(Date.now()), prefersReducedMotion() ? 1000 : 100);
    return () => clearInterval(id);
  }, [state]);

  const raw = displayValue(state, metric, now);
  if (raw === null) return null;
  const shown = liveStatsClamp.apply(metric, raw);
  return <span className={`tabular-nums ${className}`}>{formatCount(shown)}</span>;
}
