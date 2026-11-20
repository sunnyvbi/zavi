"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardIconButton } from "./styles";

export function CardDialog({ open, label, onClose, children }: { open: boolean; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="m-auto max-h-ca-dialog w-ca-dialog animate-ca-rise overflow-hidden rounded-2xl bg-ca-bg p-0 text-ca-primary shadow-ca-xl backdrop:bg-ca-overlay"
    >
      {open && (
        <div className="relative flex max-h-ca-dialog flex-col">
          <button type="button" aria-label="Close" onClick={onClose} className={cn(cardIconButton, "absolute right-3 top-3 z-10 bg-ca-surface text-ca-secondary hover:text-ca-primary")}>
            <X className="size-4" aria-hidden />
          </button>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function DialogHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h3 className="pr-10 text-ca-dialog font-semibold tracking-tight text-ca-xdark">{title}</h3>
      {subtitle && <p className="mt-0.5 line-clamp-2 break-words text-ca-facts text-ca-secondary" title={subtitle}>{subtitle}</p>}
    </>
  );
}
