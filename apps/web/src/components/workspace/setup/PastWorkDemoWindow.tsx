import { Check, Copy, MousePointer2 } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/cn";
import {
  PAST_WORK_COPY_HEADING,
  PAST_WORK_UPLOAD_HEADING,
  PAST_WORK_TITLE,
  PAST_WORK_PROMPT,
} from "./pastWorkCopy";
import { PastWorkDemoBrowserBar } from "./PastWorkDemoBrowserBar";
import { PastWorkDemoUpload } from "./PastWorkDemoUpload";
import type { PastWorkDemoPhase } from "./pastWorkDemoSequence";

const EXAMPLE_PROMPT = `${PAST_WORK_PROMPT.slice(0, 149)}…`;

export function PastWorkDemoWindow({ phase }: { phase: PastWorkDemoPhase }) {
  const showingUpload = phase !== "prompt" && phase !== "copied";

  return (
    <div
      key={showingUpload ? "upload" : "prompt"}
      className={cn(
        "absolute right-0 w-onboarding-demo-window animate-past-work-demo overflow-hidden rounded-2xl border border-onboarding-rule bg-white shadow-onboarding-demo motion-reduce:animate-none",
        showingUpload ? "bottom-0" : "bottom-24",
      )}
    >
      <PastWorkDemoBrowserBar site="zavi.ai/onboarding" />
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <Image
            src="/zavi-wordmark.png"
            alt=""
            width={126}
            height={52}
            className="h-4 w-auto"
          />
          <span className="text-onboarding-demo-label font-semibold text-onboarding-muted">
            {PAST_WORK_TITLE}
          </span>
        </div>
        <p className="mt-3 text-onboarding-demo-copy font-semibold">
          {showingUpload ? PAST_WORK_UPLOAD_HEADING : PAST_WORK_COPY_HEADING}
        </p>
        {showingUpload ? (
          <PastWorkDemoUpload phase={phase} />
        ) : (
          <div className="mt-1.5 overflow-hidden rounded-2xl border border-onboarding-border">
            <p className="line-clamp-3 bg-onboarding-demo-subtle px-3 py-2 text-xs leading-relaxed text-onboarding-secondary">
              {EXAMPLE_PROMPT}
            </p>
            <div className="flex justify-end border-t border-onboarding-rule px-2 py-1.5">
              <span
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold",
                  phase === "copied"
                    ? "border border-onboarding-border bg-white text-onboarding-ink"
                    : "bg-onboarding-ink text-white",
                )}
              >
                {phase === "copied" ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                {phase === "copied" ? "Copied" : "Copy prompt"}
              </span>
            </div>
          </div>
        )}
      </div>
      {phase === "copied" && (
        <MousePointer2 className="absolute bottom-4 right-6 h-5 w-5 animate-past-work-point fill-onboarding-ink text-white motion-reduce:animate-none" aria-hidden />
      )}
    </div>
  );
}
