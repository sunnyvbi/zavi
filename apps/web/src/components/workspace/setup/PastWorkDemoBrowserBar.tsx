import { LockKeyhole } from "lucide-react";
import { cn } from "@/lib/cn";

export function PastWorkDemoBrowserBar({
  site,
  warm = false,
}: {
  site: string;
  warm?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-onboarding-rule px-3 py-2",
        warm ? "bg-onboarding-claude-paper" : "bg-onboarding-demo-subtle",
      )}
    >
      <span className="flex gap-1.5" aria-hidden="true">
        <span className="h-2.5 w-2.5 rounded-full bg-onboarding-claude-red" />
        <span className="h-2.5 w-2.5 rounded-full bg-onboarding-claude-yellow" />
        <span className="h-2.5 w-2.5 rounded-full bg-onboarding-claude-green" />
      </span>
      <span className="mx-auto flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-onboarding-ink/5 px-3 text-onboarding-demo-label text-onboarding-secondary">
        <LockKeyhole className="h-3 w-3 shrink-0" aria-hidden />
        {site}
      </span>
      <span className="w-10" />
    </div>
  );
}
