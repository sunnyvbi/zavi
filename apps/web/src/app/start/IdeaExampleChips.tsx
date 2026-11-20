"use client";
import type { ComponentType, ReactNode } from "react";
import { Bone, CalendarDays, Camera, Croissant, LayoutDashboard, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { IDEA_EXAMPLES, IDEA_EXAMPLES_LABEL } from "@/lib/workspace/buildFraming";

type Icon = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;

export const IDEA_CHIP =
  "inline-flex h-idea-chip items-center gap-2 rounded-full border border-onboarding-rule bg-white pl-2 pr-4 text-sm font-medium text-ink shadow-idea-chip transition-colors hover:border-onboarding-border hover:bg-onboarding-demo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-onboarding-focus/60";

const EXAMPLE_ICONS: { icon: Icon; tone: string }[] = [
  { icon: Croissant, tone: "bg-idea-bakery text-idea-bakery-ink" },
  { icon: Bone, tone: "bg-idea-dog text-idea-dog-ink" },
  { icon: Camera, tone: "bg-idea-photo text-idea-photo-ink" },
  { icon: CalendarDays, tone: "bg-idea-yoga text-idea-yoga-ink" },
];

export function IdeaChipIcon({ icon: Glyph, tone }: { icon: Icon; tone: string }) {
  return (
    <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", tone)}>
      <Glyph aria-hidden className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}

export const TEMPLATE_CHIP_ICON = (
  <IdeaChipIcon icon={LayoutDashboard} tone="bg-idea-template text-idea-template-ink" />
);

export function IdeaExampleChips({
  showExamples,
  onPick,
  templateTrigger,
}: {
  showExamples: boolean;
  onPick: (idea: string) => void;
  templateTrigger: ReactNode;
}) {
  return (
    <div className="mt-idea-examples flex flex-col items-center">
      {showExamples && (
        <p className="text-sm text-ink/80">
          {IDEA_EXAMPLES_LABEL}
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-center gap-x-2 gap-y-3">
        {showExamples &&
          IDEA_EXAMPLES.map((ex, i) => {
            const look = EXAMPLE_ICONS[i] ?? { icon: Sparkles, tone: "bg-idea-template text-idea-template-ink" };
            return (
              <button key={ex.label} type="button" onClick={() => onPick(ex.idea)} className={IDEA_CHIP}>
                <IdeaChipIcon icon={look.icon} tone={look.tone} />
                {ex.label}
              </button>
            );
          })}
        {templateTrigger}
      </div>
    </div>
  );
}
