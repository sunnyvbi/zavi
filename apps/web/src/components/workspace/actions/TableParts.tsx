"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

export function ScoreMeter({
  value,
  max = 100,
  label,
  name,
}: {
  value: number;
  max?: number;
  label?: string;
  name: string;
}) {
  const top = max > 0 ? max : 100;
  const v = Math.max(0, Math.min(top, Math.round(value)));
  return (
    <span className="grid h-5 grid-cols-[64px_22px_auto] items-center gap-x-2 sm:grid-cols-[96px_22px_auto]">
      <span
        className="h-1.5 overflow-hidden rounded-full bg-bone"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={top}
        aria-valuenow={v}
        aria-label={name}
      >
        <span className="block h-full rounded-full bg-[#2e7d32]" style={{ width: `${(v / top) * 100}%` }} />
      </span>
      <span className="text-right text-[16px] font-semibold tabular-nums text-ink">{v}</span>
      <span className="text-[16px] text-inkMuted">{label ?? ""}</span>
    </span>
  );
}

const POP_GAP = 8;
const POP_EDGE = 12;

export function TermsPopover({
  terms,
  name,
  heading,
  buttonLabel,
}: {
  terms: readonly string[];
  name: string;
  heading: string;
  buttonLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean; arrow: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const popId = useId();

  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    const { width, height } = pop.current.getBoundingClientRect();
    const fitsRight = r.left + width <= window.innerWidth - POP_EDGE;
    const left = fitsRight ? r.left - 4 : Math.max(POP_EDGE, r.right - width + 4);
    const up = r.bottom + POP_GAP + height > window.innerHeight - POP_EDGE && r.top - POP_GAP - height > POP_EDGE;
    const arrow = Math.min(width - 16, Math.max(16, r.left + r.width / 2 - left));
    setPos({ left, top: up ? r.top - POP_GAP - height : r.bottom + POP_GAP, up, arrow });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setPos(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!terms.length) return <span className="inline-block w-6" aria-hidden />;

  return (
    <span className="inline-flex">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popId : undefined}
        aria-label={buttonLabel}
        onClick={() => {
          setPos(null);
          setOpen((v) => !v);
        }}
        className={`-my-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 ${
          open ? "bg-bone text-ink" : "text-inkMuted"
        }`}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={pop}
            id={popId}
            role="dialog"
            aria-label={name}
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
            className={`workspace-shell z-50 w-max min-w-[180px] max-w-[280px] rounded-xl border border-rule bg-cream px-3 pb-3 pt-2.5 shadow-elev animate-fade-in ${
              pos?.up ? "origin-bottom-left" : "origin-top-left"
            }`}
          >
            <span
              aria-hidden
              style={{ left: (pos?.arrow ?? 16) - 5 }}
              className={`absolute h-2.5 w-2.5 rotate-45 border-rule bg-cream ${
                pos?.up ? "-bottom-[6px] border-b border-r" : "-top-[6px] border-l border-t"
              }`}
            />
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-inkMuted">{heading}</p>
            <ul className="flex flex-wrap gap-2">
              {terms.map((t) => (
                <li key={t}>
                  <span className="inline-flex items-center rounded-md bg-bone px-1.5 py-0.5 text-[13px] font-medium text-inkSoft">
                    {t}
                  </span>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
}

export function TailToggle({
  open,
  hidden,
  words,
  onToggle,
}: {
  open: boolean;
  hidden: number;
  words: { show: (n: number) => string; hide: string };
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="mt-3 text-[16px] font-semibold text-inkMuted hover:text-ink"
    >
      {open ? words.hide : words.show(hidden)}
    </button>
  );
}
