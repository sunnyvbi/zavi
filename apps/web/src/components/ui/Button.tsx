import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const DEFAULT_SIZE = "h-10 px-4";
const CALLER_SIZE = /(?:^|\s)(?:[\w-]+:)*!?(?:h|size|p|px|py)-/;

export type ButtonVariant = "primary" | "secondary";

export function buttonClassName(variant: ButtonVariant, className?: string): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-cta border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-not-allowed disabled:opacity-50",
    variant === "primary" ? "border-ink bg-ink text-cream hover:bg-inkSoft" : "border-rule bg-cream text-ink hover:bg-creamDeep",
    !CALLER_SIZE.test(className ?? "") && DEFAULT_SIZE,
    className,
  );
}

export function Button({
  className,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClassName(variant, className)} {...props} />;
}
