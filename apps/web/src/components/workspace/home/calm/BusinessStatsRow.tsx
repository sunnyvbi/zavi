"use client";

import type { HomeStat } from "./calmTypes";

export function BusinessStatsRow({
  stats,
  tenantName,
}: {
  stats: HomeStat[];
  tenantName?: string;
}) {
  if (stats.length === 0) return null;

  return (
    <section aria-label="Where the business is">
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">
          Where {tenantName?.trim() || "your business"} is
        </h2>
        {}
        <p className="text-[13px] leading-normal text-[#595959]">this week</p>
      </div>
      <div className="flex flex-wrap gap-3">
        {stats.map((s, i) => (
          <div
            key={`${s.label}-${s.metric_key ?? s.goal_id ?? i}`}
            className="min-w-[9.5rem] flex-1 rounded-2xl border border-[#f0f0f0] bg-white p-4"
          >
            <div className="text-[12px] font-medium text-[#595959]">{s.label}</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span
                className={`text-[24px] font-bold leading-none ${
                  s.status === "unavailable" ? "text-inkMuted/50" : "text-[#0e0f11]"
                }`}
              >
                {s.value}
              </span>
              {s.status === "unavailable" ? (
                <span className="text-[11px] font-medium uppercase tracking-wide text-inkMuted/50">
                  unavailable
                </span>
              ) : s.target ? (
                <span className="text-[12px] font-medium text-[#595959]">
                  / {s.target}
                </span>
              ) : null}
            </div>
            {typeof s.progress === "number" ? (
              <div
                className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[#f0f0f0]"
                aria-hidden
              >
                <div
                  className="h-full rounded-full bg-[#0e0f11]"
                  style={{
                    width: `${Math.round(Math.max(0, Math.min(1, s.progress)) * 100)}%`,
                  }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
