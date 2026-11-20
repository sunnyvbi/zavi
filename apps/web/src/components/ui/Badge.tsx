import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Badge({ className, tone = "neutral", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "danger" | "brand" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full",
        tone === "success" ? "bg-successBg" : tone === "danger" ? "bg-dangerBg" : tone === "brand" ? "bg-brand/5" : "bg-creamDeep",
        "px-2 py-0.5 text-xs font-medium",
        tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : tone === "brand" ? "text-brand" : "text-inkMuted",
        className,
      )}
      {...props}
    />
  );
}
