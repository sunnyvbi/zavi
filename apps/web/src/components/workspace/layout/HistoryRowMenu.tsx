"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal, PenLine, Trash2 } from "lucide-react";
import { cx, FOCUS_RING } from "./shared";

const GAP = 4;
const EDGE = 8;

const MENU_ITEM =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors duration-100 hover:bg-creamDeep motion-reduce:transition-none";

export function HistoryRowMenu({
  onRename,
  onDelete,
}: {
  onRename: () => void;
  onDelete: () => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) {
      setPlace(null);
      return;
    }
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    const below = anchor.bottom + GAP;
    const top =
      below + height > window.innerHeight - EDGE ? Math.max(EDGE, anchor.top - GAP - height) : below;
    const left = Math.min(Math.max(EDGE, anchor.left), window.innerWidth - width - EDGE);
    setPlace({ top, left });
  }, [anchor]);

  useEffect(() => {
    if (!open) return;
    const close = () => setAnchor(null);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  useEffect(() => {
    if (place) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [place]);

  const toggle = () => {
    if (open) {
      setAnchor(null);
      return;
    }
    setAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
  };

  const pick = (action: () => void) => {
    setAnchor(null);
    action();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        onClick={toggle}
        className={cx(
          "absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center text-inkLight transition-[opacity,color] hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none",
          open ? "opacity-100" : "opacity-0",
          FOCUS_RING,
        )}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More options"
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
          className="fixed z-50 w-40 rounded-xl border border-rule bg-cream p-1.5 shadow-elev"
        >
          <button type="button" role="menuitem" onClick={() => pick(onRename)} className={cx(MENU_ITEM, "text-ink", FOCUS_RING)}>
            <PenLine className="h-4 w-4 text-inkLight" aria-hidden />
            Rename
          </button>
          <button type="button" role="menuitem" onClick={() => pick(onDelete)} className={cx(MENU_ITEM, "text-danger", FOCUS_RING)}>
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete
          </button>
        </div>
      )}
    </>
  );
}
