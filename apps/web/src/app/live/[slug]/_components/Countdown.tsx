"use client";

import { useEffect, useState } from "react";

type Clock = { start_at: string; unlock_at: string; end_at: string };
const pad2 = (n: number) => String(n).padStart(2, "0");

export function Countdown({ clock, serverNow, endLabel, simulated = false, compact = false }: { clock: Clock; serverNow: number; endLabel: string; simulated?: boolean; compact?: boolean }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t0 = Date.now();
    const base = simulated ? serverNow : 0;
    const read = () => (simulated ? base + (Date.now() - t0) : Date.now());
    setNow(read());
    const id = setInterval(() => setNow(read()), 1000);
    return () => clearInterval(id);
  }, [serverNow, simulated]);

  const start = Date.parse(clock.start_at);
  const unlock = Date.parse(clock.unlock_at);
  const end = Date.parse(clock.end_at);
  const [label, target] =
    now < start ? ["Starts in", start] : now < unlock ? ["Numbers go public in", unlock] : now < end ? [`T-minus to the finish · ${endLabel}`, end] : ["Finished", end];
  const left = Math.max(0, Math.floor((target - now) / 1000));
  const cells: [string, number][] = [
    ["Days", Math.floor(left / 86400)],
    ["Hrs", Math.floor((left % 86400) / 3600)],
    ["Min", Math.floor((left % 3600) / 60)],
    ["Sec", left % 60],
  ];
  const big = compact ? "text-[clamp(40px,12.5vw,128px)] lg:text-[clamp(48px,5.6vw,92px)]" : "text-[clamp(40px,12.5vw,128px)]";
  const sep = compact ? "text-[clamp(34px,10vw,104px)] lg:text-[clamp(40px,4.6vw,76px)]" : "text-[clamp(34px,10vw,104px)]";

  return (
    <div role="timer" aria-live="off" aria-label={`${label}: ${cells.map(([k, v]) => `${v} ${k}`).join(" ")}`}>
      <style>{`@keyframes lu-tick{0%{opacity:.35;transform:translateY(-6%)}100%{opacity:1;transform:none}}`}</style>
      <p className="text-[12px] font-bold tracking-[0.22em] text-white/70 uppercase sm:text-[14px]">{label}</p>
      <div className="mt-2 flex items-start leading-none font-bold text-white tabular-nums [text-shadow:0_0_28px_rgba(2,123,255,0.85),0_0_2px_rgba(255,255,255,0.9)]">
        {cells.map(([k, v], i) => (
          <div key={k} className="flex items-start">
            {i > 0 && (
              <span aria-hidden className={`px-[0.06em] ${sep} text-white`}>
                :
              </span>
            )}
            <div className="flex flex-col items-center">
              <span
                key={k === "Sec" ? v : undefined}
                suppressHydrationWarning
                className={`${big} ${k === "Sec" ? "text-[#7fbcff] motion-safe:[animation:lu-tick_0.35s_ease-out]" : ""}`}
              >
                {pad2(v)}
              </span>
              <span className="mt-1.5 text-[11px] font-semibold tracking-[0.25em] text-white/60 uppercase [text-shadow:none] sm:text-[13px]">{k}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
