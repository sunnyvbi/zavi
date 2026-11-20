import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, variant = "default", ...props }: HTMLAttributes<HTMLDivElement> & { variant?: "default" | "muted" }) {
  return (
    <div
      className={cn("border border-rule", variant === "muted" ? "rounded-2xl bg-bone/60 shadow-none" : "rounded-xl bg-cream shadow-elev", className)}
      {...props}
    />
  );
}
