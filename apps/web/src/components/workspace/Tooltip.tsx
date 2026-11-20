"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const EDGE_MARGIN = 8;

export function Tooltip({
  label,
  side = "bottom",
  disabled = false,
  children,
}: {
  label: string;
  side?: "top" | "bottom";
  disabled?: boolean;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [coord, setCoord] = useState<{ cx: number; y: number } | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  const show = useCallback(() => {
    const el = anchorRef.current;
    if (!el || disabled) return;
    const r = el.getBoundingClientRect();
    setLeft(null);
    setCoord({
      cx: r.left + r.width / 2,
      y: side === "bottom" ? r.bottom + 6 : r.top - 6,
    });
  }, [side, disabled]);
  const hide = useCallback(() => {
    setCoord(null);
    setLeft(null);
  }, []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useEffect(() => {
    if (!coord || !tipRef.current) return;
    const tw = tipRef.current.offsetWidth;
    const vw = window.innerWidth;
    const desired = coord.cx - tw / 2;
    const clamped = Math.max(EDGE_MARGIN, Math.min(desired, vw - tw - EDGE_MARGIN));
    setLeft(clamped);
  }, [coord]);

  return (
    <span
      ref={anchorRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {coord !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            style={{
              position: "fixed",
              left: left ?? coord.cx,
              top: coord.y,
              transform: side === "top" ? "translateY(-100%)" : undefined,
              visibility: left === null ? "hidden" : "visible",
            }}
            className="pointer-events-none z-[9999] max-w-[min(90vw,320px)] whitespace-nowrap rounded-lg border border-[#ececec] bg-white px-2.5 py-1.5 text-[12px] font-medium leading-none text-[#1f1f1f] shadow-[0_6px_16px_-4px_rgba(16,24,40,0.18)]"
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
