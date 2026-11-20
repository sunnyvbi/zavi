"use client";

import { useState } from "react";
import { Lock, Minus, Plus } from "lucide-react";
import { ZaviMascot } from "@/components/ZaviMascot";
import type { DayKind, PublicDay } from "@/lib/marketing/liveUpcar";
import { fmtDay, stuntDayNumber, usd } from "./format";
import { budgetLine, dayPath, KIND_LABEL, netMove } from "./dayCopy";

type Palette = { rule: string; ink: string; mute: string; body: string; sticky: string; btn: string; kind: Record<DayKind, string> };

const LIGHT: Palette = {
  rule: "border-[#0e0f11]/12",
  ink: "text-[#0e0f11]",
  mute: "text-[#6b7076]",
  body: "text-[#3a3d42]",
  sticky: "bg-[#fbfbfa]",
  btn: "border-[#0e0f11]/20 bg-white text-[#0e0f11] hover:border-[#0e0f11]",
  kind: {
    PLAN: "border-[#0e0f11]/25 text-[#0e0f11]",
    CHANGE: "border-[#0e0f11]/25 text-[#0e0f11]",
    WORK: "border-[#0e0f11]/15 text-[#6b7076]",
    WIN: "border-[#1d5c3a]/50 text-[#1d5c3a]",
    LOSS: "border-[#8c3a1e]/50 text-[#8c3a1e]",
    HUMAN: "border-[#8a5a00]/50 text-[#8a5a00]",
    NOT_AVAILABLE: "border-dashed border-[#0e0f11]/30 text-[#6b7076]",
  },
};

const DARK: Palette = {
  rule: "border-white/10",
  ink: "text-white",
  mute: "text-white/55",
  body: "text-white/80",
  sticky: "bg-[#0d1117]",
  btn: "border-white/20 bg-white/5 text-white hover:border-white/60",
  kind: {
    PLAN: "border-white/30 text-white",
    CHANGE: "border-white/30 text-white",
    WORK: "border-white/15 text-white/60",
    WIN: "border-emerald-300/50 text-emerald-300",
    LOSS: "border-[#ff8a8b]/50 text-[#ff8a8b]",
    HUMAN: "border-[#ffc56b]/50 text-[#ffc56b]",
    NOT_AVAILABLE: "border-dashed border-white/30 text-white/60",
  },
};

function Label({ p, children }: { p: Palette; children: React.ReactNode }) {
  return <p className={`font-mono text-[11px] font-semibold tracking-[0.12em] uppercase ${p.mute}`}>{children}</p>;
}

function Row({ p, e, locked, open, onToggle, compact, startAt, unlockLabel, slug, pageDays }: { p: Palette; e: PublicDay; locked: boolean; open: boolean; onToggle: () => void; compact: boolean; startAt: string; unlockLabel: string; slug?: string; pageDays?: string[] }) {
  const dayNo = stuntDayNumber(e.day, startAt);
  return (
    <li className={`border-t ${p.rule}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className={`grid w-full grid-cols-[52px_1fr_20px] gap-x-3 text-left ${compact ? "py-3.5" : "py-4 sm:grid-cols-[88px_1fr_24px] sm:gap-x-5"}`}>
        <span>
          <span className={`block font-mono text-[12px] font-bold ${p.ink}`}>DAY {String(dayNo).padStart(2, "0")}</span>
          <span className={`mt-0.5 block font-mono text-[11px] ${p.mute}`}>{fmtDay(e.day).replace(/^\w+ /, "")}</span>
        </span>
        <span className="min-w-0">
          <span className={`inline-block border px-1.5 py-[1px] font-mono text-[11px] font-semibold tracking-[0.08em] uppercase ${p.kind[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
          <span className={`mt-1.5 block text-[16px] leading-snug font-semibold sm:text-[16.5px] ${p.ink}`}>{e.headline}</span>
          <span className={`mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] ${p.mute}`}>
            {e.channels.length > 0 && <span>{e.channels.join(" · ")}</span>}
            {locked ? (
              <span className="flex items-center gap-1"><Lock aria-hidden className="h-3 w-3" /> money + results {unlockLabel}</span>
            ) : (
              <>
                <span className={e.budget.length ? p.ink : ""}>{netMove(e)}</span>
                {e.spent_usd !== null && <span>spent {usd(e.spent_usd)}</span>}
                {e.hosts !== null && e.bookings !== null && <span className={`${p.ink}`}>+{e.hosts} hosts · +{e.bookings} bookings</span>}
              </>
            )}
          </span>
        </span>
        <span className={`pt-0.5 ${p.ink}`} aria-hidden>{open ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}</span>
      </button>

      {open && (
        <div className={`grid gap-5 pb-5 pl-[64px] ${compact ? "" : "sm:grid-cols-[1.15fr_1fr] sm:gap-8 sm:pl-[108px]"}`}>
          <div>
            <Label p={p}>What I did</Label>
            {e.work.length ? (
              <ol className={`mt-2 flex flex-col gap-2 text-[14px] ${p.body}`}>
                {e.work.map((w, i) => (
                  <li key={w} className="flex gap-2.5">
                    <span className={`w-4 shrink-0 font-mono text-[11px] leading-[22px] ${p.mute}`}>{i + 1}</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={`mt-2 text-[14px] ${p.mute}`}>Watched the numbers.</p>
            )}
            <div className="mt-5">
              <Label p={p}>Why</Label>
              {e.why ? (
                <div className="mt-2 flex gap-3">
                  <span className="shrink-0 pt-0.5"><ZaviMascot size={28} /></span>
                  <p className={`text-[14px] leading-relaxed ${p.ink}`}>{e.why}</p>
                </div>
              ) : (
                <p className={`mt-2 flex items-center gap-2 font-mono text-[12px] ${p.mute}`}>
                  {locked ? <><Lock aria-hidden className="h-3 w-3" /> Public {unlockLabel}</> : "No reason recorded."}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-5">
            <div>
              <Label p={p}>Budget changes</Label>
              {e.budget.length === 0 ? (
                <p className={`mt-2 text-[14px] ${p.mute}`}>None. No money moved.</p>
              ) : (
                <ul className={`mt-2 border-b ${p.rule}`}>
                  {e.budget.map((b, i) => (
                    <li key={`${b.channel}-${i}`} className={`flex items-baseline justify-between gap-3 border-t py-2 text-[14px] ${p.rule}`}>
                      <span className={`${p.ink}`}>{b.channel}</span>
                      <span className={`text-right font-mono text-[12px] whitespace-nowrap ${p.ink}`}>{budgetLine(b)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {slug && !locked && pageDays?.includes(e.day) && (
              <a href={dayPath(slug, dayNo)} className={`self-start font-mono text-[12px] font-semibold underline underline-offset-4 ${p.ink}`}>
                Day {dayNo} on its own page →
              </a>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function DayLog({ days, locked, compact = false, dark = false, startAt, unlockLabel, slug, pageDays }: { days: PublicDay[]; locked: boolean; compact?: boolean; dark?: boolean; startAt: string; unlockLabel: string; slug?: string; pageDays?: string[] }) {
  const p = dark ? DARK : LIGHT;
  const [open, setOpen] = useState<Set<string>>(() => new Set(days[0] ? [days[0].day] : []));
  if (days.length === 0) {
    return <p className={`text-[14px] ${compact ? "py-4" : `border-t py-6 ${p.rule}`} ${p.mute}`}>Zavi&apos;s first entry appears after day 1.</p>;
  }
  const allOpen = open.size === days.length;
  const toggle = (d: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });
  return (
    <div>
      <div className={`flex items-center justify-between gap-3 pb-3 ${compact ? `sticky top-0 z-10 -mx-3 px-3 pt-3 ${p.sticky}` : ""}`}>
        <p className={`font-mono text-[11px] ${p.mute}`}>{days.length} {days.length === 1 ? "ENTRY" : "ENTRIES"} · NEWEST FIRST</p>
        <button
          type="button"
          onClick={() => setOpen(allOpen ? new Set() : new Set(days.map((e) => e.day)))}
          className={`border px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase ${p.btn}`}
        >
          {allOpen ? "Close all" : "Open all"}
        </button>
      </div>
      <ul className={`border-b ${p.rule}`}>
        {days.map((e) => (
          <Row key={e.day} p={p} e={e} locked={locked} open={open.has(e.day)} onToggle={() => toggle(e.day)} compact={compact} startAt={startAt} unlockLabel={unlockLabel} slug={slug} pageDays={pageDays} />
        ))}
      </ul>
    </div>
  );
}
