"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown, Info, Loader2, X } from "lucide-react";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { cn } from "@/lib/cn";
import { ChannelMarkIcon } from "../../growth/GrowthChannelLabel";
import { cardButton, cardIconButton } from "../card/styles";

export const editInput = "h-12 w-full rounded-xl border border-ca-strong bg-ca-bg px-3 text-ca-facts text-ca-dark outline-none transition placeholder:text-ca-muted focus:border-ca-border-focus focus:shadow-ca-ring disabled:cursor-not-allowed disabled:opacity-60";

type Submit = { label: string; disabled: boolean; reason: string };

export function CampaignEditModal({ slug, title, subtitle, busy, formId, submit, cancelLabel = "Cancel", onClose, children }: {
  slug: string;
  title: string;
  subtitle: string;
  busy: boolean;
  formId: string | null;
  submit: Submit;
  cancelLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const reasonId = useId();
  return (
    <AdsDialog size="campaign" labelledBy={titleId} busy={busy} onClose={onClose} chrome="rounded-2xl bg-ca-bg text-ca-primary shadow-ca-xl backdrop:bg-ca-overlay">
      <div className="flex max-h-ca-dialog min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <div className="flex items-start gap-2.5">
            <ChannelMarkIcon slug={slug} />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="break-words text-[18px] font-semibold leading-[26px] text-ca-xdark">{title}</h2>
              <p className="mt-0.5 text-ca-action text-ca-secondary">{subtitle}</p>
            </div>
            <button type="button" aria-label="Close" disabled={busy} onClick={onClose} className={cn(cardIconButton, "shrink-0 text-ca-secondary hover:bg-ca-hover hover:text-ca-primary", busy && "invisible")}>
              <X className="size-5" aria-hidden />
            </button>
          </div>
          {children}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-ca-border bg-ca-bg px-5 py-3">
          <p id={reasonId} role="status" className={cn(!submit.reason && "sr-only", "min-w-0 flex-1 basis-0 text-ca-action text-ca-secondary")}>{submit.reason}</p>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!busy && <button type="button" onClick={onClose} className={cn(cardButton.base, cardButton.ghost)}>{cancelLabel}</button>}
            {formId && (
              <button type="submit" form={formId} disabled={submit.disabled || busy} aria-busy={busy} aria-describedby={submit.reason ? reasonId : undefined} className={cn(cardButton.base, cardButton.primary, "!whitespace-nowrap", busy && "disabled:opacity-100")}>
                {busy && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
                {busy ? "Saving…" : submit.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </AdsDialog>
  );
}

export function EditSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-ca-row font-semibold text-ca-xdark">{title}</h3>
      {children}
    </section>
  );
}

export function EditField({ label, hint, counter, children }: { label: string; hint?: string; counter?: string; children: (ids: { id: string; describedBy?: string }) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-h`;
  const counterId = `${id}-n`;
  const describedBy = [hint ? hintId : null, counter ? counterId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-ca-action font-medium text-ca-dark">{label}</label>
        {counter && <span id={counterId} className="text-ca-eyebrow tabular-nums text-ca-secondary">{counter}</span>}
      </div>
      {children({ id, describedBy })}
      {hint && (
        <p id={hintId} className="flex items-center gap-1.5 text-ca-action text-ca-secondary">
          <Info className="size-4 shrink-0" aria-hidden />
          {hint}
        </p>
      )}
    </div>
  );
}

export function ReadOnlyField({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <p className="text-ca-action font-semibold text-ca-dark">{label}</p>
      <p className="mt-1 text-ca-facts text-ca-xdark">{value}</p>
      {note && <p className="mt-0.5 text-ca-action text-ca-secondary">{note}</p>}
    </div>
  );
}

export function MoreSettings({ children }: { children: ReactNode }) {
  return (
    <details className="group border-t border-ca-border pt-4">
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between text-ca-row font-semibold text-ca-xdark [&::-webkit-details-marker]:hidden">
        More settings
        <ChevronDown className="size-4 text-ca-secondary transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </details>
  );
}
