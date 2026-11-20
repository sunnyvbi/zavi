"use client";

import { cn } from "@/lib/cn";
import { OptionIcon } from "./OptionIcon";
import * as copy from "./setupQuestionsCopy";

export type QuestionStep = { key: copy.SetupQuestionKey; label: string; done: boolean };

export function SetupQuestionsStepper({ steps, onSelect }: { steps: readonly QuestionStep[]; onSelect: (key: copy.SetupQuestionKey) => void }) {
  return <nav aria-label={copy.QUESTIONS_STEPS_LABEL}>
    <ol className="flex items-center gap-2">
      {steps.map((step, i) => <li key={step.key} className="flex items-center gap-2">
        {i > 0 && <span aria-hidden className={cn("h-px w-4 sm:w-6", steps[i - 1].done ? "bg-onboarding-ink" : "bg-onboarding-border")} />}
        <button type="button" onClick={() => onSelect(step.key)}
          aria-label={`Question ${i + 1} of ${steps.length}: ${step.label}${step.done ? `, ${copy.QUESTIONS_STEP_ANSWERED}` : ""}`}
          className="inline-flex min-h-11 items-center gap-2 rounded-full text-sm font-semibold leading-5 text-onboarding-ink transition-opacity duration-onboarding-control ease-onboarding-control hover:opacity-70 motion-reduce:transition-none">
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[13px]", step.done ? "bg-onboarding-ink text-white" : "border border-onboarding-border bg-white")}>
            {step.done ? <OptionIcon name="tick-02" className="size-4" /> : i + 1}
          </span>
          <span className={cn("hidden sm:inline", !step.done && "text-onboarding-secondary")}>{step.label}</span>
        </button>
      </li>)}
    </ol>
  </nav>;
}
