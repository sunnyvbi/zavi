"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

type DialogProps = {
  id: string;
  label: string;
  onClose: () => void | Promise<unknown>;
  busy?: boolean;
  className?: string;
  children: ReactNode;
};

const subscribeHost = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
};
const findHost = () => document.querySelector<HTMLElement>('.workspace-shell:not([role="dialog"])') ?? document.body;

export function Dialog(props: DialogProps) {
  const host = useSyncExternalStore(subscribeHost, findHost, () => null);
  return host ? createPortal(<DialogFrame {...props} />, host) : null;
}

function DialogFrame({ id, label, onClose, busy = false, className, children }: DialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy });
  useEffect(() => { latest.current = { onClose, busy }; }, [onClose, busy]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.contains(document.activeElement)) element.focus();
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || element.contains(target) || target.closest('[role="dialog"], [role="alertdialog"], dialog')) return;
      element.focus();
    };
    document.addEventListener("focusin", onFocus);
    return () => { document.removeEventListener("focusin", onFocus); opener?.focus(); };
  }, []);
  return <div id={id} ref={dialog} role="dialog" aria-modal="true" aria-label={label} aria-busy={busy || undefined} tabIndex={-1}
    className={cn("fixed inset-0 z-50 outline-none", className)}
    onKeyDown={(event) => {
      const element = dialog.current;
      const target = event.target;
      if (!element || event.defaultPrevented || !(target instanceof Element) || target.closest('[role="dialog"], [role="alertdialog"], dialog') !== element) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy && !element.querySelector('[aria-busy="true"]')) void latest.current.onClose();
      }
      if (event.key !== "Tab") return;
      const focusable = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((node) => node.getClientRects().length > 0 && !node.closest("[hidden]"));
      const next = event.shiftKey ? focusable.at(-1) : focusable[0];
      if (!focusable.length || (event.shiftKey && document.activeElement === focusable[0]) || (!event.shiftKey && document.activeElement === focusable.at(-1)) || document.activeElement === element) {
        event.preventDefault();
        (next ?? element).focus();
      }
    }}>
    {children}
  </div>;
}
