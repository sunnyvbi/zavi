"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx, FOCUS_RING } from "@/components/workspace/layout/shared";

export function MobileIconButton({
  label,
  onClick,
  children,
  className,
  ...rest
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        "flex h-12 w-12 items-center justify-center rounded-full text-ink",
        "bg-transparent",
        "active:opacity-50",
        FOCUS_RING,
        className,
      )}
      {...rest}
    >
      <span data-mobile-icon-ring="" className="flex h-10 w-10 items-center justify-center rounded-full border border-rule">
        {children}
      </span>
    </button>
  );
}
