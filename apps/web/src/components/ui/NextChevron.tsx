import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export function NextChevron({ className, "data-testid": testId }: { className?: string; "data-testid"?: string }) {
  return (
    <ChevronRight
      aria-hidden="true"
      data-testid={testId}
      strokeWidth={2}
      className={cn("inline-block h-[1.1em] w-[1.1em] shrink-0 align-[-0.2em]", className)}
    />
  );
}
