"use client";
import type { ComponentProps, ReactNode } from "react";
import { ChevronDown, Info, X } from "lucide-react";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { cn } from "@/lib/cn";
import { ChannelMarkIcon } from "../../growth/GrowthChannelLabel";
import { cardButton, cardIconButton } from "../card/styles";

export const sheetLabel = "block text-[14px] font-medium leading-5 tracking-[0.14px] text-inkSoft";
export const sheetInput = "mt-1.5 min-h-11 w-full rounded-[10px] border border-rule bg-cream px-2.5 text-base font-medium leading-[22px] tracking-[0.15px] text-ink outline-none focus:border-ink disabled:opacity-60";
export const sheetHint = "mt-1.5 block text-[13px] font-medium leading-[18px] tracking-[0.13px] text-inkMuted";
export const sheetFooterButton = "h-12 rounded-cta px-4 text-[16px] font-semibold leading-6 disabled:opacity-40";

export function SheetSelect({ className = "", ...props }: ComponentProps<"select">) {
  return <span className="relative mt-1.5 block">
    <select {...props} className={`${sheetInput} !mt-0 cursor-pointer appearance-none pr-10 ${className}`} />
    <ChevronDown aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-inkMuted" />
  </span>;
}

export function SheetNote({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "neutral" }) {
  if (tone === "neutral") return <p className="flex items-center gap-2.5 rounded-xl border border-rule bg-creamDeep p-3 text-[14px] font-medium leading-5 tracking-[0.14px] text-inkSoft">
    <Info aria-hidden className="size-5 shrink-0 text-ink" />
    <span>{children}</span>
  </p>;
  return <p className="ads-sheet-note flex items-center gap-2.5 rounded-xl p-3 text-[14px] font-medium leading-5 tracking-[0.14px]">
    <span aria-hidden className="relative size-6 shrink-0">{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/icons/ads-sheet/information-circle.svg" alt="" className="absolute inset-[5.21%]" /></span>
    <span>{children}</span>
  </p>;
}

type Props = {
  titleId: string;
  title: ReactNode;
  slug?: string;
  busy?: boolean;
  onClose: () => void;
  footer: ReactNode | null;
  cancelLabel?: string;
  size?: "lg" | "wide";
  children: ReactNode;
};

const FOOTER_ACTIONS = "[&>button]:!h-10 [&>button]:!rounded-full [&>button]:!px-5 [&>button]:!text-[14px] [&>button]:!leading-5 [&>p]:!order-first sm:[&>p]:!basis-0 sm:[&>p]:!grow";

export function AdsSheet({ titleId, title, slug, busy = false, onClose, footer, cancelLabel = "Cancel", size = "lg", children }: Props) {
  return <AdsDialog size={size} labelledBy={titleId} busy={busy} onClose={onClose} chrome="ads-dialog-modal rounded-2xl bg-ca-bg text-ca-primary shadow-ca-xl">
    <header className="flex shrink-0 items-center gap-2.5 border-b border-ca-border px-6 py-4 compact:px-4">
      {slug && <ChannelMarkIcon slug={slug} />}
      <h2 id={titleId} className="min-w-0 flex-1 break-words text-[18px] font-semibold leading-[26px] text-ca-xdark">{title}</h2>
      <button type="button" aria-label="Close" disabled={busy} onClick={onClose} className={cn(cardIconButton, "shrink-0 text-ca-secondary hover:bg-ca-hover hover:text-ca-primary disabled:opacity-40")}><X className="size-5" aria-hidden /></button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 compact:px-4">{children}</div>
    {footer && <footer className={cn("flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:[&>button]:shrink-0 border-t border-ca-border bg-ca-bg px-6 py-3 compact:px-4", FOOTER_ACTIONS)}>
      <button type="button" className={cn(cardButton.base, cardButton.ghost)} disabled={busy} onClick={onClose}>{cancelLabel}</button>
      {footer}
    </footer>}
  </AdsDialog>;
}
