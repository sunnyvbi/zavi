"use client";

import { useLiveStats } from "@/lib/marketing/useLiveStats";
import type { LiveMetricKey } from "@/lib/marketing/liveStats";
import { LiveCounter } from "./LiveCounter";

const TILES: { metric: LiveMetricKey; label: string }[] = [
  { metric: "tokens_processed", label: "tokens processed" },
  { metric: "agent_steps", label: "agent steps run" },
];

export function UpcarLiveTiles() {
  const state = useLiveStats();
  if (!state) return null;
  return (
    <section data-testid="upcar-live-tiles" className="px-4 py-8 sm:px-6">
      <ul className="mx-auto grid w-full max-w-[1100px] gap-5 sm:grid-cols-2">
        {TILES.map((t) => (
          <li
            key={t.metric}
            className="rounded-block border border-black/[0.07] bg-white px-7 py-8 shadow-[0_24px_60px_-48px_rgba(16,18,20,0.5)]"
          >
            <p className="text-[clamp(2.2rem,5vw,3.4rem)] font-bold leading-none tracking-[-0.03em] text-[#0e0f11]">
              <LiveCounter state={state} metric={t.metric} />
            </p>
            <p className="mt-4 text-[14px] leading-[1.5] text-[#595959]">
              {t.label} · {state.frozen ? "across Zavi" : "live across Zavi"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
