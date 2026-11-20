"use client";

import { Children, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { AdsDialog } from "@/components/ui/AdsDialog";

export const m = {
  label: "text-[13px] font-semibold text-[#1f1f1f]",
  hint: "mt-1.5 text-[13px] leading-5 text-[#8a8a8a]",
  input:
    "h-12 w-full rounded-xl border border-[#e5e7eb] bg-white px-3.5 text-[15px] text-[#0e0f11] outline-none placeholder:text-[#a8a8a8] focus:border-[#0e0f11] disabled:bg-[#fbfaf7] disabled:text-[#595959]",
  cancel:
    "cursor-pointer rounded-xl border border-[#e5e7eb] bg-white px-[18px] py-2.5 text-[16px] font-semibold text-[#595959] transition-colors hover:bg-[#f7f4ee] disabled:opacity-50",
  primary:
    "cursor-pointer rounded-xl border border-[#0e0f11] bg-[#0e0f11] px-[18px] py-2.5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40",
  error: "rounded-lg bg-[#fdebec] px-3 py-2 text-[13px] text-[#b4232a]",
  note: "rounded-xl border border-[#e5e7eb] bg-[#fbfaf7] px-4 py-3.5 text-[14px] leading-[1.5] text-[#1f1f1f]",
};

export function ActionModal({
  eyebrow,
  title,
  sub,
  onClose,
  busy = false,
  hint,
  footer,
  done,
  hideClose = false,
  bare = false,
  size = "lg",
  children,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  onClose: () => void;
  busy?: boolean;
  hint?: ReactNode;
  footer?: ReactNode;
  hideClose?: boolean;
  done?: ReactNode;
  bare?: boolean;
  size?: "md" | "lg";
  children: ReactNode;
}) {
  const hasBody = Children.toArray(children).length > 0;
  if (bare) {
    return (
      <AdsDialog size={size} label={title} onClose={onClose} busy={busy} closeOnBackdrop chrome="rounded-[18px] bg-white shadow-[0_30px_90px_-20px_rgba(0,0,0,.5)]">
        <div data-testid="action-modal-body" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-8">
          {children}
        </div>
      </AdsDialog>
    );
  }
  return (
    <AdsDialog size={size} label={title} onClose={onClose} busy={busy} closeOnBackdrop chrome="rounded-[18px] bg-white shadow-[0_30px_90px_-20px_rgba(0,0,0,.5)]">
      <div className={`relative shrink-0 px-6 pb-4 pt-5 ${hasBody ? "border-b border-[#e5e7eb]" : ""}`}>
        {!hideClose && <button
          type="button"
          onClick={() => {
            if (!busy) onClose();
          }}
          aria-label="Close"
          disabled={busy}
          className="absolute right-3 top-3 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-none p-0 text-[#a8a8a8] hover:bg-[#f7f4ee] hover:text-[#595959] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0e0f11]/30 disabled:cursor-default"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
        </button>}
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">{eyebrow}</div>
        <h2 className="mt-1 pr-8 text-[20px] font-bold tracking-[-.02em] text-[#0e0f11]">{title}</h2>
        <p className="mt-0.5 pr-8 text-[13px] leading-5 text-[#595959]">{sub}</p>
      </div>
      {hasBody && (
        <div data-testid="action-modal-body" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-[18px]">
          <div className="flex flex-col gap-5">{children}</div>
        </div>
      )}
      {done ?? (footer == null && hint == null ? null : (
        <div data-testid="action-modal-footer" className="flex shrink-0 flex-col items-stretch gap-3 border-t border-[#e5e7eb] bg-[#fbfaf7] px-6 py-[15px] sm:flex-row sm:items-center sm:justify-between">
          <span data-testid="action-modal-hint" className="min-w-0 text-[12px] leading-4 text-[#8a8a8a]">{hint}</span>
          <div data-testid="action-modal-buttons" className="flex w-full flex-wrap justify-end gap-2.5 sm:w-auto sm:shrink-0 sm:flex-nowrap">{footer}</div>
        </div>
      ))}
    </AdsDialog>
  );
}

export function MField({ label, hint, error, htmlFor, children }: { label: string; hint?: ReactNode; error?: string | null; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={m.label}>
          {label}
        </label>
      ) : (
        <p className={m.label}>{label}</p>
      )}
      <div className="mt-2">{children}</div>
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="mt-1.5 text-[13px] leading-5 text-[#b4232a]">
          {error}
        </p>
      ) : (
        hint && <p className={m.hint}>{hint}</p>
      )}
    </div>
  );
}

const TILE_COLS: Record<number, string> = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" };

export function Tiles({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ id: string; label: string; sub: string }>;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`grid grid-cols-1 gap-2 ${TILE_COLS[Math.min(options.length, 3)] ?? ""}`}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${on ? "border-[#0e0f11] bg-[#fbfaf7]" : "border-[#e5e7eb] hover:bg-[#fbfaf7]"}`}
          >
            <span className={`mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-[#0e0f11]" : "border-[#c8c8c8]"}`}>
              {on && <span className="h-2 w-2 rounded-full bg-[#0e0f11]" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-[#0e0f11]">{o.label}</span>
              <span className="block text-[12px] leading-[17px] text-[#8a8a8a]">{o.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function MRows({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div className="rounded-xl border border-[#e5e7eb]">
      {rows.map(([k, v], i) => (
        <div key={k} className={`flex items-center justify-between gap-4 px-3.5 py-[11px] text-[14px] ${i < rows.length - 1 ? "border-b border-[#f0ede5]" : ""}`}>
          <span className="text-[#595959]">{k}</span>
          <span className="text-right font-semibold text-[#1f1f1f]">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function MDone({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-t border-emerald-200 bg-emerald-50 px-6 py-[15px]">
      <span className="flex items-center gap-2 text-[14px] font-medium text-emerald-800">
        <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> {text}
      </span>
      {action}
    </div>
  );
}
