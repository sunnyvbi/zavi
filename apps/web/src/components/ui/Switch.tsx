import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-checked" | "onChange" | "onClick" | "role"
> & {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
};

export function Switch({
  checked,
  className,
  disabled,
  label,
  onCheckedChange,
  type = "button",
  ...props
}: SwitchProps) {
  return (
    <button
      {...props}
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-ink" : "bg-ink/20",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0.5 size-5 rounded-full bg-cream shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
