"use client";

import { useEffect, useRef, useState } from "react";

const COLLAPSE_MAX_PX = 360;
const OVERFLOW_SLACK_PX = 48;
const COLLAPSE_FADE_PX = 40;
const COLLAPSE_FADE = `linear-gradient(to bottom, black calc(100% - ${COLLAPSE_FADE_PX}px), transparent 100%)`;
export const COLLAPSE_MIN_TEXT_LEN = 600;
export const COLLAPSE_MIN_LINES = 14;

export function couldClamp(text: string): boolean {
  if (text.length >= COLLAPSE_MIN_TEXT_LEN) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 ) lines++;
  }
  return lines >= COLLAPSE_MIN_LINES;
}

export function CollapsibleMarkdown({
  children,
  text,
}: {
  children: React.ReactNode;
  text: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!couldClamp(text)) {
      setOverflowing(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setOverflowing(el.scrollHeight > COLLAPSE_MAX_PX + OVERFLOW_SLACK_PX);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const clamped = overflowing && !expanded;

  return (
    <div>
      <div
        ref={ref}
        style={
          clamped
            ? {
                maxHeight: COLLAPSE_MAX_PX,
                overflow: "hidden",
                maskImage: COLLAPSE_FADE,
                WebkitMaskImage: COLLAPSE_FADE,
              }
            : undefined
        }
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 rounded-cta px-1.5 py-0.5 text-[13px] font-medium text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink"
        >
          {expanded ? "Show less" : "Show more"}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}
