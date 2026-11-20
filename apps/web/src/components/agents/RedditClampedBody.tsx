"use client";

import { useState } from "react";

export function RedditClampedBody({ text, className }: { text: string; label?: string; className: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 360 || text.split("\n").length > 6;
  return (
    <>
      <p className={`whitespace-pre-wrap ${className} ${long && !open ? "line-clamp-5" : ""}`}>{text}</p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 text-[16px] font-semibold text-inkMuted hover:text-ink"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
