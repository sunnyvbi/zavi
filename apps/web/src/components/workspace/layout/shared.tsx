"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Plug } from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import type { TabDescriptor, TabKind } from "@/lib/workspace/types";
import { guardLeave } from "@/lib/workspace/unappliedEdits";

export type StaticKind = Extract<
  TabKind,
  | "home"
  | "onboarding"
  | "brain"
  | "settings"
  | "members"
  | "autopilot"
  | "competitor"
  | "website"
  | "analytics"
  | "channels"
  | "needs-you"
  | "messaging"
  | "meet"
  | "memory"
  | "calendar"
  | "artifacts"
  | "fundraising"
  | "supply-demand"
  | "engineer"
  | "agent-builder"
>;

export const CGO_LABEL = "Your CGO";

export const STATIC_TITLES: Record<StaticKind, string> = {
  home: "360 View",
  onboarding: "Onboarding",
  brain: "Connectors",
  settings: "Settings",
  members: "Members",
  autopilot: CGO_LABEL,
  competitor: "Competitor Intel",
  website: "Your Website",
  analytics: "Analytics",
  channels: "Growth Channels",
  "needs-you": "Needs you",
  messaging: "Messaging",
  meet: "Meet",
  memory: "Memory",
  calendar: "Calendar",
  artifacts: "Artifacts",
  fundraising: "Fundraising",
  "supply-demand": "Supply & Demand",
  engineer: "Engineer",
  "agent-builder": "Agent Builder",
};

export function useOpenStatic() {
  const { openTab } = useWorkspace();
  return useCallback(
    (kind: StaticKind, extra?: Record<string, unknown>) =>
      guardLeave(() =>
        openTab({
          kind,
          title: STATIC_TITLES[kind],
          payload: { kind, ...extra } as TabDescriptor["payload"],
          dirty: false,
          pinned: kind === "home",
        }),
      ),
    [openTab],
  );
}

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

export const PANEL_HEADER_BOX = "h-20 shrink-0 items-center gap-2 px-2 pt-2";

export const PANEL_HEADER_TITLE =
  "min-w-0 truncate text-[16px] font-semibold leading-5 text-ink";

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";

export const MESSAGE_ACTION_BUTTON =
  "inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:cursor-default";

export const MESSAGE_ACTION_ICON = { size: 16, strokeWidth: 1.75 } as const;

export const FAB_CLEARANCE = "compact:pb-[calc(6rem+env(safe-area-inset-bottom,0px))]";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useModalFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  blocked = false,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnFocusTo = document.activeElement as HTMLElement | null;
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ??
          [],
      ).filter((element) => element.getClientRects().length > 0);
    const initial =
      initialFocusRef?.current ?? getFocusable()[0] ?? dialogRef.current;
    initial?.focus();

    const rendered = (element: HTMLElement) => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        if (node.hidden || window.getComputedStyle(node).display === "none") return false;
      }
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!dialogRef.current || !rendered(dialogRef.current)) return;
      const target = event.target;
      const owner =
        target instanceof Element ? target.closest('[role="dialog"]') : null;
      if (
        owner &&
        !owner.contains(dialogRef.current) &&
        !dialogRef.current.contains(owner)
      )
        return;
      if (event.key === "Escape") {
        if (!blockedRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeInside = dialogRef.current.contains(document.activeElement);
      if (
        event.shiftKey &&
        (document.activeElement === first || !activeInside)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !activeInside)
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusTo?.focus();
    };
  }, [dialogRef, initialFocusRef]);
}

export function IconButton({
  label,
  onClick,
  active = false,
  className,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={cx(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-ink transition-colors duration-150 hover:bg-bone active:bg-ink/10 motion-reduce:transition-none",
        FOCUS_RING,
        active && "bg-bone",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted">
      {children}
    </span>
  );
}

export function ChannelEmpty({
  label,
  title,
  description,
  cta,
}: {
  label: string;
  title?: string;
  description?: string;
  cta?: string;
}) {
  return (
    <div className="relative h-full overflow-hidden px-4 py-4">
      <div
        aria-hidden
        className="pointer-events-none select-none space-y-3 opacity-[0.3] blur-[3px]"
      >
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl bg-creamDeep p-4">
              <div className="h-3 w-16 rounded bg-ink/15" />
              <div className="mt-2 h-6 w-20 rounded bg-ink/25" />
            </div>
          ))}
        </div>
        <div className="flex items-end gap-2 rounded-2xl bg-creamDeep p-4">
          {[42, 68, 35, 80, 55, 74, 48, 62, 90, 58].map((h, i) => (
            <span
              key={i}
              style={{ height: h }}
              className="w-full rounded-sm bg-ink/20"
            />
          ))}
        </div>
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-cream/50 px-6 text-center backdrop-blur-[1px]">
        <p className="text-[14px] font-semibold text-ink">
          {title ?? `${label} isn't connected yet`}
        </p>
        <p className="max-w-[280px] text-[13px] leading-[1.5] text-inkMuted">
          {description ??
            "Connect the source and this fills in with your own numbers."}
        </p>
        <ChannelConnectCta label={cta} />
      </div>
    </div>
  );
}

function ChannelConnectCta({ label }: { label?: string }) {
  const openStatic = useOpenStatic();
  return (
    <button
      type="button"
      onClick={() => {
        window.history.replaceState(null, "", "#integrations");
        openStatic("brain");
      }}
      className={cx(
        "mt-1 inline-flex h-8 items-center gap-2 rounded-cta bg-ink px-3 text-[13px] font-semibold text-cream transition-opacity hover:opacity-90",
        FOCUS_RING,
      )}
    >
      <Plug className="h-3.5 w-3.5" aria-hidden />
      {label ?? "Connect"}
    </button>
  );
}

const TITLE_SCROLL_PX_PER_SEC = 30;
const TITLE_SCROLL_MIN_SEC = 1.5;

export function HoverScrollTitle({ text, className }: { text: string; className?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [scrollSec, setScrollSec] = useState(TITLE_SCROLL_MIN_SEC);

  useEffect(() => {
    const box = boxRef.current;
    const label = labelRef.current;
    if (!box || !label) return;
    const measure = () => {
      const overflow = Math.max(0, label.scrollWidth - box.clientWidth);
      setScrollSec(Math.max(TITLE_SCROLL_MIN_SEC, overflow / TITLE_SCROLL_PX_PER_SEC));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    return () => observer?.disconnect();
  }, [text]);

  return (
    <span ref={boxRef} className={cx("min-w-0 flex-1 overflow-hidden [container-type:inline-size]", className)}>
      <span
        ref={labelRef}
        style={{ "--title-scroll": `${scrollSec}s` } as CSSProperties}
        className="inline-block max-w-full truncate align-top transition-transform duration-300 ease-out group-hover:max-w-none group-hover:translate-x-[min(0px,calc(100cqw-100%))] group-hover:overflow-visible group-hover:delay-500 group-hover:duration-[var(--title-scroll)] group-hover:ease-in-out motion-reduce:transition-none"
      >
        {text}
      </span>
    </span>
  );
}
