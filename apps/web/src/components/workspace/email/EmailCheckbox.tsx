"use client";

import { Check } from "lucide-react";
import type { InputHTMLAttributes } from "react";

export const EMAIL_CHECKBOX =
  "peer block h-4 w-4 cursor-pointer appearance-none rounded-[4px] border border-rule bg-transparent transition-colors hover:border-ink/50 checked:border-ink checked:bg-ink checked:hover:border-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-rule focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";

export function EmailCheckbox({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & { className?: string }) {
  return (
    <span className={`relative inline-flex h-4 w-4 shrink-0 ${className}`}>
      <input type="checkbox" className={EMAIL_CHECKBOX} {...props} />
      <Check
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-cream opacity-0 peer-checked:opacity-100 peer-checked:peer-disabled:opacity-40"
      />
    </span>
  );
}
