"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaRole,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { useCardHelp, useTouch } from "./ActionHelp";

type Control = {
  "aria-describedby"?: string;
  "aria-label"?: string;
  disabled?: boolean;
  role?: AriaRole;
  children?: ReactNode;
  title?: string;
};

export function ActionTooltip({
  children,
  description,
  label,
  className = "",
  placement = "above",
}: {
  children: ReactElement<Control>;
  description: string;
  label: string;
  className?: string;
  placement?: "above" | "below";
}) {
  const id = useId();
  const touch = useTouch();
  const inCard = useCardHelp(label, description);
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const info = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const clear = useCallback(() => clearTimeout(timer.current), []);
  const hide = useCallback(() => {
    clear();
    setOpen(false);
    setPosition(null);
  }, [clear]);
  const show = () => {
    clear();
    setOpen(true);
  };
  const leave = () => {
    clear();
    if (anchor.current?.contains(document.activeElement)) return;
    timer.current = setTimeout(hide, 150);
  };

  useEffect(() => clear, [clear]);
  useEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect(),
      b = bubble.current.getBoundingClientRect();
    const edge = 8;
    const menu =
      children.props.role === "menuitem"
        ? anchor.current.closest<HTMLElement>('[role="menu"]')
        : null;
    if (menu) {
      const m = menu.getBoundingClientRect();
      const fitsRight = m.right + edge + b.width + edge <= window.innerWidth;
      const fitsLeft = m.left - edge - b.width >= edge;
      const fitsBelow = m.bottom + edge + b.height + edge <= window.innerHeight;
      const clampTop = (t: number) =>
        Math.max(edge, Math.min(t, window.innerHeight - b.height - edge));
      const clampLeft = (l: number) =>
        Math.max(edge, Math.min(l, window.innerWidth - b.width - edge));
      if (fitsRight || fitsLeft) {
        setPosition({
          left: fitsRight ? m.right + edge : m.left - edge - b.width,
          top: clampTop(a.top),
        });
      } else {
        setPosition({
          left: clampLeft(m.left),
          top: fitsBelow ? m.bottom + edge : clampTop(m.top - b.height - edge),
        });
      }
    } else {
      const above = placement === "below" ? -Infinity : a.top - b.height - edge;
      setPosition({
        left: Math.max(
          edge,
          Math.min(
            a.left + (a.width - b.width) / 2,
            window.innerWidth - b.width - edge,
          ),
        ),
        top: Math.max(
          edge,
          Math.min(
            above >= edge ? above : a.bottom + edge,
            window.innerHeight - b.height - edge,
          ),
        ),
      });
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
      }
    };
    const outside = (e: PointerEvent) => {
      if (
        !anchor.current?.contains(e.target as Node) &&
        !bubble.current?.contains(e.target as Node)
      )
        hide();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    const scroll = (e: Event) => {
      if (!(e.target instanceof Node) || !bubble.current?.contains(e.target))
        hide();
    };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, description, hide, placement]);

  return (
    <span
      ref={anchor}
      tabIndex={children.props.disabled ? 0 : undefined}
      role={children.props.disabled ? "group" : undefined}
      aria-label={children.props.disabled ? `About ${label}` : undefined}
      aria-describedby={children.props.disabled ? id : undefined}
      className={`inline-flex min-w-0 items-center ${className}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") show();
      }}
      onPointerLeave={leave}
      onClickCapture={(e) => {
        if (!info.current?.contains(e.target as Node)) hide();
      }}
      onFocusCapture={(e) => {
        if (e.target !== info.current) show();
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) hide();
      }}
    >
      {cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], id]
          .filter(Boolean)
          .join(" "),
        title: undefined,
      })}
      {touch && !inCard && (
        <button
          ref={info}
          type="button"
          role={children.props.role === "menuitem" ? "menuitem" : undefined}
          aria-label={`About ${label}`}
          aria-expanded={open}
          aria-describedby={id}
          className="ml-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-inkMuted hover:bg-creamDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inkMuted"
          onClick={() => (open ? hide() : show())}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      )}
      {!open && (
        <span id={id} className="sr-only">
          {description}
        </span>
      )}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            ref={bubble}
            id={id}
            role="tooltip"
            onMouseEnter={show}
            onMouseLeave={leave}
            style={{
              position: "fixed",
              left: position?.left ?? 8,
              top: position?.top ?? 8,
              visibility: position ? "visible" : "hidden",
            }}
            className={`${children.props.role === "menuitem" ? "pointer-events-none " : ""}z-[9999] w-max max-w-[min(340px,calc(100vw-16px))] max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain whitespace-normal break-words rounded-xl border border-rule bg-cream px-3 py-2 text-left text-[13px] font-normal leading-5 text-ink shadow-pop`}
          >
            {description}
          </span>,
          anchor.current?.closest(".workspace-shell") ?? document.body,
        )}
    </span>
  );
}

export function explainControl(
  control: ReactNode,
  description: string,
  label: string,
): ReactNode {
  return isValidElement<Control>(control) ? (
    <ActionTooltip description={description} label={label}>
      {control}
    </ActionTooltip>
  ) : (
    control
  );
}
