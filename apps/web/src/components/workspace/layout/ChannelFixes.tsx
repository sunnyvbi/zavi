"use client";

import { useState, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import { cx, FOCUS_RING } from "./shared";
import { CountPill } from "../CountPill";

export function ChannelFixes({
  title = "Action items",
  count,
  compact,
  full,
  empty,
}: {
  title?: string;
  count: number;
  compact: ReactNode;
  full: ReactNode;
  empty: ReactNode;
}) {
  const [dense, setDense] = useState(true);
  const tab = (on: boolean) =>
    cx(
      "rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none",
      on ? "bg-white text-ink shadow-elev" : "text-inkMuted hover:text-ink",
      FOCUS_RING,
    );
  return (
    <section aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[20px] font-semibold tracking-tight text-ink">{title}</h3>
          {count > 0 && (
            <CountPill count={count} testId="fixes-count" />
          )}
        </div>
        {count > 0 && (
          <div role="group" aria-label="Detail level" className="flex items-center gap-0.5 rounded-full bg-bone p-0.5">
            <button type="button" aria-pressed={!dense} onClick={() => setDense(false)} className={tab(!dense)}>
              Issue + fix
            </button>
            <button type="button" aria-pressed={dense} onClick={() => setDense(true)} className={tab(dense)}>
              Compact
            </button>
          </div>
        )}
      </div>
      {count === 0 ? (
        empty
      ) : dense ? (
        <ul className="overflow-hidden rounded-2xl border border-rule bg-white">{compact}</ul>
      ) : (
        <ul className="flex flex-col gap-2.5">{full}</ul>
      )}
    </section>
  );
}

export function CompactActionRow({
  title,
  meta,
  isNew,
  blocking,
  icon,
  primaryLabel,
  primaryTone = "quiet",
  busy,
  onPrimary,
  onAskZavi,
}: {
  title: string;
  meta: string;
  isNew: boolean;
  blocking: boolean;
  icon: ReactNode;
  primaryLabel: string;
  primaryTone?: "loud" | "quiet";
  busy: boolean;
  onPrimary: () => void;
  onAskZavi: () => void;
}) {
  const button =
    "inline-flex h-8 shrink-0 items-center gap-2 rounded-cta px-3 text-[13px] font-semibold transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50";
  return (
    <li className="flex items-start gap-3 border-b border-rule p-3.5 last:border-b-0">
      <span aria-hidden className="mt-0.5 shrink-0 text-inkMuted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[16px] font-semibold leading-5 text-ink">
          <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
          {blocking && (
            <span className="rounded-full bg-ink px-2 py-[1px] text-[11px] font-medium text-cream">Blocking</span>
          )}
          {isNew && (
            <span className="rounded-full bg-successBg px-2 py-[1px] text-[11px] font-medium text-success">New</span>
          )}
        </p>
        <p className="mt-0.5 text-[13px] leading-4 text-inkMuted lg:hidden">{meta}</p>
      </div>
      <span className="hidden shrink-0 pt-1 text-[13px] text-inkMuted lg:inline">{meta}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onPrimary}
        className={cx(
          button,
          primaryTone === "loud"
            ? "bg-ink text-cream hover:bg-inkSoft"
            : "border border-rule bg-white text-ink hover:bg-creamDeep",
          FOCUS_RING,
        )}
      >
        {primaryLabel}
      </button>
      <button
        type="button"
        onClick={onAskZavi}
        aria-label={`Ask Zavi about ${title}`}
        className={cx(button, "border border-rule bg-white text-inkMuted hover:bg-creamDeep hover:text-ink", FOCUS_RING)}
      >
        <MessageSquare className="h-4 w-4" aria-hidden />
        Zavi
      </button>
    </li>
  );
}
