"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Blocks, ListChecks, Target, X } from "lucide-react";
import type { TabDescriptor } from "@/lib/workspace/types";
import { WorkspacePane } from "../WorkspacePane";
import { cx, FOCUS_RING } from "./shared";

export function WorkspaceDrawer({
  tab,
  onClose,
}: {
  tab: TabDescriptor;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const outerFrameRef = useRef(0);
  const innerFrameRef = useRef(0);
  const openedRef = useRef(false);
  const closingRef = useRef(false);
  const closedRef = useRef(false);
  const [open, setOpen] = useState(false);
  onCloseRef.current = onClose;
  const isGrowth = tab.kind === "autopilot";
  const isOnboarding = tab.kind === "onboarding";
  const title = isGrowth ? "Growth" : isOnboarding ? "Onboarding" : "Connectors";

  const finishClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }, []);

  const beginClose = useCallback(() => {
    closingRef.current = true;
    cancelAnimationFrame(outerFrameRef.current);
    cancelAnimationFrame(innerFrameRef.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishClose();
      return;
    }
    if (!openedRef.current) {
      finishClose();
      return;
    }
    setOpen(false);
  }, [finishClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    outerFrameRef.current = requestAnimationFrame(() => {
      innerFrameRef.current = requestAnimationFrame(() => {
        if (closingRef.current) return;
        openedRef.current = true;
        setOpen(true);
      });
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") beginClose();
      if (event.key !== "Tab") return;

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(outerFrameRef.current);
      cancelAnimationFrame(innerFrameRef.current);
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [beginClose]);

  return (
    <div
      className={cx(
        "fixed inset-0 z-[130] flex justify-end bg-black/40 transition-opacity ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        open ? "opacity-100 duration-[380ms]" : "opacity-0 duration-[260ms]",
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) beginClose();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-drawer-title"
        onTransitionEnd={(event) => {
          if (!open && event.target === event.currentTarget) {
            finishClose();
          }
        }}
        className={cx(
          "transform-gpu will-change-transform flex h-full w-full flex-col overflow-hidden rounded-l-[28px] border-l border-rule bg-cream shadow-[-24px_0_70px_rgba(0,0,0,0.22)] transition-transform ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none sm:max-w-[680px]",
          open ? "translate-x-0 duration-[380ms]" : "translate-x-full duration-[260ms]",
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-rule px-4 sm:px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-cream">
            {isGrowth ? (
              <Target className="h-4 w-4" aria-hidden />
            ) : isOnboarding ? (
              <ListChecks className="h-4 w-4" aria-hidden />
            ) : (
              <Blocks className="h-4 w-4" aria-hidden />
            )}
          </span>
          <h1
            id="workspace-drawer-title"
            className="min-w-0 flex-1 text-[16px] font-semibold text-ink"
          >
            {title}
          </h1>
          <button
            ref={closeRef}
            type="button"
            onClick={beginClose}
            aria-label={`Close ${title}`}
            className={cx(
              "inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkMuted transition-colors hover:bg-bone hover:text-ink",
              FOCUS_RING,
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkspacePane activeTabIdOverride={tab.id} />
        </div>
      </section>
    </div>
  );
}
