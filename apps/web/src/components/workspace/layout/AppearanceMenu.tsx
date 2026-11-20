"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Monitor, Moon, Sun, SunMoon } from "lucide-react";
import { cx } from "./shared";
import type { Theme } from "./WorkspaceLayout";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
] as const;

export function AppearanceMenu({
  theme,
  onSetTheme,
  menuItemClassName,
}: {
  theme: Theme;
  onSetTheme: (next: Theme) => void;
  menuItemClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openMenu = () => {
    cancelClose();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 128;
    const gap = 16;
    const rightSide = rect.right + gap;
    const left =
      rightSide + menuWidth <= window.innerWidth - 8
        ? rightSide
        : Math.max(8, rect.left - menuWidth - gap);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 140));
    setPosition({ left, top });
    setOpen(true);
  };

  const closeMenu = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  return (
    <div
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={closeMenu}
      onFocusCapture={openMenu}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={menuItemClassName}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <SunMoon className="h-4 w-4 text-inkMuted" aria-hidden />
        <span className="flex-1">Appearance</span>
        <ChevronRight className="h-4 w-4 text-inkMuted" aria-hidden />
      </button>

      {open && position && createPortal(
        <div
          data-account-menu-portal
          className="workspace-shell fixed z-50"
          style={{ left: position.left, top: position.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={closeMenu}
          onFocusCapture={cancelClose}
          onBlurCapture={closeMenu}
        >
          <div
            role="menu"
            aria-label="Appearance"
            className="flex w-32 flex-col gap-2 rounded-xl border border-rule bg-cream p-1.5 shadow-pop"
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={theme === value}
                className={cx(menuItemClassName, theme === value && "bg-creamDeep")}
                onClick={() => onSetTheme(value)}
              >
                <Icon className="h-4 w-4 text-inkMuted" aria-hidden />
                <span className="flex-1">{label}</span>
                {theme === value && <span aria-hidden className="h-2 w-2 rounded-full bg-ink" />}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
