"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const inputBase =
  "w-full rounded-lg border border-[#e5e5e5] bg-white px-3 py-2.5 text-[14px] tracking-[-0.15px] transition-colors placeholder:text-[#a1a1a1] focus:border-[#171717] focus:outline-none focus:ring-4 focus:ring-[#171717]/10 disabled:opacity-60";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  unstyled?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, unstyled, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(!unstyled && inputBase, className)}
        {...props}
      />
    );
  },
);

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  unstyled?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, unstyled, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(!unstyled && inputBase, className)}
        {...props}
      />
    );
  },
);
