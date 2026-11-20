import { Lock } from "lucide-react";
import { fmtDay, usd } from "./format";

const HATCH = "bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.06)_0_8px,rgba(255,255,255,0.12)_8px_16px)]";

export function GoalBar({ label, soFar, goal, pace, atPace, locked, unlockLabel, ended = false, fmt = String }: {
  label: string; soFar: number | null; goal: number; pace: number | null; atPace: number | null; locked: boolean; unlockLabel: string; ended?: boolean;
  fmt?: (n: number) => string;
}) {
  const pct = soFar === null ? 0 : Math.min(100, (soFar / goal) * 100);
  const pacePct = pace === null ? null : Math.min(100, (pace / goal) * 100);
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <span>
          <span className="block font-mono text-[12px] font-bold tracking-[0.2em] text-white/70 uppercase sm:text-[13px]">{label}</span>
          {!locked && atPace !== null && (
            <span className="mt-1 block font-mono text-[11px] text-white/60 sm:text-[12px]">At today&apos;s pace: <b className="text-white">{fmt(atPace)}</b></span>
          )}
        </span>
        {locked ? (
          <span className="flex items-center gap-2 font-mono text-[20px] font-bold text-white/60 tabular-nums"><Lock aria-hidden className="h-4 w-4" /> ? / {fmt(goal)}</span>
        ) : (
          <span className="font-mono tabular-nums">
            <span className="text-[34px] leading-none font-bold text-white [text-shadow:0_0_18px_rgba(2,123,255,0.8)] sm:text-[44px]">{soFar === null ? "unavailable" : fmt(soFar)}</span>
            <span className="text-[16px] font-semibold text-white/50"> / {fmt(goal)}</span>
          </span>
        )}
      </div>
      <div className="relative mt-2.5 h-5 rounded-full bg-white/10 sm:h-6">
        {locked ? (
          <div className={`flex h-full items-center justify-center rounded-full ${HATCH} font-mono text-[11px] font-semibold tracking-wide text-white/70`}>Public {unlockLabel}</div>
        ) : (
          <div className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-[#0057c2] to-[#2d95ff] shadow-[0_0_22px_rgba(2,123,255,0.75)]" style={{ width: `${pct}%` }}>
            {!ended && <span className="absolute inset-y-0 right-0 w-10 bg-gradient-to-r from-transparent to-white/60 motion-safe:animate-pulse" />}
          </div>
        )}
        {!locked && pacePct !== null && <div aria-hidden className="absolute -top-1.5 -bottom-1.5 w-1 rounded-sm bg-[#0e0f11] ring-2 ring-white" style={{ left: `${pacePct}%` }} />}
      </div>
      {!locked && pacePct !== null && pace !== null && (
        <div className="relative mt-1.5 h-5 font-mono text-[11px] text-white/60 sm:text-[12px]">
          <span
            className="absolute whitespace-nowrap"
            style={{ left: `${pacePct}%`, transform: pacePct > 80 ? "translateX(-100%)" : pacePct < 20 ? "translateX(-8px)" : "translateX(-50%)" }}
          >
            ▲ Normal pace {fmt(pace)}
          </span>
        </div>
      )}
    </div>
  );
}

export function FuelGauge({ budget, raisedOn = null, spent, perDay, runsOutDay, locked, unlockLabel, ended = false }: {
  budget: number; raisedOn?: string | null; spent: number | null; perDay: number | null; runsOutDay: number | null; locked: boolean; unlockLabel: string; ended?: boolean;
}) {
  const left = spent === null ? null : Math.max(0, budget - spent);
  const over = spent === null ? 0 : Math.max(0, spent - budget);
  const cellPct = 100 / Math.max(1, Math.round(budget / 1000));
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
        <span className="font-mono text-[12px] font-bold tracking-[0.2em] text-white/70 uppercase sm:text-[13px]">Fuel · {usd(budget)} {raisedOn ? `limit since ${fmtDay(raisedOn)}` : "hard limit"}</span>
        {locked || left === null ? (
          <span className="flex items-center gap-2 font-mono text-[12px] font-semibold text-white/60"><Lock aria-hidden className="h-3.5 w-3.5" /> {locked ? `Spend public ${unlockLabel}` : "Spend unavailable"}</span>
        ) : (
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[22px] leading-none font-bold text-[#ffb547] tabular-nums [text-shadow:0_0_16px_rgba(255,181,71,0.6)] sm:text-[28px]">{usd(over || left)}</span>
            <span className="font-mono text-[12px] text-white/50">{over ? "over" : "left"}</span>
          </span>
        )}
      </div>
      <div className="relative mt-2.5 h-7 overflow-hidden rounded-md border border-white/15 bg-white/[0.04] p-[3px]">
        {locked || left === null ? (
          <div className={`h-full rounded-[3px] ${HATCH}`} />
        ) : (
          <div className="relative h-full rounded-[3px] bg-gradient-to-r from-[#ff7a1a] to-[#ffc34d] shadow-[0_0_20px_rgba(255,160,50,0.6)]" style={{ width: `${(left / budget) * 100}%` }}>
            {!ended && <span className="absolute inset-y-0 right-0 w-1.5 bg-white motion-safe:animate-pulse" />}
          </div>
        )}
        <div aria-hidden className="pointer-events-none absolute inset-[3px]" style={{ backgroundImage: `repeating-linear-gradient(90deg, transparent 0 calc(${cellPct}% - 2px), #07090d calc(${cellPct}% - 2px) ${cellPct}%)` }} />
      </div>
      {!locked && spent !== null && (
        <p className="mt-1.5 font-mono text-[11px] text-white/55 sm:text-[12px]">
          {usd(spent)} burned
          {!ended && perDay ? ` · this week ~${usd(perDay)}/day` : ""}
          {!ended && runsOutDay && spent < budget ? ` · at that rate the money runs out on day ${runsOutDay}` : ""}
        </p>
      )}
    </div>
  );
}
