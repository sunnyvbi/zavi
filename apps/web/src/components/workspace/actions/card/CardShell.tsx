"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { CardTitle } from "./CardTitle";
import { cardIconButton, cardLink } from "./styles";

export function CardShell({ id, title, eyebrow, actions, steps, checklist, onClose, onAbout, stepsOpen, onToggleSteps, actionType, source, banner, dim, children }: {
  id: string;
  actionType?: string;
  source?: string | null;
  title: string;
  eyebrow: ReactNode;
  actions: ReactNode;
  steps: string[];
  checklist?: ReactNode;
  onClose?: () => void;
  onAbout: () => void;
  stepsOpen?: boolean;
  onToggleSteps?: () => void;
  banner?: ReactNode;
  dim?: boolean;
  children?: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = stepsOpen ?? ownOpen;
  const toggle = onToggleSteps ?? (() => setOwnOpen((v) => !v));
  const panel = `card-steps-${id}`;
  return (
    <article aria-label={title} data-testid={`action-${id}`} data-action-type={actionType} data-source={source ?? undefined} className="relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-ca-strong bg-ca-bg">
      {banner}
      <div data-testid="split-grid" className="contents">
        <div data-testid="split-left" className={cn("relative flex min-w-0 flex-col gap-3 p-5", dim && "opacity-60")}>
          {onClose && (
            <button type="button" aria-label={`Close “${title}”`} title="Close" onClick={onClose} className={cn(cardIconButton, "absolute right-3 top-3 text-ca-secondary hover:bg-ca-hover hover:text-ca-primary")}>
              <X className="size-4" aria-hidden />
            </button>
          )}
          {eyebrow}
          <CardTitle title={title} />
          {children}
          <div data-testid="card-footer" className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-ca-border pt-3">
            <span className="flex min-w-0 flex-none flex-wrap items-center gap-x-4 gap-y-1">
              <button type="button" data-card-open="how-it-works" aria-expanded={open} aria-controls={panel} onClick={toggle} className={cardLink}>
                How it works
                <ChevronDown className={cn("size-4 transition-transform duration-200 ease-ca-spring", open && "rotate-180")} aria-hidden />
              </button>
              <button type="button" data-card-open="what-it-is" aria-haspopup="dialog" onClick={onAbout} className={cardLink}>What it is</button>
            </span>
            {actions}
          </div>
          {open && checklist && <div id={panel}>{checklist}</div>}
          {open && !checklist && (
            <ol id={panel} className="mt-1 list-decimal rounded-xl bg-ca-subtle py-3 pl-8 pr-4 text-ca-facts text-ca-dark">
              {steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
          )}
        </div>
      </div>
    </article>
  );
}

export function DoneShell({ id, title, kind, status, actionType, banner, children }: { id: string; title: string; kind: string; status?: ReactNode; actionType?: string; banner?: ReactNode; children?: ReactNode }) {
  return (
    <article aria-label={title} data-testid={`action-${id}`} data-action-type={actionType} data-done className="relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-ca-border bg-ca-bg">
      {banner}
      <div data-testid="split-grid" className="contents">
        <div data-testid="split-left" className="relative flex min-w-0 flex-col gap-3 p-5">
          <p className="text-ca-eyebrow font-medium text-ca-dark">{kind}</p>
          <CardTitle title={title} />
          {status}
          {children}
        </div>
      </div>
    </article>
  );
}
