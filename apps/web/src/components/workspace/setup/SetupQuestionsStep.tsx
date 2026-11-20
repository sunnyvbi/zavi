"use client";

import { ArrowLeft, ArrowRight, ChevronsRight, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { onboardingDisplay } from "@/fonts/onboarding";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import * as copy from "./setupQuestionsCopy";
import { SetupQuestionsStepper } from "./SetupQuestionsStepper";
import { StrategyPreview } from "./StrategyPreview";
import { OptionIcon, type OptionIconName } from "./OptionIcon";

const OPTION_ICONS: Record<string, OptionIconName> = {
  "More people finding us": "radar-01",
  "More of them actually buying": "wallet-01",
  "Customers worth more": "dollar-circle",
  "Customers staying longer": "repeat",
  "More sellers or suppliers on our side": "user-multiple",
  "They never hear about us": "search-01",
  "They look, but don't buy": "view",
  "They sign up, then never get going": "user-add-01",
  "They buy once and don't come back": "repeat",
  "We can't keep up with the demand we have": "dashboard-speed-01",
  "Honestly, I'm not sure": "information-circle",
  "Someone I already knew": "user",
  "I reached out to them myself": "sent",
  "Word of mouth from a customer": "comment-01",
  "They searched and found us": "search-01",
  "We paid for ads": "megaphone-01",
  "Saw us on social": "image-01",
  "Nothing repeatable yet": "information-circle",
};

const STEP_QUESTIONS = copy.SETUP_QUESTIONS.filter((q) => copy.SETUP_STEP_KEYS.includes(q.key));

export type SetupAnswers = Partial<Record<copy.SetupQuestionKey, string[]>>;
type Answers = SetupAnswers;

export async function saveSetupAnswers(answers: Answers): Promise<boolean> {
  let ok = true;
  for (const q of copy.SETUP_QUESTIONS) {
    const picked = answers[q.key] ?? [];
    if (!picked.length) continue;
    try {
      const res = await apiFetch("/api/workspace/growth-interview/answer", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: q.key, answer: picked.join(", ") }),
      });
      if (!res.ok) { ok = false; console.warn(`[setup] answer ${q.key} not saved (HTTP ${res.status})`); }
    } catch (e) {
      ok = false;
      console.warn(`[setup] answer ${q.key} not saved: ${(e as Error).message}`);
    }
  }
  return ok;
}

export function SetupQuestionsStep({ answers, onChange, onBack, onFinish, onSkip, busy = false, error }: {
  answers: Answers;
  onChange: (next: (prev: Answers) => Answers) => void;
  onBack: () => void;
  onFinish: (answers: Answers) => Promise<unknown>;
  onSkip: () => Promise<unknown>;
  busy?: boolean;
  error?: string | null;
}) {
  const [pressed, setPressed] = useState<"skip" | "finish" | null>(null);
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const answered = STEP_QUESTIONS.filter((q) => (answers[q.key] ?? []).length > 0).length;
  const sections = useRef<Partial<Record<copy.SetupQuestionKey, HTMLFieldSetElement | null>>>({});
  const show = (key: copy.SetupQuestionKey, block: ScrollLogicalPosition) => {
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sections.current[key]?.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block });
  };
  const steps = STEP_QUESTIONS.map((q) => ({ key: q.key, label: copy.QUESTIONS_STEP_LABELS[q.key] ?? q.question, done: (answers[q.key] ?? []).length > 0 }));
  const pick = (q: copy.SetupQuestion, option: string) => {
    const adding = !(answers[q.key] ?? []).includes(option);
    onChange((prev) => {
      const now = prev[q.key] ?? [];
      const rest = option === copy.CHANNELS_NONE ? [] : now.filter((o) => o !== copy.CHANNELS_NONE);
      const next = now.includes(option) ? now.filter((o) => o !== option) : q.multi ? [...rest, option] : [option];
      return { ...prev, [q.key]: next };
    });
    const following = STEP_QUESTIONS[STEP_QUESTIONS.indexOf(q) + 1];
    if (adding && !q.multi && following) show(following.key, "nearest");
  };
  const finish = async () => {
    setPressed("finish");
    setSaving(true);
    try { await onFinish(answers); } finally { setSaving(false); }
  };
  const finishing = locked && pressed === "finish";
  const skipping = locked && pressed === "skip";
  return <div aria-busy={locked || undefined} className={cn(onboardingDisplay.variable, "flex h-full min-h-0 w-full bg-white font-onboarding text-onboarding-ink selection:bg-onboarding-ink selection:text-white")}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 pt-6 sm:px-8">
        <IconButton type="button" label="Back" onClick={onBack} disabled={locked} className="h-11 w-11 rounded-full border-onboarding-border bg-white p-0 text-onboarding-ink transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-subtle active:scale-95 motion-reduce:transform-none motion-reduce:transition-none"><ArrowLeft className="h-5 w-5" aria-hidden /></IconButton>
        <span className="col-start-2 lg:hidden"><ZaviWordmark size="lg" markless /></span>
        <div className="hidden lg:col-start-2 lg:row-start-1 lg:block"><SetupQuestionsStepper steps={steps} onSelect={(key) => show(key, "start")} /></div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <main className="mx-auto w-full max-w-2xl animate-past-work-enter px-4 pb-8 pt-4 sm:px-8 sm:pt-6 motion-reduce:animate-none">
          <h1 className="text-onboarding-title-mobile font-semibold tracking-tight sm:text-onboarding-title">{copy.QUESTIONS_TITLE}</h1>
          <p className="mt-2 text-lg leading-7 text-onboarding-secondary">{copy.QUESTIONS_SUBTITLE}</p>
          <div className="mt-6 space-y-6">
            {STEP_QUESTIONS.map((q, i) => <fieldset key={q.key} disabled={locked} ref={(el) => { sections.current[q.key] = el; }} className="scroll-mb-8 scroll-mt-4">
              <legend className="block">
                <span className="flex items-start gap-2.5">
                  <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-onboarding-subtle text-xs font-semibold leading-none">{i + 1}</span>
                  <span className="text-base font-semibold leading-6">{q.question}{q.multi && <span className="block text-xs font-medium leading-5 text-onboarding-muted">{copy.QUESTIONS_PICK_ANY_SHORT}</span>}</span>
                </span>
              </legend>
              <div className="mt-3 flex flex-wrap gap-2">
                {q.options.map((option) => {
                  const on = (answers[q.key] ?? []).includes(option);
                  const icon = OPTION_ICONS[option];
                  return <button key={option} type="button" aria-pressed={on} onClick={() => pick(q, option)}
                    className={cn("inline-flex min-h-11 items-center gap-2 rounded-full bg-white text-left text-[15px] font-semibold leading-5 text-onboarding-ink transition-colors duration-onboarding-control ease-onboarding-control active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none",
                      on ? "border-2 border-onboarding-ink px-[15px] py-[7px]" : "border border-onboarding-border px-4 py-2 hover:bg-onboarding-subtle")}>
                    {on ? <OptionIcon name="tick-02" className="h-[18px] w-[18px] shrink-0" />
                      : icon && <OptionIcon name={icon} className="h-[18px] w-[18px] shrink-0 text-onboarding-secondary" />}
                    {option}
                  </button>;
                })}
              </div>
            </fieldset>)}
          </div>
          {error && <p role="alert" className="mt-6 text-sm leading-6 text-warn">{error}</p>}
          <p role="status" aria-live="polite" className="sr-only">{skipping ? copy.QUESTIONS_SKIPPING : finishing ? copy.QUESTIONS_SAVING : ""}</p>
        </main>
        <div aria-hidden className="pointer-events-none sticky bottom-0 -mt-8 h-8 bg-gradient-to-t from-white" />
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-onboarding-rule bg-white px-4 py-4 sm:px-8">
        <Button type="button" disabled={locked} onClick={() => { setPressed("skip"); void onSkip(); }} className="h-12 rounded-full border-onboarding-border bg-white px-5 text-base font-semibold text-onboarding-ink transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-subtle active:scale-95 motion-reduce:transform-none motion-reduce:transition-none">{skipping ? copy.QUESTIONS_SKIPPING : "Skip"}{skipping ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <ChevronsRight className="h-4 w-4" aria-hidden />}</Button>
        {answered > 0 && <Button type="button" variant="primary" disabled={locked} onClick={() => void finish()} className="h-12 rounded-full px-5 text-base font-semibold transition duration-onboarding-control ease-onboarding-control active:scale-95 motion-reduce:transform-none motion-reduce:transition-none">
          {finishing ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />{copy.QUESTIONS_SAVING}</> : <>{copy.QUESTIONS_FINISH}<ArrowRight className="h-4 w-4" aria-hidden /></>}
        </Button>}
      </footer>
    </div>
    <aside aria-label={copy.PREVIEW_EYEBROW} className="hidden h-full w-onboarding-panel max-w-onboarding-panel shrink-0 p-3 lg:block">
      <div className="relative flex h-full flex-col overflow-y-auto rounded-onboarding-panel border border-onboarding-rule bg-white bg-onboarding-panel bg-cover bg-center p-8">
        <div className="shrink-0"><ZaviWordmark size="lg" markless /></div>
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="flex w-full animate-past-work-enter justify-center motion-reduce:animate-none"><StrategyPreview answers={answers} /></div>
        </div>
      </div>
    </aside>
  </div>;
}
