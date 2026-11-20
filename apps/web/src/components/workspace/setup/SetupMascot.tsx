"use client";

import { useEffect, useState } from "react";
import { ZaviMascot } from "@/components/ZaviMascot";
import { finishedSteps, type SetupState } from "./setupState";
import { READY_LINE, strategyProgressLine } from "./setupCopy";

const CONFETTI = ["#027BFF", "#FFB800", "#FF4D6D", "#1A7F4B", "#7856FF", "#FF7A59", "#027BFF", "#FFB800"];

function drafting(s: SetupState): boolean {
  return s.done && s.draft.status !== "done" && s.draft.status !== "failed";
}

export function mascotLine(s: SetupState): { line: string } {
  if (s.done) {
    if (s.draft.status === "done") return { line: READY_LINE };
    if (s.draft.status === "failed") return { line: "Something went wrong cooking your strategy. Try again from the page." };
    return { line: s.draft.status === "running" ? strategyProgressLine(s.draft.phase) : "Reading your business information before writing your strategy." };
  }
  if (s.docs.status === "pending") return { line: "Hi, I'm Zavi! Let's cook your growth strategy. First, feed me your past work." };
  if (s.connectors.status === "pending") {
    return s.docs.status === "done"
      ? { line: `Yum, ${s.docs.facts} facts! 50% cooked. Now let's plug in your numbers.` }
      : { line: "No files? No problem. 50% cooked. Now let's plug in your numbers." };
  }
  return s.connectors.status === "done"
    ? { line: "Connected! 100% cooked. One last polish and it's served." }
    : { line: "We'll measure later. 100% cooked, one last polish." };
}

export function setupMascotShown(s: SetupState, canManageSetup: boolean, draftStarting: boolean): boolean {
  if (!canManageSetup) return false;
  return !(s.done && s.draft.status === "none" && !draftStarting);
}

export function SetupMascot({ state }: { state: SetupState }) {
  const key = finishedSteps(state) + (state.draft.status === "done" ? 1 : 0);
  const [seen, setSeen] = useState(key);
  const [celebrating, setCelebrating] = useState(false);
  const [celebrations, setCelebrations] = useState(0);
  if (key !== seen) {
    setSeen(key);
    if (key > seen) {
      setCelebrating(true);
      setCelebrations((n) => n + 1);
    }
  }
  useEffect(() => {
    if (!celebrating) return;
    const t = window.setTimeout(() => setCelebrating(false), 2600);
    return () => window.clearTimeout(t);
  }, [celebrating]);

  const { line } = mascotLine(state);

  return (
    <div className="relative flex w-full flex-col items-center gap-4 overflow-hidden">
      <style>{`
        @keyframes zm-confetti { 0% { transform: translate(0,0) rotate(0); opacity: 1 } 100% { transform: translate(var(--dx), var(--dy)) rotate(540deg); opacity: 0 } }
        @keyframes zm-pop { 0% { transform: scale(.9); opacity: 0 } 100% { transform: scale(1); opacity: 1 } }
        @media (prefers-reduced-motion: reduce) { .zm-anim, .zm-anim * { animation: none !important } }
      `}</style>
      <div aria-hidden className="zm-anim relative h-[120px] w-[120px] shrink-0">
        <ZaviMascot size={120} working={drafting(state)} celebrate={celebrations} />
        {celebrating && (
          <div data-testid="mascot-confetti" className="pointer-events-none absolute left-1/2 top-1/3">
            {CONFETTI.map((c, i) => {
              const a = (i / CONFETTI.length) * Math.PI * 2;
              return (
                <span
                  key={i}
                  className="absolute block h-2 w-1.5 rounded-sm"
                  style={{ background: c, ["--dx" as string]: `${Math.cos(a) * 70}px`, ["--dy" as string]: `${Math.sin(a) * 55 - 20}px`, animation: `zm-confetti 1.1s ease-out ${i * 30}ms forwards` }}
                />
              );
            })}
          </div>
        )}
      </div>
      <p key={line} role="status" className="zm-anim max-w-[320px] rounded-2xl bg-white px-4 py-3 text-center text-[14px] font-medium leading-6 text-ink shadow-sm ring-1 ring-ink/5" style={{ animation: "zm-pop 260ms ease-out both" }}>
        {line}
      </p>
    </div>
  );
}
