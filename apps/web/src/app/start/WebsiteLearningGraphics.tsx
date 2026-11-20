import { Building2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function BusinessGraphic() {
  return (
    <div aria-hidden="true" className="w-full space-y-1.5">
      <div className="flex gap-1.5">
        <span className="h-4 w-14 rounded-full bg-onboarding-ink motion-safe:animate-website-business-pill" />
        <span className="h-4 w-10 rounded-full border border-onboarding-border" />
      </div>
      <span className="block h-2 w-full rounded-full bg-onboarding-subtle" />
      <span className="block h-2 w-3/4 rounded-full bg-onboarding-subtle" />
    </div>
  );
}

export function CompetitorsGraphic() {
  return (
    <div aria-hidden="true" className="flex items-center">
      {["motion-safe:animate-website-rival-one", "motion-safe:animate-website-rival-two", "motion-safe:animate-website-rival-three"].map((animation) => (
        <span key={animation} className={cn("-ml-2 flex size-9 items-center justify-center rounded-full border-2 border-white bg-onboarding-subtle text-onboarding-muted first:ml-0", animation)}>
          <Building2 className="size-4" strokeWidth={1.5} />
        </span>
      ))}
    </div>
  );
}

export function ConstraintGraphic() {
  return (
    <div aria-hidden="true" className="w-full space-y-2">
      {["w-full", "w-3/4"].map((width) => (
        <div key={width} className={cn("flex items-center gap-2", width)}>
          <span className="size-2.5 shrink-0 rounded-full bg-onboarding-ink" />
          <span className="h-2 flex-1 rounded-full bg-onboarding-subtle" />
        </div>
      ))}
    </div>
  );
}

export function GrowthGraphic() {
  return (
    <div aria-hidden="true" className="flex h-12 items-end gap-1.5">
      {[
        "h-4 bg-onboarding-border motion-safe:animate-website-bar-one",
        "h-6 bg-onboarding-border motion-safe:animate-website-bar-two",
        "h-8 bg-onboarding-border motion-safe:animate-website-bar-three",
        "h-11 bg-onboarding-ink motion-safe:animate-website-bar-four",
      ].map((bar) => <span key={bar} className={cn("w-3.5 origin-bottom rounded-t-md", bar)} />)}
    </div>
  );
}
