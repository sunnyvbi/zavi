"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { cardText } from "./styles";

export function CardTitle({ title }: { title: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, []);
  useEffect(() => {
    if (open) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [title, open, measure]);
  const toggles = clamped || open;
  const toggle = () => setOpen((v) => !v);
  return (
    <h4 className={cardText.titleType} title={open ? undefined : title}>
      <span
        ref={ref}
        data-card-title
        onPointerEnter={open ? undefined : measure}
        {...(toggles && {
          role: "button",
          tabIndex: 0,
          "aria-expanded": open,
          onClick: toggle,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            toggle();
          },
        })}
        className={cn(!open && cardText.titleClamp, toggles && "cursor-pointer rounded-sm focus-visible:shadow-ca-focus focus-visible:outline-none")}
      >
        {title}
      </span>
    </h4>
  );
}
