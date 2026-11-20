"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { usePathname } from "next/navigation";

const OPEN_EVENT = "zavi:menu-open";

let nextId = 0;

export function useDismissableMenu<T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<T | null>,
  triggerRef?: RefObject<HTMLElement | null>,
) {
  const [open, setOpen] = useState(false);
  const idRef = useRef(++nextId);
  const pathname = usePathname();

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) triggerRef?.current?.focus();
    },
    [triggerRef],
  );

  const toggle = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: idRef.current }));
    const onOther = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== idRef.current) setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") setOpen(false);
    };
    window.addEventListener(OPEN_EVENT, onOther);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOther);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, containerRef, close]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return { open, setOpen, toggle, close };
}
