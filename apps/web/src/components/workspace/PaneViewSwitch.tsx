"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

export function PaneViewSwitch({
  boardLabel,
  chatOpen,
  onChange,
  controls,
  label,
}: {
  boardLabel: string;
  chatOpen: boolean;
  onChange: (chatOpen: boolean) => void;
  controls: string;
  label: string;
}) {
  const rail = useRef<HTMLDivElement | null>(null);
  const halves = useRef<Array<HTMLButtonElement | null>>([]);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const activeIndex = chatOpen ? 1 : 0;

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const measure = () => {
      const half = halves.current[activeIndex];
      if (!half || !half.offsetWidth) return;
      setPill({ x: half.offsetLeft - el.clientLeft, w: half.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeIndex]);

  return (
    <div
      className="hidden shrink-0 px-4 pb-2 pt-3 compact:block"
    >
      <div
        ref={rail}
        role="group"
        aria-label={label}
        className="relative flex w-full items-center gap-1 rounded-full border border-rule bg-cream p-1"
      >
        {pill && (
          <span
            aria-hidden="true"
            data-testid="pane-switch-pill"
            className="pointer-events-none absolute bottom-1 left-0 top-1 rounded-full bg-bone transition-[transform,width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${pill.w}px`, transform: `translateX(${pill.x}px)` }}
          />
        )}
        {(
          [
            ["board", boardLabel, false],
            ["chat", "Chat", true],
          ] as const
        ).map(([key, text, opensChat]) => {
          const isActive = chatOpen === opensChat;
          return (
            <button
              key={key}
              ref={(el) => {
                halves.current[opensChat ? 1 : 0] = el;
              }}
              type="button"
              aria-pressed={isActive}
              aria-controls={controls}
              onClick={() => onChange(opensChat)}
              className={cn(
                "relative z-10 min-w-0 flex-1 basis-0 rounded-full px-3 py-1.5 text-center text-[13px] font-medium transition-colors motion-reduce:transition-none compact:min-h-[40px]",
                isActive ? "text-ink" : "text-inkMuted",
                !pill && isActive && "bg-bone",
              )}
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
