import { Check, Download, FileText, Loader2, MousePointer2 } from "lucide-react";
import { AiProviderIcon } from "@/components/icons/AiProviderIcon";
import { PAST_WORK_DEMO_FILENAME, PAST_WORK_PROMPT } from "./pastWorkCopy";
import { PastWorkDemoBrowserBar } from "./PastWorkDemoBrowserBar";
import type { PastWorkDemoPhase } from "./pastWorkDemoSequence";

function ClaudeFile({ phase }: { phase: PastWorkDemoPhase }) {
  const downloaded = phase !== "generated";

  return (
    <div className="animate-past-work-enter motion-reduce:animate-none">
      <div className="mb-3 flex items-start gap-2.5">
        <AiProviderIcon domain="claude.ai" className="mt-0.5 rounded-md" />
        <p className="font-serif text-onboarding-demo-answer">
          I’ve created your business brief. Download the file below and upload it to Zavi.
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-onboarding-claude-rule bg-white p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-onboarding-claude-bubble">
          <FileText className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-onboarding-demo-copy font-semibold">{PAST_WORK_DEMO_FILENAME}</p>
          <p className="text-onboarding-demo-label text-onboarding-claude-muted">Markdown · Business context</p>
        </div>
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-onboarding-claude-rule">
          {downloaded ? <Check className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
          {(phase === "generated" || phase === "downloaded") && (
            <MousePointer2 className="absolute -bottom-2 -right-2 h-5 w-5 animate-past-work-point fill-onboarding-ink text-white motion-reduce:animate-none" aria-hidden />
          )}
        </span>
      </div>
      <p className="mt-2 text-right text-onboarding-demo-label text-onboarding-claude-muted">
        {downloaded ? "Downloaded" : "Download file"}
      </p>
    </div>
  );
}

export function PastWorkDemoBrowser({ phase }: { phase: PastWorkDemoPhase }) {
  const waitingForPrompt = phase === "prompt" || phase === "copied";
  return (
    <div className="overflow-hidden rounded-2xl border border-onboarding-rule bg-onboarding-claude-paper shadow-onboarding-demo">
      <PastWorkDemoBrowserBar site="claude.ai/chat" warm />
      <div className="space-y-4 px-5 pb-5 pt-4 text-onboarding-claude-ink">
        <div className="min-h-onboarding-conversation space-y-4">
          {waitingForPrompt ? (
            <p className="flex min-h-onboarding-conversation items-center justify-center gap-2 font-serif text-2xl">
              <AiProviderIcon domain="claude.ai" className="rounded-md" />
              How can I help you today?
            </p>
          ) : (
            <>
              <div className="ml-auto flex max-w-onboarding-bubble animate-past-work-enter items-start gap-2.5 rounded-2xl bg-onboarding-claude-bubble px-3 py-2.5 motion-reduce:animate-none">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-onboarding-claude-avatar text-xs font-semibold text-white">R</span>
                <p className="line-clamp-2 text-onboarding-demo-copy">{PAST_WORK_PROMPT}</p>
              </div>
              {phase === "generating" ? (
                <p className="flex items-center gap-2 font-serif text-onboarding-demo-answer text-onboarding-claude-muted">
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  Creating your file…
                </p>
              ) : <ClaudeFile phase={phase} />}
            </>
          )}
        </div>
        <div className="rounded-2xl border border-onboarding-claude-rule bg-white px-3.5 py-2.5 text-onboarding-demo-copy text-onboarding-claude-muted">Reply to Claude…</div>
      </div>
    </div>
  );
}
