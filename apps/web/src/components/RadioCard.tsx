"use client";

import { cn } from "@/lib/cn";

export type RadioCardProps = {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
  icon?: React.ReactNode;
};

export function RadioCard({
  name,
  value,
  checked,
  onSelect,
  label,
  description,
  disabled,
  className,
  icon,
}: RadioCardProps) {
  return (
    <label
      className={cn(
        "group flex w-full cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3.5 transition-[background-color,border-color,box-shadow,transform] duration-200",
        checked
          ? "border-ink/25 bg-bone/60 shadow-[inset_0_0_0_1px_rgb(var(--c-ink)/0.04),0_1px_2px_rgb(var(--c-ink)/0.03)]"
          : "border-rule bg-transparent shadow-none hover:-translate-y-px hover:border-ink/20 hover:bg-bone/25 hover:shadow-sm",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="relative mt-0.5 block size-6 shrink-0">
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={() => onSelect(value)}
          onClick={() => {
            if (checked && !disabled) onSelect(value);
          }}
          disabled={disabled}
          className="peer sr-only"
        />
        {}
        <span
          className={cn(
            "absolute left-0.5 top-0.5 block size-5 rounded-full border-2 transition-[border-color,background-color,box-shadow] duration-200",
            checked
              ? "border-ink bg-transparent shadow-none"
              : "border-inkLight bg-transparent",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ink/25",
          )}
        />
        {}
        {checked && (
          <span className="team-radio-dot absolute left-[7px] top-[7px] block size-2.5 rounded-full bg-ink" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[14px] font-semibold leading-5 text-ink">
          {label}
        </span>
        {description && (
          <span className="text-[14px] leading-5 text-inkMuted">
            {description}
          </span>
        )}
      </span>
      {icon && (
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-bone text-ink">
          {icon}
        </span>
      )}
    </label>
  );
}
