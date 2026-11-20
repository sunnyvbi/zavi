"use client";

import type { SpendBucket } from "./types";

export function SpendCard({
  totalUsd,
  buckets,
}: {
  totalUsd: number;
  buckets: SpendBucket[];
}) {
  const max = Math.max(0.01, ...buckets.map((b) => b.usd));
  const barWidth = 16;
  const gap = 4;
  const w = buckets.length * (barWidth + gap) - gap;
  const h = 24;

  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
          Spend
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-inkMuted">
          last 7 days
        </span>
      </header>
      <div className="flex items-end justify-between gap-3">
        <div className="font-mono text-[28px] font-semibold tabular-nums text-ink">
          ${totalUsd.toFixed(2)}
        </div>
        {buckets.length > 0 && (
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            role="img"
            aria-label="7-day spend sparkline"
            className="text-emerald-500"
          >
            {buckets.map((b, i) => {
              const x = i * (barWidth + gap);
              const barH = Math.max(1, Math.round((b.usd / max) * h));
              return (
                <rect
                  key={b.date}
                  x={x}
                  y={h - barH}
                  width={barWidth}
                  height={barH}
                  fill="currentColor"
                  opacity={0.85}
                >
                  <title>{`${b.date}: $${b.usd.toFixed(2)}`}</title>
                </rect>
              );
            })}
          </svg>
        )}
      </div>
    </section>
  );
}
