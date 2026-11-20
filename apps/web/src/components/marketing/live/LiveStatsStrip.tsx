"use client";

import { useLiveStats, useLiveStatsSettled } from "@/lib/marketing/useLiveStats";
import type { LiveMetricKey } from "@/lib/marketing/liveStats";
import { LiveCounter } from "./LiveCounter";

const TILES: { metric: LiveMetricKey; label: string }[] = [
  { metric: "tokens_processed", label: "tokens processed" },
  { metric: "agent_steps", label: "agent steps run" },
];

export function LiveStatsStrip({ tone = "light" }: { tone?: "light" | "dark" }) {
  const state = useLiveStats();
  const settled = useLiveStatsSettled();
  if (!state && settled) return null;
  const dark = tone === "dark";
  const tile = dark ? "bg-white/[0.08]" : "bg-white border border-black/[0.06]";
  const label = dark ? "text-white/60" : "text-[#595959]";
  const num = dark ? "text-white" : "text-[#0e0f11]";
  const slot = dark ? "bg-white/15" : "bg-black/[0.07]";
  const live = !!state && !state.frozen;
  return (
    <div data-testid="live-stats-strip" className="flex flex-col gap-2">
      <p className={`flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] ${label}`}>
        {live && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#16a34a]" />}
        {state?.frozen ? "Across Zavi" : "Live across Zavi"}
      </p>
      {TILES.map((t) => (
        <div key={t.metric} className={`rounded-[12px] px-3 py-2.5 ${tile}`}>
          {state ? (
            <LiveCounter
              state={state}
              metric={t.metric}
              className={`block text-[22px] font-bold leading-tight tabular-nums ${num}`}
            />
          ) : (
            <span
              data-testid="live-stats-slot"
              aria-hidden="true"
              className={`my-[5px] block h-[18px] w-2/3 animate-pulse rounded-md ${slot}`}
            />
          )}{" "}
          <span className={`text-[12px] ${label}`}>{t.label}</span>
        </div>
      ))}
    </div>
  );
}
