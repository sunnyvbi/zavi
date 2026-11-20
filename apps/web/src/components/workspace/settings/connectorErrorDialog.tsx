"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogHost } from "@/lib/workspace/useDialogHost";

export type ConnectorErrorPayload = {
  title?: string;
  message: string;
};

type Listener = (p: ConnectorErrorPayload) => void;
const listeners = new Set<Listener>();

export function showConnectorError(p: ConnectorErrorPayload): void {
  if (typeof window === "undefined") return;
  listeners.forEach((l) => l(p));
}

export function ConnectorErrorHost() {
  const [payload, setPayload] = useState<ConnectorErrorPayload | null>(null);
  const host = useDialogHost(payload !== null);

  useEffect(() => {
    const listener: Listener = (p) => setPayload(p);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPayload(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [payload]);

  if (!payload || !host) return null;

  const close = () => setPayload(null);

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={payload.title ?? "Error"}
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
    >
      {}
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px] motion-safe:animate-[fade-in_120ms_ease-out]"
      />
      {}
      <div className="relative w-full max-w-[400px] rounded-2xl border border-rule bg-cream p-6 text-center shadow-[0_24px_60px_rgba(0,0,0,0.35)] motion-safe:animate-[pop-in_140ms_cubic-bezier(0.23,1,0.32,1)]">
        {}
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
          <svg
            className="h-6 w-6 text-danger"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
        </div>
        <h2 className="font-display text-[18px] font-semibold leading-[24px] text-ink">
          {payload.title ?? "Something went wrong"}
        </h2>
        <p className="mt-2 whitespace-pre-line break-words text-[14px] leading-[1.5] text-inkMuted">
          {payload.message}
        </p>
        <button
          type="button"
          onClick={close}
          autoFocus
          className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-cta bg-ink px-4 text-[15px] font-semibold text-cream transition-colors hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
        >
          Got it
        </button>
      </div>
    </div>,
    host,
  );
}
