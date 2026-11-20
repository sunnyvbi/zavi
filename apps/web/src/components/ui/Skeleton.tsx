import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn(
        "animate-pulse rounded-md bg-creamDeep motion-reduce:animate-none",
        className,
      )}
    />
  );
}
