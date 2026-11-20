"use client";

import type { InputHTMLAttributes } from "react";

export function amountAffixes(unit: string | null, prefix: string | undefined, suffix: string | undefined): { prefix?: string; suffix?: string } {
  return {
    prefix: unit === "USD" ? "US$" : prefix,
    suffix: suffix && /year one/i.test(suffix) ? "/ year one" : suffix,
  };
}

export function AmountInput({
  prefix,
  suffix,
  invalid,
  className,
  ...input
}: { prefix?: string; suffix?: string; invalid?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "prefix">) {
  return (
    <div
      data-testid="amount-input"
      className={`flex h-11 w-full max-w-sm items-center rounded-[10px] border bg-white px-3 transition-colors focus-within:border-ink/40 ${invalid ? "border-danger/60" : "border-rule"} ${input.disabled ? "opacity-60" : ""} ${className ?? ""}`}
    >
      {prefix && <span className="mr-1.5 shrink-0 text-[15px] text-inkMuted">{prefix}</span>}
      <input
        type="text"
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        {...input}
        className="h-full min-w-0 flex-1 bg-transparent text-[16px] leading-5 text-ink outline-none placeholder:text-inkLight disabled:cursor-not-allowed sm:text-[15px]"
      />
      {suffix && <span className="ml-2 shrink-0 text-[13px] text-inkMuted">{suffix}</span>}
    </div>
  );
}
