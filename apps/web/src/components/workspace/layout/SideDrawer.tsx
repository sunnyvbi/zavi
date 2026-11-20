"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, X } from "lucide-react";

const CLOSE_BUTTON =
  "rounded-cta p-1.5 text-ink hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";

export const SideDrawerHostContext = createContext<HTMLElement | null>(null);

export function SideDrawer({
  title,
  onClose,
  children,
  fullPage = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  fullPage?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const section = useContext(SideDrawerHostContext);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (fullPage && section) return createPortal(frame(title, onClose, children, fullPage, true), section);
  if (!host) return null;
  return createPortal(frame(title, onClose, children, fullPage, false), host);
}

function frame(title: string, onClose: () => void, children: ReactNode, fullPage: boolean, inSection: boolean) {
  return (
    <div
      role="dialog"
      aria-modal={!inSection}
      aria-label={title}
      className={
        inSection
          ? "absolute inset-0 z-30 flex justify-end text-ink"
          : "workspace-shell fixed inset-0 z-50 flex justify-end text-ink"
      }
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/35"
      />
      <div
        className={`relative flex h-full w-full flex-col bg-cream ${fullPage ? "" : "max-w-[min(760px,92vw)] border-l border-rule shadow-elev"}`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-3">
          {fullPage && (
            <button type="button" onClick={onClose} aria-label="Back" className={CLOSE_BUTTON}>
              <ArrowLeft className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="min-w-0 truncate text-[17px] font-bold text-ink">{title}</h2>
          </div>
          {!fullPage && (
            <button type="button" onClick={onClose} aria-label="Close" className={CLOSE_BUTTON}>
              <X className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
        </div>
        <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 [container-type:inline-size]">{children}</div>
      </div>
    </div>
  );
}
