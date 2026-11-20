"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CONNECTOR_ICON } from "./connectorLogos";
import { FOCUS_RING } from "../layout/shared";

export function ConnectorLockup({
  slug,
  label,
}: {
  slug: string;
  label: string;
}) {
  const src = CONNECTOR_ICON[slug];
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    const initials =
      label
        .replace(/[^A-Za-z0-9 ]/g, "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("") || "?";
    return (
      <div className="flex h-6 min-w-0 items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f0f0f0] text-[11px] font-bold tracking-tight text-[#595959]">
          {initials}
        </span>
        <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
          {label}
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="h-6 w-6 shrink-0 rounded-[6px] object-contain"
        onError={() => setFailed(true)}
      />
      <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
        {label}
      </span>
    </div>
  );
}

export function ConnectorTile({
  id,
  logo,
  name,
  description,
  status,
  action,
  extra,
  highlighted = false,
  title,
}: {
  id?: string;
  logo: ReactNode;
  name?: string;
  description?: string;
  status?: { tone: TileTone; text: ReactNode };
  action?: ReactNode;
  extra?: ReactNode;
  highlighted?: boolean;
  title?: string;
}) {
  return (
    <div
      id={id}
      title={title}
      className={`scroll-mt-24 flex flex-col gap-3 rounded-[16px] border bg-white px-4 py-3.5 transition-shadow ${
        highlighted
          ? "border-emerald-400 ring-2 ring-emerald-300/60"
          : "border-rule"
      }`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex h-6 items-center">{logo}</div>
        <p className="min-h-[18px] truncate text-[13px] leading-[18px] text-inkMuted">
          {description ?? ""}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        {status ? <TileState tone={status.tone} text={status.text} /> : <span />}
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      </div>
      {extra}
      {name ? <span className="sr-only">{name}</span> : null}
    </div>
  );
}

export type TileTone = "connected" | "idle" | "warning" | "danger";

const TONE_DOT: Record<TileTone, string> = {
  connected: "bg-[#167f50]",
  idle: "bg-[#bfbfbf]",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
};

const TONE_TEXT: Record<TileTone, string> = {
  connected: "text-[#167f50]",
  idle: "text-inkMuted",
  warning: "text-amber-700",
  danger: "text-rose-700",
};

export function TileState({ tone, text }: { tone: TileTone; text: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px] leading-[16px]">
      <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className={`min-w-0 truncate font-medium ${TONE_TEXT[tone]}`}>{text}</span>
    </div>
  );
}

export function TileButton({
  children,
  onClick,
  disabled,
  variant = "default",
  title,
  ariaExpanded,
  ariaControls,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "primary";
  title?: string;
  ariaExpanded?: boolean;
  ariaControls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      className={`inline-flex h-10 shrink-0 items-center justify-center rounded-cta border px-3.5 text-[16px] font-semibold leading-[20px] tracking-[0.01px] transition-colors disabled:opacity-50 ${FOCUS_RING} ${
        variant === "danger"
          ? "border-rose-200 bg-white text-rose-700 hover:border-rose-300 hover:bg-rose-50"
          : variant === "primary"
            ? "border-ink bg-ink text-white hover:bg-inkSoft"
            : "border-[#f0f0f0] bg-white text-[#1f1f1f] hover:border-[#e0e0e0] hover:bg-[#fafafa]"
      }`}
    >
      {children}
    </button>
  );
}

export function TileLogo({
  src,
  name,
  onError,
  failed,
}: {
  src?: string;
  name: string;
  onError?: () => void;
  failed?: boolean;
}) {
  if (!src || failed) {
    const initials =
      name
        .replace(/[^A-Za-z0-9 ]/g, "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("") || "?";
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f0f0f0] text-[11px] font-bold tracking-tight text-[#595959]">
          {initials}
        </span>
        <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
          {name}
        </span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      className="block h-6 w-auto max-w-[150px] object-contain object-left"
      onError={onError}
    />
  );
}

export function Banner({
  tone,
  title,
  children,
  onDismiss,
  className = "",
}: {
  tone: "error" | "warning" | "info";
  title?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const palette = {
    error: { box: "border-rose-200 bg-rose-50", title: "text-rose-800", body: "text-rose-700", icon: "text-rose-500" },
    warning: { box: "border-amber-200 bg-amber-50", title: "text-amber-800", body: "text-amber-700", icon: "text-amber-500" },
    info: { box: "border-[#cfe2ff] bg-[#f2f7ff]", title: "text-[#0b5cd6]", body: "text-[#2b6fd6]", icon: "text-[#027bff]" },
  }[tone];
  const glyph =
    tone === "error" ? (
      <path d="M12 8v5M12 16h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    ) : tone === "warning" ? (
      <path d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    ) : (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    );
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-[12px] border px-3.5 py-2.5 ${palette.box} ${className}`}
    >
      <svg
        className={`mt-[1px] h-[18px] w-[18px] shrink-0 ${palette.icon}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {glyph}
      </svg>
      <div className="min-w-0 flex-1 text-[13px] leading-[18px]">
        {title && <div className={`font-semibold ${palette.title}`}>{title}</div>}
        {children && <div className={`${title ? "mt-0.5 " : ""}font-medium ${palette.body}`}>{children}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`shrink-0 rounded-cta p-0.5 text-[16px] leading-none ${palette.icon} hover:opacity-70`}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ConnectorCollapseToggle({
  expanded,
  onToggle,
  label,
}: {
  expanded: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      title={expanded ? "Collapse" : "Expand"}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-[#1f1f1f] transition-colors hover:bg-[#fafafa]"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        className={`h-6 w-6 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
        aria-hidden
      >
        <path
          d="M17.4697 8.46942C17.7625 8.17653 18.2373 8.17653 18.5302 8.46942C18.8231 8.76232 18.8231 9.23708 18.5302 9.52997L12.5302 15.53C12.2373 15.8228 11.7625 15.8229 11.4697 15.53L5.46966 9.52997C5.17679 9.23708 5.17677 8.76231 5.46966 8.46942C5.76254 8.17656 6.23731 8.17656 6.5302 8.46942L11.9999 13.9392L17.4697 8.46942Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}

export function TileMenu({
  items,
  disabled,
  label,
}: {
  items: { label: string; onClick: () => void; danger?: boolean }[];
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label={label ? undefined : "More options"}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-cta border bg-white text-[16px] font-semibold text-[#1f1f1f] transition-colors disabled:opacity-50 ${FOCUS_RING} ${
          label ? "px-3.5" : "w-9"
        } ${
          open
            ? "border-[#e0e0e0] bg-[#fafafa]"
            : "border-[#f0f0f0] hover:border-[#e0e0e0] hover:bg-[#fafafa]"
        }`}
      >
        {label ? (
          <>
            {label}
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </>
        ) : (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        )}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[148px] overflow-hidden rounded-[12px] border border-[#f0f0f0] bg-white py-1 shadow-[0_8px_24px_-8px_rgba(25,25,25,0.18)]">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={`flex w-full items-center px-3.5 py-2 text-left text-[16px] font-medium transition-colors ${
                it.danger
                  ? "text-rose-700 hover:bg-rose-50"
                  : "text-[#1f1f1f] hover:bg-[#f6f6f6]"
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
