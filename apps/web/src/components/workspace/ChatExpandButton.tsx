"use client";

import { Tooltip } from "./Tooltip";

export const HEADER_CARD_SHADOW =
  "shadow-[0px_6px_16px_-4px_rgba(16,18,20,0.13),0px_0px_6px_-2px_rgba(14,15,17,0.03)]";

export function ChatExpandButton({
  expanded,
  onExpandedChange,
}: {
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
}) {
  const label = expanded ? "Collapse chat" : "Expand chat";
  return (
    <div className="flex h-14 shrink-0 items-center">
      <Tooltip label={label} side="bottom">
        <button
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className={`inline-flex size-8 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white p-[6px] text-[#1f1f1f] transition-colors duration-150 hover:bg-[#f9f9f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 motion-reduce:transition-none ${HEADER_CARD_SHADOW}`}
        >
          {expanded ? (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 3l-7 7M14 10h5.5M14 10V4.5M3 21l7-7M10 14H4.5M10 14v5.5" />
            </svg>
          ) : (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 3L3 21M21 3h-5.5M21 3v5.5M3 21h5.5M3 21v-5.5" />
            </svg>
          )}
        </button>
      </Tooltip>
    </div>
  );
}
