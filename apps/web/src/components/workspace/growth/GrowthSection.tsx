"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";

export function GrowthSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2.5 flex items-baseline gap-3 compact:mb-2 compact:flex-wrap">
        <h2 className="text-xl font-semibold leading-tight tracking-tight text-ink">
          {title}
        </h2>
        {count && (
          <span className="text-sm tabular-nums text-inkMuted">{count}</span>
        )}
        {action && <div className="ml-auto self-center">{action}</div>}
      </div>
      <div className="rounded-2xl border border-rule bg-cream p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] compact:p-4">
        {children}
      </div>
    </section>
  );
}

export function MemoBlock({
  n,
  title,
  aside,
  children,
}: {
  n: number;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `growth-memo-block-${n}`;
  return (
    <section aria-labelledby={headingId} className="scroll-mt-4">
      <div className="flex min-h-9 items-center gap-3">
        <span aria-hidden="true" className="w-5 shrink-0 text-sm font-semibold tabular-nums text-inkMuted">
          {n}
        </span>
        <h2 id={headingId} className="flex-1 text-sm font-semibold uppercase tracking-[0.02em] text-inkSoft">
          {title}
        </h2>
        {aside}
      </div>
      <div className="mt-3 pl-8 compact:pl-0">{children}</div>
    </section>
  );
}

export function FactRow({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="py-3">
      <div className="flex items-start gap-3 compact:flex-wrap">
        <h3 className="w-[92px] shrink-0 pt-1 text-[13px] font-semibold text-inkSoft">{label}</h3>
        <div className="min-w-0 flex-1 text-[14px] leading-6 text-ink">{children}</div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </section>
  );
}

export function SectionAction({
  children,
  onClick,
  disabled,
  expanded,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-expanded={expanded}
      className="inline-flex items-center gap-2 rounded-cta px-2 py-1 text-sm font-medium text-ink hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-rule px-4 py-3 text-sm text-inkMuted">
      {children}
    </p>
  );
}

export type ChipTone = "good" | "wait" | "bad" | "live" | "quiet";

const CHIP_TONE: Record<ChipTone, string> = {
  good: "bg-successBg text-success dark:bg-success/20 dark:text-mint",
  wait: "bg-warnBg text-warn dark:bg-marigold/15 dark:text-marigold",
  bad: "bg-dangerBg text-danger dark:bg-danger/20 dark:text-coral",
  live: "bg-brand/10 text-brand",
  quiet: "bg-creamDeep text-inkMuted",
};

export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-semibold",
        CHIP_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

export function CardDivider() {
  return <hr className="my-4 border-rule compact:my-3" />;
}

export function SubLabel({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-inkSoft">{children}</h3>;
}

export function SuggestionChip({
  children,
  onClick,
  disabled,
  label,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="inline-flex items-center gap-2 rounded-cta border border-dashed border-rule px-3 py-1.5 text-sm text-ink hover:border-inkMuted hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Plus className="h-3.5 w-3.5 text-inkMuted" aria-hidden="true" />
      {children}
    </button>
  );
}

export function InlineAdd({
  icon,
  placeholder,
  value,
  onChange,
  onSubmit,
  disabled,
  busy,
  label,
}: {
  icon: ReactNode;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
}) {
  const empty = value.trim().length === 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty && !disabled && !busy) onSubmit();
      }}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-rule px-3.5 py-2 focus-within:border-inkMuted",
        disabled && "opacity-50",
      )}
    >
      <span className="shrink-0 text-inkMuted" aria-hidden="true">
        {icon}
      </span>
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-inkMuted focus:outline-none"
      />
      <button
        type="submit"
        disabled={empty || disabled || busy}
        className="shrink-0 text-[13px] font-medium text-ink disabled:text-inkMuted"
      >
        {busy ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

const PRIMARY =
  "inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-cream hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function PrimaryButton({
  children,
  onClick,
  disabled,
  href,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  href?: string;
}) {
  if (href) {
    return (
      <a href={href} className={PRIMARY}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={PRIMARY}>
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  label,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`shrink-0 rounded-cta border border-rule bg-cream px-4 py-2 text-sm font-medium text-ink hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}
