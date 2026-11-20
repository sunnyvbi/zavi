"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { channelMark } from "../../channelMark";

export const box = "rounded-2xl border border-rule bg-cream";
export const cardBox = "rounded-2xl border border-ink/15 bg-cream";
export const eyebrow = "text-[12px] font-semibold uppercase leading-4 tracking-[0.08em] text-inkMuted";
export const rowLine = "border-t border-rule first:border-t-0";

const pillSize = "inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-[14px] font-semibold leading-5 transition-colors duration-150";
const small = pillSize;
const tone = (dark?: boolean, _pill?: boolean) =>
  dark ? "border-ink bg-ink text-cream hover:bg-inkSoft" : "border-ink/15 bg-cream text-ink hover:bg-creamDeep";

export function B({
  dark,
  pill,
  children,
  onClick,
  disabled,
  label,
}: {
  dark?: boolean;
  pill?: boolean;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(pill ? pillSize : small, tone(dark, pill), "disabled:cursor-not-allowed disabled:opacity-40")}
    >
      {children}
    </button>
  );
}

export function BLink({ dark, pill, href, children }: { dark?: boolean; pill?: boolean; href: string; children: ReactNode }) {
  return (
    <a href={href} className={cn(pill ? pillSize : small, tone(dark, pill))}>
      {children}
    </a>
  );
}

export function L({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="cursor-pointer rounded-sm text-[14px] font-medium text-inkMuted underline decoration-ink/15 underline-offset-4 hover:text-ink hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function Switch({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn("relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full disabled:opacity-40", on ? "bg-success" : "bg-ink/15")}
    >
      <span className={cn("absolute size-5 rounded-full bg-white shadow-sm transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  w = "w-24",
  autoFocus,
  label,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  w?: string;
  autoFocus?: boolean;
  label?: string;
  onEnter?: () => void;
}) {
  return (
    <input
      autoFocus={autoFocus}
      value={value}
      aria-label={label ?? placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      placeholder={placeholder}
      className={cn(w, "h-10 rounded-full border border-ink/15 bg-cream px-4 text-[15px] text-ink outline-none placeholder:text-inkMuted focus:border-[#60acff] focus:shadow-[0_0_0_4px_#e6f2ff] dark:focus:shadow-none")}
    />
  );
}

export function Fold({ title, aside, children, empty }: { title: ReactNode; aside?: ReactNode; children?: ReactNode; empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={rowLine}>
      <button
        type="button"
        disabled={empty}
        aria-expanded={empty ? undefined : open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-[15px] leading-6 text-ink disabled:cursor-default"
      >
        {!empty && (open ? <ChevronDown className="h-4 w-4 text-inkMuted" /> : <ChevronRight className="h-4 w-4 text-inkMuted" />)}
        <span className="font-semibold">{title}</span>
        {aside && <span className="ml-auto text-right text-[14px] text-inkMuted">{aside}</span>}
      </button>
      {open && !empty && <div className="bg-creamDeep/40 pb-1.5">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string; count?: number; tone?: "danger" | "warn" | "info" }[];
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.04] p-1">
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const j = (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
              onChange(items[j]!.value);
              refs.current[j]?.focus();
            }}
            className={cn(
              "inline-flex h-9 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full px-4 text-[13px] font-semibold leading-4 tracking-[0.01em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30",
              on ? "bg-cream shadow-sm" : "hover:text-ink",
              it.tone === "danger"
                ? "text-[#a91e24]"
                : it.tone === "warn"
                ? "text-[#935f01]"
                : it.tone === "info"
                ? "text-[#006688]"
                : on
                ? "text-ink"
                : "text-inkMuted",
            )}
          >
            {it.label}
            {it.count !== undefined && <span className="ml-1 tabular-nums">({it.count})</span>}
          </button>
        );
      })}
    </div>
  );
}

export type SrcKind = "measured" | "estimate" | "blocked" | "unmeasured" | "typed";
export function Src({ kind, children }: { kind: SrcKind; children: ReactNode }) {
  const tone = {
    measured: "bg-success/10 text-success dark:text-mint",
    typed: "bg-ink/5 text-inkMuted",
    estimate: "bg-[#2950B8]/10 text-[#2950B8] dark:text-[#9db5ff]",
    blocked: "bg-warn/10 text-warn dark:text-marigold",
    unmeasured: "bg-ink/5 text-inkMuted",
  }[kind];
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 align-middle text-[12px] font-medium leading-4", tone)}>{children}</span>;
}

export function Step({
  n,
  title,
  id,
  last,
  children,
}: {
  n: number;
  title: string;
  id?: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} className="relative scroll-mt-24 pl-12">
      {!last && <span aria-hidden="true" className="absolute bottom-[-6px] left-[15px] top-9 w-px bg-ink/15" />}
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[14px] font-semibold tabular-nums text-cream"
      >
        {n}
      </span>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-[18px] font-semibold leading-8 text-ink">{title}</h2>
      </div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function Rail() {
  return (
    <div aria-hidden="true" className="relative h-6">
      <span className="absolute bottom-0 left-[15px] top-0 w-px bg-ink/15" />
    </div>
  );
}

export function RingMark({ slug, size = 24 }: { slug: string; size?: number }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-full border border-rule bg-white" style={{ width: size, height: size }}>
      <Mark slug={slug} size={Math.round(size * 0.66)} />
    </span>
  );
}

export function Mark({ slug, size = 18 }: { slug: string | null; size?: number }) {
  if (!slug) return <span aria-hidden="true" className="shrink-0" style={{ width: size, height: size }} />;
  const m = channelMark(slug);
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full", m.bg)} style={{ width: size, height: size }}>
      {m.kind === "glyph" ? (
        <m.Icon className={m.fg} style={{ width: size * 0.55, height: size * 0.55 }} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.src} alt="" className={m.fit === "cover" ? "h-full w-full object-cover" : "object-contain"} style={m.fit === "cover" ? undefined : { width: size * 0.65, height: size * 0.65 }} />
      )}
    </span>
  );
}

export type Overlay = { kind: "modal" | "drawer"; title: string; body: ReactNode } | null;

export function Modal({ o, close }: { o: NonNullable<Overlay>; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/30 pt-[14vh]" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={o.title}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "raised-surface bg-cream p-5 text-ink shadow-2xl",
          o.kind === "drawer" ? "fixed bottom-0 right-0 top-0 w-[400px] max-w-full overflow-y-auto" : "w-[min(560px,calc(100vw-32px))] rounded-2xl p-7",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[22px] font-semibold leading-[30px] tracking-tight">{o.title}</p>
          <button type="button" aria-label="Close" onClick={close} className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-creamDeep text-inkSoft hover:text-ink">
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
        <div className="mt-3 text-[15px] leading-6 text-inkSoft">{o.body}</div>
      </div>
    </div>
  );
}

export type Toast = { id: number; text: string; undo?: () => void };

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-5 left-1/2 z-[110] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-center gap-3 rounded-xl bg-ink px-4 py-2.5 text-[14px] text-cream shadow-xl">
          {t.text}
          {t.undo && (
            <button
              type="button"
              onClick={() => {
                t.undo!();
                dismiss(t.id);
              }}
              className="cursor-pointer font-semibold text-[#7fd1a0] underline"
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
