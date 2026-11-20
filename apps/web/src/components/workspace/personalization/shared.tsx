"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";
import { relativeTime } from "@/lib/workspace/relativeTime";

const join = (...parts: string[]) => parts.join(" ");

export const CARD = "rounded-[20px] border border-rule px-6 py-4";
export const LABEL = "block text-[14px] font-medium leading-5 text-ink";
export const HINT = "mt-1 text-[13px] leading-[18px] text-inkMuted";
export const INPUT = join(
  "mt-1.5 h-10 w-full rounded-[10px] border border-rule bg-cream px-3 text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60",
  FOCUS_RING,
);
export const TEXTAREA = join(
  "mt-1.5 w-full resize-y rounded-[10px] border border-rule bg-cream px-3 py-2.5 text-[16px] leading-[22px] text-ink outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:opacity-60",
  FOCUS_RING,
);
export const BTN_PRIMARY = join(
  "inline-flex h-10 items-center justify-center rounded-cta bg-ink px-4 text-[16px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING,
);
export const BTN_SECONDARY = join(
  "inline-flex h-10 items-center justify-center rounded-cta border border-rule bg-cream px-4 text-[16px] font-medium text-ink transition-colors hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING,
);
export const BTN_TEXT = join(
  "inline-flex h-8 items-center rounded-cta px-2 text-[13px] font-medium text-inkMuted transition-colors hover:bg-creamDeep hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING,
);

export function Updated({ at, prefix = "Updated" }: { at: string | null | undefined; prefix?: string }) {
  if (!at) return <span className="text-[13px] text-inkLight">Not saved yet</span>;
  return (
    <span className="text-[13px] text-inkMuted" title={new Date(at).toLocaleString()}>
      {prefix} {relativeTime(at)}
    </span>
  );
}

export function Section({
  id,
  title,
  description,
  updatedAt,
  children,
  aside,
}: {
  id: string;
  title: string;
  description?: string;
  updatedAt?: string | null;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="text-[16px] font-semibold leading-6 text-ink">
            {title}
          </h2>
          {description ? <p className="mt-1 text-[13px] leading-5 text-inkMuted">{description}</p> : null}
        </div>
        <div className="flex items-center gap-3">
          {aside}
          {updatedAt !== undefined ? <Updated at={updatedAt} /> : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SaveBar({
  dirty,
  saving,
  saved,
  error,
  onSave,
  onCancel,
  disabled,
  children,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={onSave} disabled={disabled || saving || !dirty} className={BTN_PRIMARY}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" onClick={onCancel} disabled={disabled || saving || !dirty} className={BTN_SECONDARY}>
        Cancel
      </button>
      <span aria-live="polite" role="status" className="text-[13px]">
        {error ? <span className="text-ink">{error}</span> : null}
        {!error && saved && !dirty ? (
          <span className="inline-flex items-center gap-1 text-inkMuted">
            <Check aria-hidden size={14} strokeWidth={2.2} /> Saved
          </span>
        ) : null}
      </span>
      {children}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <span className="text-[16px] leading-5 text-ink">{label}</span>
        {hint ? <p className="text-[13px] leading-[18px] text-inkMuted">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          checked ? "bg-ink" : "bg-ink/20",
          FOCUS_RING,
        )}
      >
        <span
          className={cx(
            "absolute top-[3px] flex h-5 w-5 items-center justify-center rounded-full bg-cream shadow-sm transition-all",
            checked ? "left-[21px]" : "left-[3px]",
          )}
        >
          {checked ? <Check aria-hidden size={12} strokeWidth={2.5} className="text-ink" /> : null}
        </span>
      </button>
    </div>
  );
}

export function SourceTag({ source }: { source: "confirmed" | "inferred" }) {
  return (
    <span className="rounded-md border border-rule bg-cream px-1.5 py-0.5 text-[12px] font-medium leading-4 text-inkMuted">
      {source === "confirmed" ? "Confirmed" : "Agent conclusion"}
    </span>
  );
}

export function errorMessageOf(body: unknown, fallback: string): string {
  const b = body as { error?: { message?: string } } | null;
  return b?.error?.message ?? fallback;
}
