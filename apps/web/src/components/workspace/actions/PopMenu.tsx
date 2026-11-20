"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActionTooltip } from "./ActionTooltip";
import { ActionHelpReset } from "./ActionHelp";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

const MENU_HEIGHT = 260;
const EDGE = 8;

type MenuPos = { right: number; top?: number; bottom?: number; maxHeight: number };

export type PopMenuItem = {
  label: string;
  hint?: string;
  tooltip?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  submenu?: { heading?: string; items: PopMenuItem[] };
};

export function PopMenu({
  items,
  trigger,
  heading,
  width = "w-56",
  label = "More actions",
  className = "",
  disabled,
  description,
  tooltipClassName,
  menuClassName,
  panel,
  anchor,
  placement,
  height = MENU_HEIGHT,
}: {
  items: PopMenuItem[];
  trigger: (open: boolean) => ReactNode;
  heading?: string;
  width?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  description?: string;
  tooltipClassName?: string;
  menuClassName?: string;
  panel?: (close: () => void) => ReactNode;
  anchor?: (button: HTMLElement) => Element | null;
  placement?: "below";
  height?: number;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [sub, setSub] = useState<{ heading?: string; items: PopMenuItem[] } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    setSub(null);
    if (pos || !r) return setPos(null);
    const right = window.innerWidth - ((buttonRef.current && anchor?.(buttonRef.current)?.getBoundingClientRect()) || r).right;
    const above = r.top - 8 - EDGE;
    const below = window.innerHeight - r.bottom - 8 - EDGE;
    const up = placement === "below" ? below < height && above > below : r.top > height || above > below;
    setPos(
      up
        ? { right, bottom: window.innerHeight - r.top + 8, maxHeight: Math.max(0, above) }
        : { right, top: r.bottom + 8, maxHeight: Math.max(0, below) },
    );
  };

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!pos || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const { left } = rect;
    if (left >= EDGE - 0.5) return;
    setPos((p) => {
      if (!p) return p;
      const right = Math.max(EDGE, p.right - (EDGE - left));
      return right === p.right ? p : { ...p, right };
    });
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const close = () => {
      setPos(null);
      setSub(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    const typing = () => !!panel && !!menuRef.current?.contains(document.activeElement);
    const onResize = () => {
      if (!typing()) close();
    };
    window.addEventListener("resize", onResize);
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && menuRef.current?.contains(t)) return;
      if (typing()) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pos]);

  const host = buttonRef.current?.closest<HTMLElement>(".workspace-shell") ?? (typeof document !== "undefined" ? document.body : null);

  const control = (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-haspopup={panel ? "dialog" : "menu"}
      aria-expanded={!!pos}
      disabled={disabled}
      onClick={toggle}
      className={className}
    >
      {trigger(!!pos)}
    </button>
  );
  return (
    <>
      {description ? <ActionTooltip description={description} label={label} className={tooltipClassName}>{control}</ActionTooltip> : control}
      {pos &&
        host &&
        createPortal(
          <ActionHelpReset>
          <div ref={menuRef} role={panel ? "dialog" : "menu"} aria-label={panel ? label : undefined} style={{ ...pos, maxWidth: `calc(100vw - ${EDGE * 2}px)` }} className={cn("fixed z-50 overflow-y-auto overscroll-contain rounded-2xl border", panel ? "border-ca-border bg-ca-bg p-3 shadow-ca-xl" : "border-rule bg-cream p-2 shadow-pop", width, menuClassName)}>
            {panel?.(() => setPos(null))}
            {!panel && (sub ? sub.heading : heading) && <p className="px-3 py-2 text-[14px] text-inkMuted">{sub ? sub.heading : heading}</p>}
            {!panel && (sub?.items ?? items).map((it) => {
              const item = (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    if (it.submenu) return setSub(it.submenu);
                    setPos(null);
                    setSub(null);
                    it.onSelect?.();
                  }}
                  className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-creamDeep disabled:opacity-50"
                >
                  {it.icon && <span className="mt-0.5 shrink-0 text-inkMuted">{it.icon}</span>}
                  <span className="min-w-0">
                    <span className="block text-[16px] text-ink">{it.label}</span>
                    {it.hint && <span className="block text-[14px] text-inkMuted">{it.hint}</span>}
                  </span>
                </button>
              );
              return it.tooltip ? <ActionTooltip key={it.label} description={it.tooltip} label={it.label} className="w-full">{item}</ActionTooltip> : item;
            })}
          </div>
          </ActionHelpReset>,
          host,
        )}
    </>
  );
}
