"use client";

import { useEffect, useRef } from "react";
import { useServiceHealth } from "@/lib/serviceHealth";

export const SERVICE_DOWN_COPY =
  "Zavi is having trouble right now, so new messages and runs can't start. Your work is safe, and anything you type stays in the box.";
export const SERVICE_BACK_COPY = "Zavi is back. You can send again.";
export const SERVICE_BANNER_HEIGHT_VAR = "--service-banner-h";

export function ServiceStatusBanner() {
  const health = useServiceHealth();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const measure = () => root.style.setProperty(SERVICE_BANNER_HEIGHT_VAR, `${el.offsetHeight}px`);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(SERVICE_BANNER_HEIGHT_VAR);
    };
  }, [health]);
  if (health === "up") return null;
  const down = health === "down";
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className={`fixed inset-x-0 top-0 z-[60] px-4 py-2 text-center text-[13px] font-medium ${
        down ? "bg-coral text-white" : "bg-mint text-ink"
      }`}
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)" }}
    >
      {down ? SERVICE_DOWN_COPY : SERVICE_BACK_COPY}
    </div>
  );
}
