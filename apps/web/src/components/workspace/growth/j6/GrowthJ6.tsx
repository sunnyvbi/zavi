"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { GrowthGoal, GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";
import { SettledSection } from "@/components/ui/SettledSection";
import { GoalEditor } from "../../AutopilotGoalsPanel";
import { useWorkspaceOptional } from "../../WorkspaceShell";
import { AD_BUDGET_ANCHOR, AdBudgetSection, type AdBudget } from "../AdBudgetSection";
import { GoalHistory } from "../GoalHistory";
import { SuggestedGoal } from "../GoalWork";
import { formatGoalNumber } from "../GrowthGoals";
import { GoalsBars } from "../GrowthMemoSkeleton";
import { editableGoal } from "../growthPresentation";
import { StoryGoals } from "../StoryGoals";
import { publishFromPage, releaseFromPage, setNeedsYouTenant, type NeedsYouState } from "../needsYou";
import {
  patchGoal,
  readAdBudget,
  readChannelCounts,
  readDoneWeek,
  readLedgerChanges,
  readOpenCards,
  readTests,
  type AdBudgetRead,
  type DoneItem,
  type LedgerChange,
  type OpenCard,
  type TestsRead,
} from "./api";
import { MoneyTable } from "../MoneyTable";
import { PlanStep, withoutNotUsing } from "./PlanStep";
import { ResultsStep } from "./ResultsStep";
import { StandStep, askBasis, headline, paceLine } from "./StandStep";
import { TODAY_ID, TodayStep, type TodaySummary } from "./TodayStep";
import { B, Modal, Rail, Src, Step, Toasts, eyebrow, type Overlay, type Toast } from "./ui";
import { useGoalStanding } from "./useGoalStanding";

export type GrowthJ6Props = {
  data: GrowthPlanPayload;
  onChanged: () => Promise<void>;
  drafting?: boolean;
  building?: boolean;
  draftSlow?: boolean;
  draftPhase?: "writing" | "checking" | "saving";
  onDraftStarted?: (runId?: string) => void;
  onAsk?: (text: string) => void;
  draftFailed?: boolean;
  onRetryDraft?: () => void;
  retryingDraft?: boolean;
  retryCharged?: boolean;
  footer?: ReactNode;
  companyFooter?: ReactNode;
  onScreen?: boolean;
  focusDecisionId?: string;
};

export function reconnectCards(hog: GrowthPlanPayload["head_of_growth"] | null, cards: OpenCard[]): OpenCard[] {
  const rows = hog?.note?.sections?.find((s) => s.key === "needs_you")?.rows ?? [];
  const have = new Set(cards.filter((c) => c.kind === "reconnect" && c.channel_slug).map((c) => c.channel_slug));
  const out: OpenCard[] = [];
  for (const r of rows) {
    if (r.fix?.kind !== "reconnect" || have.has(r.fix.slug)) continue;
    have.add(r.fix.slug);
    out.push({
      source: "decision",
      id: `reconnect:${r.fix.slug}`,
      channel_slug: r.fix.slug,
      kind: "reconnect",
      title: r.line,
      body: null,
      why: null,
      where: null,
      card_kind: null,
      primary_label: "Reconnect",
      amount: null,
      effect: null,
      tone: "warn",
      snoozed_until: null,
      created_at: "",
      url: null,
      mins: null,
      campaign_id: null,
      platform: null,
      can_redo: false,
    });
  }
  return out;
}

type Editing = { goal: GrowthGoal } | { create: string } | null;

export function GrowthJ6({
  data,
  onChanged,
  drafting = false,
  building = false,
  draftSlow = false,
  onDraftStarted,
  onAsk,
  draftFailed = false,
  onRetryDraft,
  retryingDraft = false,
  retryCharged = false,
  footer,
  companyFooter,
  onScreen = true,
  focusDecisionId,
}: GrowthJ6Props) {
  const workspace = useWorkspaceOptional();
  const role = workspace?.role ?? null;
  const canEdit = role === null || role === "owner" || role === "admin";
  const company = workspace?.tenantName?.trim() || "your company";

  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [cards, setCards] = useState<OpenCard[] | null>(null);
  const [cardsState, setCardsState] = useState<"loading" | "ready" | "failed">("loading");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [tests, setTests] = useState<TestsRead | null>(null);
  const [done, setDone] = useState<DoneItem[] | null>(null);
  const [ad, setAd] = useState<AdBudgetRead | null>(null);
  const [changes, setChanges] = useState<LedgerChange[] | null>(null);
  const [summary, setSummary] = useState<TodaySummary>({ open: 0, allDone: false, anyDone: false });
  const [budgetLinked, setBudgetLinked] = useState(false);
  useEffect(() => {
    const read = () => setBudgetLinked(window.location.hash === `#${AD_BUDGET_ANCHOR}`);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const close = useCallback(() => setOverlay(null), []);
  const say = useCallback((text: string, undo?: () => void) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2).map((x) => ({ ...x, undo: undefined })), { id, text, undo }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const reloadCards = useCallback(async () => {
    const [c, n] = await Promise.all([readOpenCards(), readChannelCounts()]);
    if (c) setCards(c);
    setCardsState((prev) => (c || prev === "ready" ? "ready" : "failed"));
    setCounts(n);
    void readDoneWeek().then((d) => d && setDone(d));
  }, []);
  const reloadAd = useCallback(() => {
    void readAdBudget().then(setAd);
    void readLedgerChanges().then(setChanges);
  }, []);

  useEffect(() => {
    void reloadCards();
  }, [data, reloadCards]);
  useEffect(() => {
    reloadAd();
    void readTests().then(setTests);
    void readDoneWeek().then(setDone);
  }, [reloadAd]);

  const hog = data.unreadable.includes("head_of_growth") ? null : data.head_of_growth ?? null;
  const allCards = useMemo(() => (cards ? withoutNotUsing([...reconnectCards(hog, cards), ...cards], data) : null), [cards, hog, data]);

  const needs: NeedsYouState = useMemo(() => {
    if (cardsState === "loading") return { kind: "loading" };
    if (cardsState === "failed" || !allCards) return { kind: "failed" };
    const open = allCards.filter((c) => !c.snoozed_until);
    return { kind: "ready", total: open.length, capped: false, marks: open.map((c) => `j6:${c.source}:${c.id}`) };
  }, [allCards, cardsState]);
  useEffect(() => {
    if (!onScreen) return;
    setNeedsYouTenant(workspace?.tenantId);
    publishFromPage(needs);
  });
  useEffect(() => {
    if (!onScreen) return;
    return () => releaseFromPage();
  }, [onScreen]);

  const goalsUnreadable = data.unreadable.includes("goals");
  const standing = useGoalStanding(data);
  const goal = standing.goals[0] ?? null;
  const editingGoal = editing && "goal" in editing ? standing.goals.find((g) => g.id === editing.goal.id) : undefined;
  const staleOthers = standing.goals
    .slice(1)
    .filter((g) => g.current_value !== null && ["failed", "unmeasured"].includes(standing.liveState.get(g.id) ?? ""));
  const showRows = !goalsUnreadable && (goal !== null || standing.removed.size > 0);
  const suggested = data.goals.items.find((g) => g.status === "proposed" && g.source === "agent_proposed") ?? null;
  const goalComing = !showRows && !suggested && !goalsUnreadable && !draftFailed && (drafting || building);
  const jumpToday = () => document.getElementById(TODAY_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const onSummary = useCallback((s: TodaySummary) => setSummary(s), []);

  const stored = goal ? data.goals.items.find((g) => g.id === goal.id) : undefined;
  const leadRead = goal ? standing.liveState.get(goal.id) ?? "manual" : "manual";
  const readOk = leadRead === "manual" || leadRead === "measured";
  const pace = goal && readOk && stored?.current_value === goal.current_value ? paceLine(goal) : null;
  const sub: ReactNode = !goal ? (
    goalsUnreadable ? "Couldn't load your goal." : goalComing ? "It lands with your plan." : "Pick one number to grow."
  ) : !readOk && leadRead !== "loading" ? (
    goal.current_value !== null
      ? "Showing the last reading: the live number could not be read just now."
      : "Zavi could not read this number from your data yet."
  ) : goal.current_value === null ? (
    leadRead === "loading" ? "Reading your number from your data." : "Add your number below to see if you're on track."
  ) : askBasis(goal) ? (
    <span className="font-semibold text-warn dark:text-marigold">One question below, then the forecast.</span>
  ) : pace ? (
    <>
      {pace} at this pace <Src kind="estimate">estimate</Src>
    </>
  ) : (
    "The pace shows once Zavi has enough readings."
  );

  const knows = () =>
    setOverlay({
      kind: "drawer",
      title: "What Zavi knows about you",
      body: (
        <div className="space-y-2.5 text-[15px] leading-6">
          {(data.detail?.company_facts ?? []).length === 0 ? (
            <p className="text-inkMuted">Nothing written down yet.</p>
          ) : (
            (data.detail?.company_facts ?? []).map((f, k) => (
              <p key={k} className="border-t border-rule pt-2 first:border-t-0 first:pt-0">
                {f.fact}
              </p>
            ))
          )}
          {companyFooter && <div className="pt-2">{companyFooter}</div>}
        </div>
      ),
    });

  const pauseGoal = async (id: string) => {
    const r = await patchGoal(id, { status: "paused" });
    if (!r.ok) throw new Error(r.message ?? "Could not pause that goal.");
    window.dispatchEvent(new Event("autopilot:goals-changed"));
    setEditing(null);
    await onChanged();
  };

  const showDone = summary.allDone && summary.anyDone;

  return (
    <div data-growth-view="new">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className={eyebrow}>Growth brief for {company} · From Zavi</p>
          <h1 className="mt-1.5 text-[30px] font-semibold leading-[38px] tracking-[-0.6px] text-ink">{goalComing ? "Zavi is setting your goal." : headline(goal)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[15px] leading-6 text-inkMuted">{sub}</p>
        </div>
        <button
          type="button"
          onClick={jumpToday}
          className="inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-ink/15 bg-cream pl-1.5 pr-3 text-[13px] font-semibold leading-5 text-ink transition-colors duration-150 hover:bg-creamDeep"
        >
          {showDone ? (
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-successBg text-success ">
              <Check className="h-3 w-3" />
            </span>
          ) : (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-dangerBg px-1 text-[12px] font-bold tabular-nums text-danger ">
              {summary.open}
            </span>
          )}
          {showDone ? "done for today" : "to do today"}
          <ChevronDown className="h-4 w-4 text-inkMuted" />
        </button>
      </header>

      {(draftFailed || draftSlow) && (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[14px] text-inkMuted">
          {draftFailed ? (
            <>
              <span>Your plan could not finish.{retryCharged ? " Another try uses credits." : ""}</span>
              {onRetryDraft && (
                <B disabled={retryingDraft} onClick={onRetryDraft}>
                  Try again
                </B>
              )}
            </>
          ) : (
            <span>Your plan is taking longer than usual. It shows up here when it lands.</span>
          )}
        </div>
      )}

      <div className="mt-8">
        <Step n={1} title={goal || goalsUnreadable ? "Where you stand" : goalComing ? "Your goal" : "Pick your goal"}>
          <StandStep
            goal={goal}
            goalsUnreadable={goalsUnreadable}
            goalComing={goalComing}
            canEdit={canEdit}
            showPicker={!showRows}
            rows={
              showRows ? (
                <>
                <SettledSection ready={standing.settled} skeleton={<GoalsBars ariaLabel="Loading your goals" />}>
                  <StoryGoals
                    goals={data.goals}
                    active={standing.goals}
                    pills={standing.pills}
                    fixes={standing.fixes}
                    plan={data.unreadable.includes("plan") ? null : data.plan}
                    detail={data.detail}
                    unavailable={false}
                    canEdit={canEdit}
                    onEdit={(g) => setEditing({ goal: g })}
                    onCreate={(initial) => setEditing({ create: initial ?? "" })}
                    onChanged={onChanged}
                    removed={standing.removed}
                    onRemovedChange={standing.onRemovedChange}
                    j6
                  />
                </SettledSection>
                {staleOthers.length > 0 && (
                  <p className="mt-2 text-[14px] text-inkMuted">
                    {`Showing the last reading for ${staleOthers.map((g) => g.objective).join(", ")}: the live number could not be read just now.`}
                  </p>
                )}
                </>
              ) : suggested && canEdit && !goalsUnreadable ? (
                <SuggestedGoal goalId={suggested.id} objective={suggested.objective} onChanged={onChanged} />
              ) : null
            }
            autopilot={hog ? hog.autopilot : null}
            ad={ad}
            changes={changes}
            onEditGoal={(g, objective) => setEditing(g ? { goal: g } : { create: objective ?? "" })}
            say={say}
            overlay={setOverlay}
            close={close}
            onChanged={onChanged}
            reloadAd={reloadAd}
          />
          {}
          <MoneyTable className="" alwaysShow />
          {(budgetLinked || (ad !== null && ad.budget?.status !== "active")) && (
            <AdBudgetSection
              variant="story"
              onChanged={reloadAd}
              initial={ad ? { budget: ad.budget as AdBudget | null, can_manage: ad.can_manage, pro: ad.pro } : undefined}
            />
          )}
        </Step>
        <Rail />
        <Step n={2} title="The plan">
          <PlanStep
            data={data}
            counts={counts}
            hasGoal={!!goal}
            goalId={goal?.id ?? null}
            drafting={drafting || building}
            canEdit={canEdit}
            onDraftStarted={onDraftStarted}
            jumpToday={jumpToday}
            say={say}
            onChanged={onChanged}
          />
        </Step>
        <Rail />
        <Step n={3} id={TODAY_ID} title={showDone ? "Done for today" : "Today"}>
          <TodayStep
            cards={allCards}
            failed={cardsState === "failed"}
            forecast={ad?.forecast ?? null}
            leftUsd={ad?.budget?.left_usd ?? null}
            say={say}
            overlay={setOverlay}
            close={close}
            reload={reloadCards}
            onSummary={onSummary}
            focusId={focusDecisionId}
          />
        </Step>
        <Rail />
        <Step n={4} title="Done & results" last>
          <ResultsStep key={goal?.id ?? "none"} goal={goal} tests={tests} done={done} ad={ad} />
        </Step>
      </div>

      <div className="mt-10 border-t border-rule pt-5">
        <button
          type="button"
          onClick={knows}
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-[15px] font-semibold text-ink underline decoration-ink/15 underline-offset-4 hover:decoration-ink"
        >
          What Zavi knows about you
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {footer && <div className="mt-6">{footer}</div>}
      <div className="h-10" />

      {overlay && <Modal o={overlay} close={close} />}
      {editing && (
        <GoalEditor
          key={"goal" in editing ? editing.goal.id : "new"}
          goal={"goal" in editing ? editableGoal(editing.goal) : null}
          initialObjective={"create" in editing ? editing.create : undefined}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            window.dispatchEvent(new Event("autopilot:goals-changed"));
            await onChanged();
          }}
          onPause={"goal" in editing ? () => pauseGoal(editing.goal.id) : undefined}
          history={
            editingGoal ? (
              <GoalHistory goal={editingGoal} format={(v) => formatGoalNumber(editingGoal.target_metric, v)} onAsk={onAsk} />
            ) : undefined
          }
        />
      )}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
