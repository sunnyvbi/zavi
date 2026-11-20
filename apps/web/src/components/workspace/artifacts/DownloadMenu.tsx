"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Share } from "lucide-react";
import { PREVIEW_PANE_ICON_BUTTON } from "./previewPaneStyles";

export type DownloadOption = {
  key: string;
  format: string;
  label: string;
  meta?: string;
  onSelect: () => void;
};

export function DownloadMenu({ options, disabled = false }: { options: DownloadOption[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" data-menu-open={open ? "true" : undefined}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Download"
        title="Download"
        className={`${PREVIEW_PANE_ICON_BUTTON} disabled:opacity-40 ${open ? "bg-[#f4f4f5]" : ""}`}
      >
        <Share className="size-5" strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Download"
          className="absolute right-0 top-11 z-40 w-[300px] rounded-xl border border-[#ececec] bg-white p-1.5 shadow-[0_8px_28px_rgba(16,18,20,0.12)]"
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[12px] font-medium text-[#71717a]">Download</p>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitem"
              onClick={() => {
                o.onSelect();
                setOpen(false);
              }}
              className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[#f4f4f5] focus-visible:bg-[#f4f4f5] focus-visible:outline-none"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#f4f4f5] text-[10px] font-semibold uppercase tracking-[0.04em] text-[#3f3f46] group-hover:bg-white">
                {o.format}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5 text-[#18181b]">{o.label}</span>
                {o.meta && <span className="block truncate text-[12px] leading-4 text-[#71717a]">{o.meta}</span>}
              </span>
              <Download className="size-4 shrink-0 text-[#a1a1aa] group-hover:text-[#18181b]" strokeWidth={1.75} aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
