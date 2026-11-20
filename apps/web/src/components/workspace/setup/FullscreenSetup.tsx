"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { PastWorkStep } from "./PastWorkStep";
import { SetupConnectorsStep } from "./SetupConnectorsStep";
import { saveSetupAnswers, SetupQuestionsStep, type SetupAnswers } from "./SetupQuestionsStep";
import { QUESTIONS_SAVE_FAILED } from "./setupQuestionsCopy";
import { useSetupActive, useSetupOptional } from "./SetupProvider";
import { useSetupNavigation } from "./useSetupNavigation";
import { useSetupCompletion } from "./useSetupCompletion";
export { currentStep } from "./setupStepsState";

const heldAnswersKey = (tenantId: string | undefined) => (tenantId ? `zavi.setup.answers:${tenantId}` : null);
function loadHeldAnswers(key: string | null): SetupAnswers {
  try {
    const raw = !key || typeof window === "undefined" ? null : window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SetupAnswers) : {};
  } catch {
    return {};
  }
}
function storeHeldAnswers(key: string | null, answers: SetupAnswers | null): void {
  if (!key) return;
  try {
    if (answers) window.sessionStorage.setItem(key, JSON.stringify(answers));
    else window.sessionStorage.removeItem(key);
  } catch {
    return;
  }
}

export function FullscreenSetup() {
  const setup = useSetupOptional();
  const workspace = useWorkspaceOptional();
  const navigation = useSetupNavigation();
  const completion = useSetupCompletion(setup);
  const questionsFor = navigation.questionsFor;
  const heldKey = heldAnswersKey(workspace?.tenantId);
  const [answers, setHeldAnswers] = useState<SetupAnswers>(() => loadHeldAnswers(heldKey));
  const setAnswers = useCallback((next: (prev: SetupAnswers) => SetupAnswers) => setHeldAnswers((prev) => {
    const value = next(prev);
    storeHeldAnswers(heldKey, value);
    return value;
  }), [heldKey]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const activeKind = workspace?.tabs.find((tab) => tab.id === workspace.activeTabId)?.kind;
  const onBuild = !!setup?.buildOpen && activeKind === "build";
  const running = useSetupActive();
  const state = onBuild ? null : running;
  if (setup?.pending) return <div role="status" aria-label="Loading your setup" className="onboarding-light fixed inset-0 z-setup flex items-center justify-center bg-white text-onboarding-muted"><Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden /></div>;
  if (!setup || !state) return null;
  const pastWork = state.docs.status === "pending" || navigation.pastWork;
  const buildId = setup.buildOpen ? workspace?.buildSessionId ?? null : null;
  const backToBuild = buildId && workspace ? () => workspace.openBuildTab(buildId) : undefined;
  const finishDocs = async (outcome: "done" | "skipped") => {
    if (state.docs.status === "pending") await setup.mark({ step: "docs", outcome });
    if (navigation.pastWork) navigation.next();
  };
  const onQuestions = !!questionsFor && !pastWork;
  const finishSetup = async () => {
    if (closing) return false;
    setClosing(true);
    try {
      if (Object.values(answers).some((picked) => picked?.length)) {
        const saved = await saveSetupAnswers(answers);
        setSaveFailed(!saved);
        if (!saved) return false;
      }
      if (!(await completion.finish(onQuestions ? questionsFor : "skipped", pastWork))) return false;
      storeHeldAnswers(heldKey, null);
      navigation.finish();
      return true;
    } finally {
      setClosing(false);
    }
  };
  const busy = completion.busy || closing;
  const error = completion.error ?? (saveFailed ? QUESTIONS_SAVE_FAILED : null);
  return <Dialog id="onboarding-dialog" label="Set up Zavi" busy={busy} onClose={finishSetup} className={cn("onboarding-light z-setup flex flex-col bg-white", process.env.NEXT_PUBLIC_ZAVI_MIRROR === "1" && "top-10 sm:top-6")}>
    <div className="min-h-0 flex-1">
      {pastWork ? <PastWorkStep busy={busy} error={error} imports={setup.imports} onBack={backToBuild} onComplete={() => finishDocs("done")} onSkip={() => finishDocs("skipped")} /> :
        questionsFor ? <SetupQuestionsStep answers={answers} onChange={setAnswers} onBack={navigation.closeQuestions} busy={busy} error={error}
          onFinish={async (picked) => {
            const saved = await saveSetupAnswers(picked);
            setSaveFailed(!saved);
            if (saved && await completion.finish(questionsFor)) { storeHeldAnswers(heldKey, null); navigation.finish(); }
          }}
          onSkip={async () => { if (await completion.finish(questionsFor)) { storeHeldAnswers(heldKey, null); navigation.finish(); } }} /> :
        <SetupConnectorsStep onBack={navigation.back} busy={busy} error={error} onContinue={() => navigation.openQuestions("done")} onSkip={() => navigation.openQuestions("skipped")} />}
    </div>
  </Dialog>;
}
