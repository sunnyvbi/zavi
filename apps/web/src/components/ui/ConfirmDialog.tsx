"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  body?: ReactNode;
  size?: "md" | "lg";
  acknowledgeOnly?: boolean;
};

type ConfirmRequest = ConfirmOptions & { settle: (confirmed: boolean) => void };

const listeners = new Set<(request: ConfirmRequest) => void>();

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (listeners.size === 0) {
    const fallback = [options.title, options.description].filter(Boolean).join("\n\n");
    return Promise.resolve(window.confirm(fallback));
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    listeners.forEach((listener) => listener({ ...options, settle }));
  });
}

export function ConfirmDialogHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const pending = useRef<ConfirmRequest | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const bodyId = useId();

  useEffect(() => {
    const listener = (next: ConfirmRequest) => {
      pending.current = next;
      setHost(document.querySelector<HTMLElement>(".workspace-shell") ?? document.body);
      setRequest(next);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.settle(confirmed);
  }, []);

  const focusConfirm = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);

  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>("button");
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = cardRef.current?.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request, settle]);

  if (!request || !host) return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => settle(false)}
        className="fixed inset-0 z-[60] cursor-default bg-black/40"
      />
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={
          [request.description ? descriptionId : null, request.body ? bodyId : null].filter(Boolean).join(" ") || undefined
        }
        className={cn(
          "fixed left-1/2 top-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] max-w-[92vw] flex-col",
          request.size === "lg" ? "w-[520px]" : "w-[420px]",
          "-translate-x-1/2 -translate-y-1/2 rounded-2xl border border-rule bg-cream shadow-[0_24px_60px_rgba(25,25,25,0.22)]",
        )}
      >
        <div className="min-h-0 overflow-y-auto px-4 pt-5">
          <h3 id={titleId} className="font-display text-[16px] font-semibold text-ink">
            {request.title}
          </h3>
          {request.description && (
            <p
              id={descriptionId}
              className="mt-1.5 text-[13px] leading-[1.5] text-inkMuted"
            >
              {request.description}
            </p>
          )}
          {request.body && (
            <div id={bodyId} className="mt-3">
              {request.body}
            </div>
          )}
        </div>
        <div className="mt-4 flex shrink-0 justify-end gap-2.5 border-t border-rule px-4 py-3.5">
          <button
            ref={request.acknowledgeOnly ? focusConfirm : undefined}
            type="button"
            onClick={() => settle(false)}
            className="rounded-cta px-3 py-1.5 text-[13px] font-medium text-inkMuted transition-colors hover:text-ink"
          >
            {request.cancelLabel ?? "Cancel"}
          </button>
          {!request.acknowledgeOnly && (
            <button
              ref={focusConfirm}
              type="button"
              onClick={() => settle(true)}
              className={cn(
                "rounded-cta px-3.5 py-1.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2",
                request.tone === "danger"
                  ? "bg-danger text-white hover:bg-danger/85 focus-visible:ring-danger/40"
                  : "bg-ink text-cream hover:bg-ink/85 focus-visible:ring-ink/40",
              )}
            >
              {request.confirmLabel ?? "Confirm"}
            </button>
          )}
        </div>
      </div>
    </>,
    host,
  );
}
