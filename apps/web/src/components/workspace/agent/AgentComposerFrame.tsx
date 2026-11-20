import type { ReactNode } from "react";
import { ENGINEER_SLUG } from "@/lib/agentRegistry";
import { cn } from "@/lib/cn";

export function AgentComposerFrame({
  agentSlug,
  zavi,
  sidePanel,
  children,
}: {
  agentSlug: string;
  zavi: boolean;
  sidePanel: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "shrink-0",
        zavi || sidePanel || agentSlug === ENGINEER_SLUG
          ? "w-full"
          : "border-t border-rule",
      )}
    >
      {children}
    </div>
  );
}
