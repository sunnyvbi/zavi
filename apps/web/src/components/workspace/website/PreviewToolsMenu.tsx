"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Portal } from "@/components/ui/Portal";
import { Check, Ellipsis, EyeOff, Keyboard, Minimize2, PanelBottom } from "lucide-react";
import { PREVIEW_SHORTCUTS, isMacPlatform, shortcutLabel, type PreviewToolsPrefs, type ToolsPlacement } from "./previewTools";

const PLACEMENT_ITEMS: ReadonlyArray<{ value: ToolsPlacement; label: string; icon: typeof PanelBottom }> = [
  { value: "dock", label: "Dock", icon: PanelBottom },
  { value: "minimized", label: "Minimize", icon: Minimize2 },
  { value: "hidden", label: "Hide", icon: EyeOff },
];

export function PreviewToolsMenu({
  prefs,
  onPlacement,
  onShortcuts,
  frameRef,
}: {
  prefs: PreviewToolsPrefs;
  onPlacement: (placement: ToolsPlacement) => void;
  onShortcuts: (on: boolean) => void;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [isMac, setIsMac] = useState(true);
  const [place, setPlace] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => setIsMac(isMacPlatform()), []);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 12;
    setPlace({
      right: Math.max(8, window.innerWidth - rect.right),
      bottom: window.innerHeight - rect.top + gap,
      maxHeight: Math.max(160, rect.top - gap - 8),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onBlur = () => {
      if (frameRef?.current && document.activeElement === frameRef.current) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [open, frameRef]);

  const attachMenu = useCallback((el: HTMLDivElement | null) => {
    menuRef.current = el;
    if (!el) return;
    const current = el.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
    (current ?? el.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
  }, []);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-label="More preview tools"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${
          open ? "bg-ink text-cream" : "text-ink hover:bg-bone"
        }`}
      >
        <Ellipsis className="h-4 w-4" aria-hidden />
      </button>
      {open && place && (
        <Portal>
        <div
          ref={attachMenu}
          id={menuId}
          role="menu"
          aria-label="Preview tools options"
          onKeyDown={onMenuKeyDown}
          style={{ right: place.right, bottom: place.bottom, maxHeight: place.maxHeight }}
          className="workspace-shell fixed z-50 w-[248px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-2xl border border-rule bg-cream p-1.5 text-[13px] text-ink shadow-pop animate-pane-fade motion-reduce:animate-none"
        >
          <div role="group" aria-label="Tools position">
            {PLACEMENT_ITEMS.map(({ value, label, icon: Icon }) => {
              const checked = prefs.placement === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  tabIndex={-1}
                  onClick={() => {
                    onPlacement(value);
                    close(value === "dock");
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-bone focus-visible:bg-bone focus-visible:outline-none"
                >
                  <Icon className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
                  <span className="flex-1">{label}</span>
                  {checked && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>
          <div role="separator" className="-mx-1.5 my-1.5 h-px bg-rule" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.shortcuts}
            tabIndex={-1}
            onClick={() => onShortcuts(!prefs.shortcuts)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-bone focus-visible:bg-bone focus-visible:outline-none"
          >
            <Keyboard className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
            <span className="flex-1">Keyboard shortcuts</span>
            <span
              aria-hidden
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                prefs.shortcuts ? "bg-ink" : "bg-ink/20"
              }`}
            >
              <span
                className={`absolute left-0.5 h-4 w-4 rounded-full bg-cream shadow-sm transition-transform motion-reduce:transition-none ${
                  prefs.shortcuts ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </span>
          </button>
          {prefs.shortcuts && (
            <ul aria-label="Shortcuts" className="px-2.5 pb-1 pt-0.5">
              {PREVIEW_SHORTCUTS.map((s) => (
                <li key={s.action} className="flex items-center justify-between gap-3 py-1 text-[12px] text-inkMuted">
                  <span>{s.label}</span>
                  <kbd className="rounded-md border border-rule bg-bone px-1.5 py-px font-sans text-[11px] font-medium text-ink">
                    {shortcutLabel(isMac, s.keys)}
                  </kbd>
                </li>
              ))}
            </ul>
          )}
        </div>
        </Portal>
      )}
    </div>
  );
}
