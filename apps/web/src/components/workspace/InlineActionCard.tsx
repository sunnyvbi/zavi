"use client";

import { useState, type ReactNode } from "react";

export type ActionVariant =
  | "tool"
  | "file_read"
  | "file_edit"
  | "file_create"
  | "decision";

const STYLE: Record<
  ActionVariant,
  { glyph: string; border: string; bg: string; glyphLabel: string }
> = {
  tool: {
    glyph: "⚙",
    glyphLabel: "tool call",
    border: "border-l-ink/25",
    bg: "bg-bone",
  },
  file_read: {
    glyph: "👁",
    glyphLabel: "file read",
    border: "border-l-ink/25",
    bg: "bg-bone",
  },
  file_edit: {
    glyph: "✎",
    glyphLabel: "file edit",
    border: "border-l-amber-500",
    bg: "bg-amber-50/40",
  },
  file_create: {
    glyph: "✚",
    glyphLabel: "file create",
    border: "border-l-emerald-500",
    bg: "bg-emerald-50/40",
  },
  decision: {
    glyph: "⚖",
    glyphLabel: "decision",
    border: "border-l-ink/40",
    bg: "bg-bone/50",
  },
};

export type InlineActionCardProps = {
  variant: ActionVariant;
  title: string;
  detail?: string;
  meta?: string;
  children?: ReactNode;
  error?: boolean;
};

export function InlineActionCard({
  variant,
  title,
  detail,
  meta,
  children,
  error,
}: InlineActionCardProps) {
  const [open, setOpen] = useState(false);
  const s = STYLE[variant];
  return (
    <div
      className={`
        rounded-md border border-ink/10 border-l-2 text-[12px]
        ${error ? "border-l-rose-500 bg-rose-50/40" : `${s.border} ${s.bg}`}
      `}
    >
      <button
        type="button"
        disabled={!children}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={children ? open : undefined}
        className={`
          flex w-full items-center gap-2 px-2.5 py-1.5 text-left
          ${children ? "cursor-pointer" : "cursor-default"}
        `}
      >
        <span aria-label={s.glyphLabel} className="font-mono text-[12px]">
          {s.glyph}
        </span>
        <span className="font-mono text-ink truncate">{title}</span>
        {detail && (
          <span className="font-mono text-inkMuted truncate">
            {detail.length > 80 ? `${detail.slice(0, 80)}…` : detail}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-inkMuted">
          {meta && <span>{meta}</span>}
          {children && (
            <span aria-hidden className="text-inkMuted">
              {open ? "▾" : "▸"}
            </span>
          )}
        </span>
      </button>
      {children && open && (
        <div className="border-t border-ink/10 px-2.5 py-1.5 text-ink">
          {children}
        </div>
      )}
    </div>
  );
}
