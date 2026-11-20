"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cx, prefersReducedMotion, useModalFocusTrap } from "./shared";

export const NAV_EXIT_MS = 100;

export const NAV_ACTIVATION_SELECTOR =
  'a[href], [aria-current="page"], [data-nav-item]';

export function CompactNavOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode | ((dismiss: () => void) => ReactNode);
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const dismiss = useCallback(() => {
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => onCloseRef.current(), NAV_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);
  useModalFocusTrap(panelRef, dismiss);

  useEffect(() => {
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, []);

  const onNavigationActivated = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(NAV_ACTIVATION_SELECTOR)) return;
    dismiss();
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        data-closing={closing ? "" : undefined}
        onClickCapture={onNavigationActivated}
        className={cx(
          "relative z-10 flex h-full w-[86%] max-w-[330px] flex-col bg-cream shadow-lift",
          "will-change-[opacity] motion-reduce:animate-none",
          closing ? "animate-nav-out" : "animate-nav-in",
        )}
      >
        {typeof children === "function" ? children(dismiss) : children}
      </div>
      <button
        type="button"
        aria-label="Close navigation"
        onClick={dismiss}
        className="flex-1 bg-transparent"
      />
    </div>
  );
}
