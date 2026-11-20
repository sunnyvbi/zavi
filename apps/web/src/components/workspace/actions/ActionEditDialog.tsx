"use client";

import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { cardIconButton } from "./card/styles";
import { cn } from "@/lib/cn";

const CHROME = "rounded-2xl bg-ca-bg text-ca-primary shadow-ca-xl backdrop:bg-ca-overlay";

export function ActionEditDialog({ title, subtitle, icon, divided = false, children, preview, previewTitle = "Preview", footer, busy, confirmDiscard, onClose }: {
  title: string;
  icon?: ReactNode;
  divided?: boolean;
  subtitle?: string;
  children: ReactNode;
  preview?: ReactNode;
  previewTitle?: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  confirmDiscard?: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const form = (
    <div className={cn("flex min-h-0 min-w-0 flex-col", divided && "max-h-ca-dialog")}>
      <header className="flex shrink-0 items-start justify-between gap-5 px-6 pb-2 pt-6">
        {icon && <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-ca-border bg-ca-bg">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-ca-dialog font-semibold tracking-tight text-ca-xdark">{title}</h2>
          {subtitle && <p className="mt-0.5 break-words text-ca-facts text-ca-secondary">{subtitle}</p>}
        </div>
        <button type="button" aria-label="Close" disabled={busy} onClick={(e) => { if (confirmDiscard) e.currentTarget.closest("dialog")?.dispatchEvent(new Event("cancel")); else onClose(); }} className={cn(cardIconButton, "-mr-3 -mt-3 shrink-0 bg-ca-surface text-ca-secondary hover:text-ca-primary")}>
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className={cn("min-h-0 min-w-0 space-y-4 px-6 py-4", divided ? "flex-1 overflow-y-auto" : "flex-none lg:flex-1", !!preview && "lg:overflow-y-auto")}>{children}</div>
      <footer className={cn("flex shrink-0 flex-wrap items-center gap-2 px-6 pb-6", divided ? "border-t border-ca-border pt-4" : "pt-2")}>{footer}</footer>
    </div>
  );
  return <AdsDialog size={preview ? "actionEdit" : "card"} chrome={CHROME} labelledBy={titleId} busy={busy} confirmDiscard={confirmDiscard} onClose={onClose}>
    {preview ? (
      <div className="grid min-h-0 min-w-0 shrink-0 grid-cols-1 lg:shrink lg:grid-cols-action-edit">
        <div className="flex min-h-0 min-w-0 flex-col lg:max-h-history-dialog-body">{form}</div>
        <aside aria-label="Preview" className="min-h-0 min-w-0 border-t border-ca-border bg-ca-subtle p-6 lg:max-h-history-dialog-body lg:overflow-y-auto lg:border-l lg:border-t-0">
          <h3 className="mb-4 flex items-center gap-2 text-ca-eyebrow font-medium text-ca-secondary">{previewTitle}</h3>
          {preview}
        </aside>
      </div>
    ) : form}
  </AdsDialog>;
}
