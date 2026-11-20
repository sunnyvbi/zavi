"use client";

import { useState } from "react";
import { channelMark } from "@/components/workspace/channelMark";
import { BOARD } from "./channels";

function Mark({ slug }: { slug: string }) {
  const mark = channelMark(slug);
  return (
    <span className={`flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full ${mark.bg}`}>
      {mark.kind === "glyph" ? (
        <mark.Icon className={`size-5 ${mark.fg}`} aria-hidden />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mark.src} alt="" draggable={false} className={mark.fit === "cover" ? "h-full w-full object-cover" : "size-5 object-contain"} />
      )}
    </span>
  );
}

export function ChannelBoard() {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="border-b border-[#0e0f11]/12" onMouseLeave={() => setActive(null)}>
      {BOARD.map((g) => {
        const shown = g.channels.find((c) => c.slug === active) ?? null;
        return (
          <div key={g.label} className="grid gap-3 border-t border-[#0e0f11]/12 py-4 sm:grid-cols-[180px_1fr] sm:gap-5">
            <p className="pt-2.5 text-[11px] font-semibold tracking-[0.1em] text-[#6b7076] uppercase">
              {g.label} <span className="text-[#0e0f11]/35">· {g.channels.length}</span>
            </p>
            <div>
              <div className="flex flex-wrap gap-2.5">
                {g.channels.map((c) => {
                  const on = active === c.slug;
                  return (
                    <button
                      key={c.slug}
                      type="button"
                      aria-label={`${c.name}. ${c.pitch}`}
                      aria-pressed={on}
                      onMouseEnter={() => setActive(c.slug)}
                      onFocus={() => setActive(c.slug)}
                      onBlur={() => setActive(null)}
                      onClick={() => setActive(c.slug)}
                      className={`relative flex items-center gap-2.5 rounded-full border bg-white py-1.5 pr-4 pl-1.5 text-[14px] font-semibold transition focus-visible:outline-2 focus-visible:outline-[#027bff] ${on ? "-translate-y-0.5 border-[#0e0f11] shadow-[0_10px_30px_-12px_rgba(25,25,25,0.3)]" : "border-[#0e0f11]/12 hover:border-[#0e0f11]/40"}`}
                    >
                      <Mark slug={c.slug} />
                      {c.name}
                      {on && (
                        <span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 hidden w-72 rounded-xl bg-[#0e0f11] px-4 py-3 text-left text-[13px] leading-snug font-normal text-white/80 shadow-xl sm:block">
                          <span className="block text-[14px] font-bold text-white">{c.name}</span>
                          <span className="mt-1 block">{c.pitch}</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {}
              {shown && (
                <p aria-live="polite" className="mt-3 rounded-xl bg-[#f6f6f4] px-4 py-3 text-[14px] leading-snug sm:hidden">
                  <span className="font-bold">{shown.name}. </span>
                  {shown.pitch}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
