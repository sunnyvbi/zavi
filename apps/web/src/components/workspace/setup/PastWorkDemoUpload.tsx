import { Check, FileText, Loader2, MousePointer2, Upload, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  PAST_WORK_DEMO_FILENAME,
  PAST_WORK_DROP_LABEL,
  PAST_WORK_FILE_ADDING,
  PAST_WORK_FILE_READY,
  PAST_WORK_FILE_SAVED,
  PAST_WORK_LIMITS,
} from "./pastWorkCopy";
import type { PastWorkDemoPhase } from "./pastWorkDemoSequence";

export function PastWorkDemoUpload({ phase }: { phase: PastWorkDemoPhase }) {
  const dropping = phase === "dropping";
  const ready = phase === "ready";
  const adding = phase === "adding";
  const saved = phase === "saved";
  const hasFile = ready || adding || saved;

  return (
    <>
      <div className={cn(
        "relative mt-2 flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-3 py-4 text-center transition-colors motion-reduce:transition-none",
        dropping ? "border-onboarding-ink bg-onboarding-subtle" : "border-onboarding-border bg-white",
      )}>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-onboarding-subtle">
          <Upload className="h-4 w-4" aria-hidden />
        </span>
        <p className="text-xs font-semibold">{PAST_WORK_DROP_LABEL}</p>
        <p className="text-onboarding-demo-label text-onboarding-muted">{PAST_WORK_LIMITS}</p>
        {dropping && (
          <div className="absolute inset-x-3 top-8 flex animate-past-work-file-drop items-center gap-2 rounded-xl border border-onboarding-border bg-white px-3 py-3 shadow-onboarding-demo motion-reduce:animate-none">
            <FileText className="h-5 w-5 shrink-0 text-onboarding-muted" aria-hidden />
            <span className="min-w-0 truncate text-xs font-semibold">{PAST_WORK_DEMO_FILENAME}</span>
            <MousePointer2 className="absolute -bottom-2 right-3 h-5 w-5 fill-onboarding-ink text-white" aria-hidden />
          </div>
        )}
      </div>
      <div className="mt-2 min-h-16">
        {hasFile && (
          <div className="flex animate-past-work-enter items-center gap-2 rounded-xl border border-onboarding-rule px-3 py-2 motion-reduce:animate-none">
            <FileText className="h-4 w-4 shrink-0 text-onboarding-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{PAST_WORK_DEMO_FILENAME}</p>
              <p className="text-onboarding-demo-label text-onboarding-muted">
                {saved ? PAST_WORK_FILE_SAVED : adding ? PAST_WORK_FILE_ADDING : PAST_WORK_FILE_READY}
              </p>
            </div>
            {adding ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : saved ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <X className="h-3.5 w-3.5 shrink-0 text-onboarding-muted" aria-hidden />}
          </div>
        )}
      </div>
      <div className="relative mt-2 flex justify-end">
        <span className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors motion-reduce:transition-none",
          hasFile ? "bg-onboarding-ink text-white" : "bg-onboarding-subtle text-onboarding-light",
          adding && "scale-95",
        )}>
          {adding && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />}
          {saved && <Check className="h-3 w-3" aria-hidden />}
          {saved ? "Added to Zavi" : adding ? PAST_WORK_FILE_ADDING : "Add to Zavi"}
        </span>
        {adding && <MousePointer2 className="absolute -bottom-1 right-3 h-5 w-5 animate-past-work-point fill-onboarding-ink text-white motion-reduce:animate-none" aria-hidden />}
      </div>
    </>
  );
}
