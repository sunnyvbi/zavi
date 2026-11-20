"use client";

import { POLL_CAP_MS, POLL_MS, useGrowthPlan } from "@/lib/workspace/useGrowthPlan";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { creditRefusalFrom } from "@/lib/workspace/creditRefusal";
import { CreditRefusalNotice } from "./CreditRefusalNotice";
import { apiFetch } from "@/lib/api";
import { trackEvent } from "@/lib/analytics/events";
import { firstThisBrowser } from "@/lib/analytics/session";
import { hasAnalyticsConsent } from "@/lib/consent";
import { useActiveTenant } from "./brain/useActiveTenant";
import { Button } from "@/components/ui/Button";
import { GrowthMemoSkeleton } from "./growth/GrowthMemoSkeleton";
import { GrowthJ6, type GrowthJ6Props } from "./growth/j6/GrowthJ6";
import { useSetupOptional } from "./setup/SetupProvider";
import { SetupLoadError } from "./setup/SetupLoadError";
import { showReadyPanel } from "./setup/ReadyPanel";
import { AddKnowledgeButton, showAddKnowledge } from "./setup/AddKnowledgeDialog";
import { AfterSetupReadNote } from "./setup/AfterSetupReadNote";
import { PlanCooking, usePlanReadyAlert } from "./growth/PlanCooking";
import { useWorkspaceOptional } from "./WorkspaceShell";
import { WhatZaviLearned } from "./growth/WhatZaviLearned";
import { LaterQuestions } from "./growth/LaterQuestions";

const AUTO_DRAFT_ATTEMPTS = 120;
const AUTO_DRAFT_RETRY_MS = 5_000;
const LIVE_REFRESH_MS = 30_000;

export function GrowthCoachPage({
  onAsk,
  live = false,
  focusDecisionId,
}: {
  focusDecisionId?: string;
  onAsk?: (text: string) => void;
  live?: boolean;
}) {
  const setupPoll = useRef<(() => void) | null>(null);
  const { data, loading, error, reload, refresh, drafting, draftSlow, draftError, watchForPlan, stopWatch } =
    useGrowthPlan(() => setupPoll.current?.());

  const warmed = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (warmed.current) return;
    warmed.current = apiFetch("/api/workspace/growth-intake/research", {
      method: "POST",
    }).catch(() => {});
  }, []);

  const setupCtx = useSetupOptional();
  const setupKnown = setupCtx === null || setupCtx.state !== null;
  const setupOnFlag = setupCtx?.state?.enabled === true;
  const autoDrafted = useRef(false);
  const [autoAsking, setAutoAsking] = useState(false);
  useEffect(() => {
    if (!setupKnown || setupOnFlag) return;
    if (autoDrafted.current) return;
    if (loading || !data) return;
    if (data.unreadable.includes("plan") || data.plan) return;
    let cancelled = false;
    setAutoAsking(true);
    void (async () => {
      await warmed.current?.catch(() => {});
      for (let attempt = 0; attempt < AUTO_DRAFT_ATTEMPTS; attempt += 1) {
        if (cancelled) return;
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, AUTO_DRAFT_RETRY_MS));
          if (cancelled) return;
        }
        let res: Response;
        try {
          res = await apiFetch("/api/workspace/growth-strategy/draft?auto=1", {
            method: "POST",
          });
        } catch {
          continue;
        }
        if (cancelled) return;
        if (!res.ok) continue;
        const body = (await res.json().catch(() => null)) as {
          run_id?: string;
          skipped?: string;
          retry?: boolean;
        } | null;
        if (body?.retry) continue;
        autoDrafted.current = true;
        if (body?.run_id) watchForPlan(body.run_id);
        return;
      }
    })().finally(() => {
      if (!cancelled) setAutoAsking(false);
    });
    return () => {
      cancelled = true;
      setAutoAsking(false);
    };
  }, [loading, data, watchForPlan, setupKnown, setupOnFlag]);

  const watchedSetupRun = useRef<string | null>(null);
  const setupWatch = useRef(false);
  const setupDraft = setupCtx?.state?.enabled ? setupCtx.state.draft : null;
  useEffect(() => {
    if (setupDraft?.status !== "running" || !setupDraft.run_id) return;
    if (watchedSetupRun.current === setupDraft.run_id) return;
    watchedSetupRun.current = setupDraft.run_id;
    setupWatch.current = true;
    watchForPlan();
  }, [setupDraft?.status, setupDraft?.run_id, watchForPlan]);

  const sawDrafting = useRef(false);
  const refreshSetup = setupCtx?.refresh;
  useEffect(() => {
    if (drafting) {
      sawDrafting.current = true;
      return;
    }
    if (!sawDrafting.current) return;
    sawDrafting.current = false;
    if (setupDraft?.status === "running") void refreshSetup?.();
  }, [drafting, setupDraft?.status, refreshSetup]);

  const oneState = setupCtx?.state?.enabled === true && setupCtx.state.one_state === true;
  const setupRunning = setupDraft?.status === "running";
  const setupPollSince = useRef(0);
  useEffect(() => {
    if (setupRunning) setupPollSince.current = Date.now();
  }, [setupRunning]);
  useEffect(() => {
    if (!setupRunning) return;
    const due = () => Date.now() - setupPollSince.current < POLL_CAP_MS || (Date.now() - setupPollSince.current) % 30_000 < POLL_MS;
    setupPoll.current = () => {
      if (due()) void refreshSetup?.();
    };
    if (drafting) {
      return () => {
        setupPoll.current = null;
      };
    }
    const id = window.setInterval(() => {
      if (!due()) return;
      void refreshSetup?.();
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      setupPoll.current = null;
    };
  }, [setupRunning, drafting, refreshSetup]);
  const setupSettled = setupDraft?.status === "done" || setupDraft?.status === "failed";
  useEffect(() => {
    if (!drafting || !setupSettled || !setupWatch.current) return;
    if (!setupDraft?.run_id || watchedSetupRun.current !== setupDraft.run_id) return;
    setupWatch.current = false;
    stopWatch();
    void refresh();
  }, [oneState, drafting, setupSettled, setupDraft?.run_id, stopWatch, refresh]);

  const [retrying, setRetrying] = useState(false);
  const setupState = setupCtx?.state?.enabled ? setupCtx.state : null;
  const draftFailed = !!setupState?.done && setupState.draft.status === "failed" && setupState.draft.can_retry;
  const retryCharged = draftFailed && !setupState?.draft.free_retry && !setupState?.draft.save_retry;
  const finishNote = setupCtx?.finishNote ?? null;
  const planReady = !!data?.plan && !data.unreadable.includes("plan");
  const firstPlanPending = setupRunning && !planReady && !draftFailed && setupCtx?.canManageSetup === true;
  const setupDraftDone = setupDraft?.status === "done";
  useEffect(() => {
    if (setupDraftDone && !planReady && !loading && !drafting) void refresh();
  }, [setupDraftDone, planReady, loading, drafting, refresh]);
  const building =
    !planReady &&
    !draftSlow &&
    !draftFailed &&
    (drafting || autoAsking || setupCtx?.draftStarting === true || setupDraft?.status === "running");
  const draftCredit = setupCtx?.draftBlocked === "insufficient_credits"
    ? creditRefusalFrom({ error: { code: "insufficient_credits" } }, "plan")
    : null;
  const retryDraft = async () => {
    if (!setupCtx) return;
    setRetrying(true);
    try { await setupCtx.startDraft(true, retryCharged); } finally { setRetrying(false); }
  };

  const planOpenedMarked = useRef(false);
  const hasPlanToMark = !!data?.plan;
  const setupCovers = setupCtx?.locked === true;
  useEffect(() => {
    if (planOpenedMarked.current || !hasPlanToMark || !live || setupCovers) return;
    const mark = () => {
      if (planOpenedMarked.current || document.visibilityState !== "visible" || !document.hasFocus()) return;
      planOpenedMarked.current = true;
      void apiFetch("/api/workspace/next-tiles/mark", {
        method: "POST",
        body: JSON.stringify({ kind: "plan_opened", key: "plan" }),
      }).catch(() => {});
    };
    mark();
    if (planOpenedMarked.current) return;
    document.addEventListener("visibilitychange", mark);
    window.addEventListener("focus", mark);
    return () => {
      document.removeEventListener("visibilitychange", mark);
      window.removeEventListener("focus", mark);
    };
  }, [hasPlanToMark, live, setupCovers]);
  const tenantId = useActiveTenant();
  const hasPlan = !!data?.plan;
  const company = useWorkspaceOptional()?.tenantName?.trim() || "your company";
  usePlanReadyAlert(typeof tenantId === "string" ? tenantId : null, firstPlanPending, planReady, company);
  useEffect(() => {
    if (!hasPlan || typeof tenantId !== "string" || !hasAnalyticsConsent()) return;
    if (!firstThisBrowser(`ph_zavi_first_result:${tenantId}`)) return;
    trackEvent("first_result_seen", { kind: "growth_plan" });
  }, [hasPlan, tenantId]);

  useEffect(() => {
    if (!live) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = window.setInterval(tick, LIVE_REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [live, refresh]);

  const homeMarked = useRef(false);
  const readyNow =
    !!data && showReadyPanel(setupCtx?.state ?? null, !!data.plan && !data.unreadable.includes("plan"), setupCtx?.canManageSetup ?? false);
  useEffect(() => {
    if (!live || !readyNow || homeMarked.current || !setupCtx) return;
    homeMarked.current = true;
    setupCtx.mark({ step: "home" }).catch((e: unknown) => {
      homeMarked.current = false;
      console.warn(`[setup] marking the growth page seen failed: ${(e as Error).message}`);
    });
  }, [live, readyNow, setupCtx]);

  const renderPage = () => {
    if (loading && !data) return <GrowthMemoSkeleton />;
    if (error || !data)
      return (
        <div role="alert" className="rounded-lg border border-rule p-4">
          <h2 className="text-base font-semibold text-ink">
            Could not load your growth plan
          </h2>
          <p className="mt-2 text-xs text-inkMuted">
            {error ?? "Plan data is unavailable."}
          </p>
          <Button className="mt-3" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      );
    const props: GrowthJ6Props = {
      data,
      onScreen: live,
      focusDecisionId,
      onChanged: reload,
      drafting: drafting || setupRunning,
      building,
      draftSlow,
      draftPhase: setupDraft?.phase,
      onDraftStarted: (runId) => {
        setupWatch.current = false;
        watchForPlan(runId);
      },
      onAsk,
      draftFailed,
      retryCharged,
      onRetryDraft: () => void retryDraft(),
      retryingDraft: retrying,
      companyFooter:
        showAddKnowledge(setupCtx?.state ?? null, setupCtx?.canManageSetup ?? false) ? <AddKnowledgeButton /> : undefined,
    };
    return (
      <div className="mx-auto w-full max-w-[832px]">
        {draftError && <p role="alert" className="mb-3 text-sm">{draftError}</p>}
        {setupCtx?.draftStartError && <div role="alert" className="mb-3 flex items-center gap-3 text-sm">
          <span>{setupCtx.draftStartError}</span>
          <Button disabled={setupCtx.draftStarting} onClick={() => void setupCtx.startDraft(draftFailed, retryCharged)}>Try again</Button>
        </div>}
        {finishNote && <p role="status" className="mb-3 text-sm text-inkMuted">{finishNote}</p>}
        {firstPlanPending && <PlanCooking tenant={typeof tenantId === "string" ? tenantId : null} />}
        <WhatZaviLearned active={!planReady && (building || firstPlanPending)} />
        <LaterQuestions active={planReady && setupCtx?.canManageSetup === true} />
        <AfterSetupReadNote />
        {draftCredit && <CreditRefusalNotice refusal={draftCredit} className="mb-3" />}
        <GrowthJ6 {...props} />
      </div>
    );
  };

  return (
    <>
      <SetupLoadError />
      {renderPage()}
    </>
  );
}
