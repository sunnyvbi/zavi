"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function Menu({
  label,
  icon,
  children,
  fluid = false,
}: {
  label: string;
  icon?: ReactNode;
  children: (close: () => void) => ReactNode;
  fluid?: boolean;
}) {
  const [el, setEl] = useState<HTMLDetailsElement | null>(null);
  const close = () => el?.removeAttribute("open");
  return (
    <details
      ref={setEl}
      className={cn(
        "relative compact:min-w-0",
        fluid &&
          "min-w-max flex-1 compact:flex-none [@container(max-width:520px)]:min-w-0 [@container(max-width:520px)]:flex-none",
      )}
    >
      <summary
        aria-label={label}
        title={label}
        className={cn(
          "relative inline-flex cursor-pointer list-none items-center gap-2 rounded-lg border border-rule bg-cream px-3 py-2 text-[14px] font-medium text-ink after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] hover:bg-creamDeep compact:max-w-full compact:gap-2 compact:px-2 compact:py-1 compact:text-[16px]",
          fluid && "max-w-full compact:h-10 compact:w-10 compact:justify-center compact:gap-0 compact:rounded-cta compact:p-0 [@container(max-width:520px)]:h-10 [@container(max-width:520px)]:w-10 [@container(max-width:520px)]:justify-center [@container(max-width:520px)]:gap-0 [@container(max-width:520px)]:rounded-cta [@container(max-width:520px)]:p-0",
        )}
      >
        {icon}
        <span
          className={cn(
            "compact:min-w-0 compact:truncate",
            fluid && "min-w-0 truncate compact:hidden [@container(max-width:520px)]:hidden",
          )}
        >
          {label}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-inkMuted compact:shrink-0",
            fluid && "compact:hidden [@container(max-width:520px)]:hidden",
          )}
          aria-hidden
        />
      </summary>
      <div
        role="menu"
        aria-label={label}
        className={cn(
          "absolute right-0 z-20 mt-1 overflow-hidden rounded-xl border border-rule bg-cream py-1 shadow-pop",
          fluid ? "w-full compact:w-48 [@container(max-width:520px)]:w-48" : "w-64",
        )}
      >
        {children(close)}
      </div>
    </details>
  );
}
