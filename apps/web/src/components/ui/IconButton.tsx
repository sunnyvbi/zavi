import type { ButtonHTMLAttributes } from "react";
import { Button } from "./Button";
import { cn } from "@/lib/cn";

export function IconButton({
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Button
      aria-label={label}
      title={label}
      className={cn("shrink-0 p-1.5", className)}
      {...props}
    />
  );
}
