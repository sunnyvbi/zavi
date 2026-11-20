"use client";

import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from "react";

export function FormPanel({
  children,
  onSubmit,
  className = "",
}: {
  children: ReactNode;
  onSubmit?: (e: React.FormEvent) => void;
  className?: string;
}) {
  const cls = `mt-3 w-full rounded-[16px] border border-[#f0f0f0] bg-white p-4 ${className}`;
  if (onSubmit) {
    return (
      <form onSubmit={onSubmit} className={cls}>
        {children}
      </form>
    );
  }
  return <div className={cls}>{children}</div>;
}

export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[14px] font-medium leading-5 text-[#595959]">
        {label}
      </span>
      {children}
      {hint && <span className="text-[12px] leading-[16px] text-[#8a8a8a]">{hint}</span>}
    </label>
  );
}

const inputBase =
  "h-10 w-full rounded-[10px] border border-[#f0f0f0] bg-white px-3 text-[16px] font-medium leading-[20px] text-[#1f1f1f] outline-none transition-colors placeholder:text-[#bfbfbf] focus:border-ink/40 focus:ring-2 focus:ring-ink/10 disabled:opacity-60";

export function FormInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${inputBase} ${className}`} />;
}

export function FormSelect({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...rest}
        className={`${inputBase} appearance-none pr-9 ${className}`}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#595959]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

export function FormSecretInput({
  show,
  onToggle,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <FormInput
        {...rest}
        data-replay-mask=""
        type={show ? "text" : "password"}
        className={`flex-1 ${className}`}
      />
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex h-10 shrink-0 items-center rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#595959] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa]"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function FormNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[#f0f0f0] bg-[#f9f9f9] px-3 py-2.5 text-[13px] leading-[17px] text-[#595959]">
      {children}
    </div>
  );
}

export function FormPrimaryButton({
  children,
  disabled,
  type = "submit",
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-10 items-center justify-center rounded-cta bg-[#1f1f1f] px-4 text-[16px] font-semibold leading-[20px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function FormSecondaryButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-10 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50"
    >
      {children}
    </button>
  );
}
