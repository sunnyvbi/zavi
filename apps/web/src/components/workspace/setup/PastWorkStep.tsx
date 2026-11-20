"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronsRight, Loader2 } from "lucide-react";
import { Textarea } from "@/components/Input";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { Button } from "@/components/ui/Button";
import { onboardingDisplay } from "@/fonts/onboarding";
import { cn } from "@/lib/cn";
import { SETUP_BACK_TO_BUILD } from "./setupCopy";
import type { ImportReads } from "./importReads";
import { PastWorkDemo } from "./PastWorkDemo";
import { PastWorkGuide } from "./PastWorkGuide";
import { PastWorkUpload } from "./PastWorkUpload";
import { PAST_WORK_SUBTITLE, PAST_WORK_TITLE } from "./pastWorkCopy";
import { usePastWorkImport } from "./usePastWorkImport";

export function PastWorkStep({
  imports,
  onComplete,
  onSkip,
  doneLabel = "Add to Zavi",
  onBack,
  busy = false,
  error,
  beforeUpload,
  recovery,
  recoveryKey,
}: {
  imports?: ImportReads | null;
  onComplete: () => Promise<unknown>;
  onSkip: () => Promise<unknown>;
  doneLabel?: string;
  onBack?: () => void;
  busy?: boolean;
  error?: string | null;
  beforeUpload?: () => Promise<unknown>;
  recovery?: ReactNode;
  recoveryKey?: string;
}) {
  const work = usePastWorkImport(imports, onComplete, onSkip, beforeUpload, recoveryKey);
  const locked = work.busy || busy;
  const hasSaved =
    !!work.savedText ||
    work.files.some((f) => f.status === "saved") ||
    !!imports?.files?.length;
  const [pasteOpen, setPasteOpen] = useState(false);
  const showPaste = pasteOpen || !!work.text;
  const canSubmit = hasSaved || work.files.length > 0 || !!work.text.trim();
  return (
    <div
      aria-busy={locked || undefined}
      className={cn(
        onboardingDisplay.variable,
        "flex h-full min-h-0 w-full bg-white font-onboarding text-onboarding-ink selection:bg-onboarding-ink selection:text-white",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "shrink-0 items-center gap-4 px-4 pt-7",
            onBack ? "flex justify-between" : "flex justify-center lg:hidden",
          )}
        >
          {onBack && (
            <Button
              type="button"
              onClick={onBack}
              disabled={locked}
              className="h-10 rounded-full border-onboarding-border bg-white px-4 text-sm text-onboarding-ink hover:bg-onboarding-subtle"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {SETUP_BACK_TO_BUILD}
            </Button>
          )}
          <span className="lg:hidden">
            <ZaviWordmark size="lg" markless />
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <main className="mx-auto w-full max-w-onboarding-form animate-past-work-enter px-4 pb-8 pt-8 sm:px-0 lg:pt-9 motion-reduce:animate-none">
            <h1 className="text-onboarding-title-mobile font-semibold tracking-tight sm:text-onboarding-title">
              {PAST_WORK_TITLE}
            </h1>
            <p className="mt-3 text-lg leading-7 text-onboarding-secondary">
              {PAST_WORK_SUBTITLE}
            </p>
            <div className="mt-6">
              <PastWorkGuide mode="paste">
                <PastWorkUpload
                  files={work.files}
                  busy={locked}
                  addFiles={work.addFiles}
                  remove={work.remove}
                />
                {showPaste ? (
                  <div className="mt-4">
                    <label htmlFor="past-work-answer" className="mb-2 block text-sm font-semibold text-onboarding-ink">
                      Paste the answer here
                    </label>
                    <Textarea
                      id="past-work-answer"
                      unstyled
                      rows={3}
                      value={work.text}
                      disabled={locked}
                      onChange={(e) => work.setText(e.target.value)}
                      placeholder="- The business sells online booking for salons…"
                      className="min-h-24 w-full resize-y rounded-3xl border border-onboarding-border bg-white px-4 py-3 text-base leading-relaxed text-onboarding-ink outline-none transition-shadow placeholder:text-onboarding-light focus:border-onboarding-ink focus:ring-4 focus:ring-onboarding-ink/5 disabled:opacity-60 motion-reduce:transition-none"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => setPasteOpen(true)}
                    className="mt-3 rounded-full text-sm font-semibold text-onboarding-secondary underline underline-offset-4 hover:text-onboarding-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-onboarding-focus disabled:opacity-60"
                  >
                    Or paste text instead
                  </button>
                )}
              </PastWorkGuide>
            </div>
            {imports?.files && imports.files.length > 0 && (
              <div
                role="status"
                className="mt-5 rounded-2xl border border-onboarding-rule px-4 py-3 text-sm text-onboarding-secondary"
              >
                <p className="font-semibold">Your past work is saved</p>
                <ul className="mt-1 space-y-1">
                  {imports.files.map((file) => (
                    <li key={file.id} className="break-words">
                      {file.filename}:{" "}
                      {file.status === "done"
                        ? `${file.facts} facts learned`
                        : file.status === "failed"
                          ? "Saved, but couldn't be read. You can try another file."
                          : file.status === "stored"
                            ? "Saved"
                            : "Reading in the background"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(work.error || error) && (
              <p
                role="alert"
                className="mt-4 text-sm leading-relaxed text-warn"
              >
                {work.error || error}
              </p>
            )}
            {recovery}
          </main>
        </div>
        <footer className="shrink-0 border-t border-onboarding-rule bg-white">
          <div className="flex min-h-20 w-full items-center justify-end gap-3 px-4 py-4 sm:px-8">
            <Button
              type="button"
              disabled={locked}
              onClick={() => void work.skip()}
              className="h-12 rounded-full border-onboarding-border bg-white px-5 text-base font-semibold text-onboarding-ink hover:bg-onboarding-subtle"
            >
              {work.active === "skip" ? "Continuing…" : "Skip"}
              {work.active === "skip" ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <ChevronsRight className="h-4 w-4" aria-hidden />
              )}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={locked || !canSubmit}
              onClick={() => void work.submit("auto")}
              className="h-12 rounded-full px-5 text-base font-semibold disabled:border-onboarding-subtle disabled:bg-onboarding-subtle disabled:text-onboarding-muted disabled:opacity-100"
            >
              {work.active === "submit" ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                  Adding…
                </>
              ) : (
                doneLabel
              )}
            </Button>
          </div>
        </footer>
      </div>
      <aside
        aria-label="What Zavi remembers"
        className="hidden h-full w-onboarding-panel max-w-onboarding-panel shrink-0 p-3 lg:block"
      >
        <div className="relative flex h-full flex-col overflow-y-auto rounded-onboarding-panel border border-onboarding-rule bg-white bg-onboarding-panel bg-cover bg-center p-8">
          <div className="shrink-0">
            <ZaviWordmark size="lg" markless />
          </div>
          <div className="flex flex-1 flex-col justify-center py-6">
            <PastWorkDemo />
          </div>
        </div>
      </aside>
    </div>
  );
}
