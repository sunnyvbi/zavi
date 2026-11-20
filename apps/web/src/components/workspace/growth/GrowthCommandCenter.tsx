"use client";

import { creditRefusalFrom, type CreditRefusal } from "@/lib/workspace/creditRefusal";
import { CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, CircleAlert, MessageCircle, Pencil, Play, Plug, Plus } from "lucide-react";
import type { GrowthGoal, GrowthPlanPayload, NoteSectionRow } from "@/lib/workspace/useGrowthPlan";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Portal } from "@/components/ui/Portal";
import { SettledSection, SkeletonBars } from "@/components/ui/SettledSection";
import { BlockerBars, ChannelsBars, GoalsBars, HeadlineBars } from "./GrowthMemoSkeleton";
import { GoalEditor, type Goal } from "../AutopilotGoalsPanel";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { useSetupOptional } from "../setup/SetupProvider";
import {
  QUESTIONS_ANCHOR_ID,
  QUESTIONS_JUMP_EVENT,
  WaitingForYou,
  takeQuestionsJump,
  useWaitingQuestions,
  type Answered,
} from "../WaitingForYou";
import { GrowthCompanyCard } from "./GrowthCompanyCard";
import { GrowthBrandVoice } from "./GrowthBrandVoice";
import { usePersonalization } from "../personalization/usePersonalization";
import {
  formatGoalNumber,
  goalCountLabel,
  goalFix,
  measurementNeed,
  rankGoals,
  useLiveGoalValues,
  withLiveValue,
} from "./GrowthGoals";
import { GrowthChannels, channelName, orderedPlanChannels, type ChannelWork } from "./GrowthChannels";
import { GrowthConnections } from "./GrowthConnections";
import { HeadOfGrowthCard } from "./HeadOfGrowth";
import { AdBudgetSection } from "./AdBudgetSection";
import { MoneyTable } from "./MoneyTable";
import { GoalHistory } from "./GoalHistory";
import { WaitingMove, type Move } from "./GoalWork";
import { PrimaryButton } from "./GrowthSection";
import { LOADING, growthHeadline, type HeadlineAction, type MeasurementNeed, type ReadyHeadline } from "./growthHeadline";
import { FORM_CONNECTORS, connectorSetupHref, editableGoal, humanize, shortDate } from "./growthPresentation";
import { GrowthReviewList } from "./GrowthReviewList";
import {
  needsYouState,
  noteNeeds,
  pendingFromApprovals,
  publishFromPage,
  readGrowthHome,
  releaseFromPage,
  setNeedsYouTenant,
  waitingMovesOf,
  type ApprovalsBody,
  type Pending,
} from "./needsYou";
import { startReconnectFlow } from "../settings/reconnectFlows";
import { NeedsYouFixRow } from "./NeedsYouFixRow";
import { useChannelLocks } from "../layout/useChannelLocks";
import { lockedTierOf } from "@/lib/workspace/planUpgrade";
import { runCostLabel, useChannelRunPress } from "../layout/useChannelRunPress";
import { platformFor } from "../actions/platforms";
import { BUILDING_LINE, strategyProgressLine } from "../setup/setupCopy";
import { StoryBecause, StoryStep } from "./StoryStep";
import { StoryGoals, goalPill, goalStatusLine, useGoalHistories, type GoalPill } from "./StoryGoals";
import { StoryWay, StoryWayAside } from "./StoryWay";
import { StoryHappened, StoryHappenedAside, useYouAsked } from "./StoryHappened";
import { StoryDrawer } from "./StoryDrawer";

const NEEDS_ID = "growth-needs";

type Editing = { goal: Goal } | { create: string | undefined } | null;

type SourceState = "loading" | "ready" | "failed";

const SETUP_KINDS = new Set<ReadyHeadline["kind"]>(["no_goal", "unmeasured", "nothing_ran", "needs_plan", "no_rivals", "no_voice", "unknown"]);

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    problems?: string[];
  };
  return body.problems?.[0] ?? body.error?.message ?? fallback;
}

export function GrowthCommandCenter({
  data,
  onChanged,
  drafting = false,
  building = false,
  draftSlow = false,
  draftPhase,
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
}: {
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
}) {
  const workspace = useWorkspaceOptional();
  const setupState = useSetupOptional()?.state;
  const oneState = setupState?.enabled === true && setupState.one_state === true;
  const role = workspace?.role ?? null;
  const canEdit = role === null || role === "owner" || role === "admin";
  const personalization = usePersonalization();

  const [editing, setEditing] = useState<Editing>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<CreditRefusal | null>(null);
  const [savingSlugs, setSavingSlugs] = useState<ReadonlySet<string>>(new Set());
  const channelLocks = useChannelLocks();
  const [noteOpen, setNoteOpen] = useState(false);
  const [knowOpen, setKnowOpen] = useState(false);
  const [health, setHealth] = useState<{ connected: number; notSyncing: number } | null>(null);

  const [channelWork, setChannelWork] = useState<ChannelWork | null>(null);
  const [runningKnown, setRunningKnown] = useState(false);
  const [workSettled, setWorkSettled] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [runCredits, setRunCredits] = useState<Record<string, number>>({});
  const [workKey, setWorkKey] = useState(0);
  const [approvalsRevision, setApprovalsRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [a, c, g] = await Promise.all([
          apiFetch("/api/approvals"),
          apiFetch("/api/channels"),
          readGrowthHome(),
        ]);
        const approvals = a?.ok ? ((await a.json()) as ApprovalsBody) : null;
        const chans = c?.ok
          ? ((await c.json()) as {
              channels?: { channel_slug: string; work_state?: string; run_reserve_credits?: unknown }[];
            })
          : null;
        if (cancelled) return;
        setPending(approvals ? pendingFromApprovals(approvals, g) : null);
        setApprovalsRevision((r) => r + 1);
        setRunningKnown(chans !== null);
        setWorkSettled(true);
        if (chans) {
          const credits: Record<string, number> = {};
          for (const ch of chans.channels ?? []) {
            const n = ch.run_reserve_credits;
            if (typeof n === "number" && Number.isFinite(n) && n > 0) credits[ch.channel_slug] = n;
          }
          setRunCredits(credits);
        }
        if (!approvals && !chans) return;
        setChannelWork({
          counts: approvals?.channel_pending_counts ?? {},
          running: new Set(
            (chans?.channels ?? [])
              .filter((ch) => ch.work_state === "running")
              .map((ch) => ch.channel_slug),
          ),
        });
      } catch {
        if (cancelled) return;
        setPending(null);
        setRunningKnown(false);
        setWorkSettled(true);
        setChannelWork(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, workKey]);

  const [facts, setFacts] = useState<{ name: string; rivals: number } | null | undefined>(undefined);
  const [connected, setConnected] = useState<string[] | null | undefined>(undefined);
  const [connectorsKey, setConnectorsKey] = useState(0);
  const [addRivalRequest, setAddRivalRequest] = useState(0);
  const [voiceEditRequest, setVoiceEditRequest] = useState(0);
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => {
    if (focusDecisionId) setReviewOpen(true);
  }, [focusDecisionId]);
  const [headlineError, setHeadlineError] = useState<string | null>(null);

  const plan = data.unreadable.includes("plan") ? null : data.plan;
  const hasLivePlan = plan !== null && !plan.pending_acceptance;
  const bets = data.unreadable.includes("bets")
    ? []
    : data.bets.filter((bet) => bet.status === "accepted" || bet.status === "done");
  const anyMeasured =
    !data.unreadable.includes("metrics") &&
    data.metrics.some((m) => m.status === "measured" && m.value !== null);

  const goalsUnreadable = data.unreadable.includes("goals");
  const workUnreadable = data.unreadable.includes("goal_work");
  const [removedGoals, setRemovedGoals] = useState<ReadonlySet<string>>(new Set());
  const onRemovedChange = useCallback((id: string, gone: boolean) => {
    setRemovedGoals((prev) => {
      const next = new Set(prev);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const activeGoals = rankGoals(data.goals.items.filter((g) => g.status === "active" && !removedGoals.has(g.id)));
  const [recheck, setRecheck] = useState(0);
  const live = useLiveGoalValues(activeGoals, data, recheck);
  const liveGoals = activeGoals.map((g) => withLiveValue(g, live.values));
  const fixOf = new Map(activeGoals.map((g) => [g.id, goalFix(g, live, connected)] as const));
  const measuredGoals = liveGoals.filter((g) => {
    const fix = fixOf.get(g.id);
    return fix !== undefined && fix !== LOADING && fix !== null && fix.kind === "none";
  });
  const histories = useGoalHistories(measuredGoals, recheck);
  const pillOf = new Map(liveGoals.map((g) => [g.id, goalPill(g, fixOf.get(g.id) ?? null, histories.get(g.id))] as const));
  const pillsSettled = goalsUnreadable || Array.from(pillOf.values()).every((p) => p !== LOADING);
  const settledPills = new Map<string, GoalPill | null>(
    Array.from(pillOf.entries()).map(([id, p]) => [id, p === LOADING ? null : p]),
  );
  const settledFixes = new Map<string, MeasurementNeed | null>(
    Array.from(fixOf.entries()).map(([id, f]) => [id, f === LOADING ? null : f]),
  );

  const planChannels = orderedPlanChannels(data.channels, bets, hasLivePlan);
  const locksKnown = channelLocks !== null && Object.keys(channelLocks).length > 0;
  const computed = growthHeadline({
    pending: !workSettled ? LOADING : pending?.total ?? null,
    pendingCapped: pending?.capped ?? false,
    activeGoals: goalsUnreadable ? null : activeGoals.length,
    measurement: goalsUnreadable ? null : measurementNeed(activeGoals, live, connected),
    channels: data.unreadable.includes("channels")
      ? null
      : !workSettled || channelLocks === null
        ? LOADING
        : !runningKnown || !locksKnown
          ? null
          : planChannels.map((c) => ({
            slug: c.slug,
            name: channelName(c.slug) ?? humanize(c.slug),
            locked: !(c.slug in channelLocks) || lockedTierOf({ locked_tier: channelLocks[c.slug] }) !== null,
            ranAt: c.last_run_at,
            running:
              (channelWork?.running.has(c.slug) ?? false) ||
              (started.has(c.slug) && c.last_run_at === null),
          })),
    rivals: facts === undefined ? LOADING : facts === null ? null : facts.rivals,
    brandVoiceSet: personalization.error
      ? null
      : personalization.data
        ? personalization.data.brand_voice.trim().length > 0
        : personalization.loading
          ? LOADING
          : null,
    noGoalFirst: oneState,
  });

  const lastStatus = useRef<string | null>(null);
  if (pillsSettled && !goalsUnreadable) {
    lastStatus.current = goalStatusLine(liveGoals.map((g) => settledPills.get(g.id) ?? null));
  }

  const lastSettled = useRef<ReadyHeadline | null>(null);
  if (computed.kind !== "loading") lastSettled.current = computed;
  const settled = computed.kind === "loading" ? lastSettled.current : computed;
  const headline: ReadyHeadline = settled ?? {
    kind: "unknown",
    text: "",
    action: { kind: "recheck", label: "" },
  };
  const setupStep = SETUP_KINDS.has(headline.kind);
  const statusText = setupStep ? null : lastStatus.current;
  const headlineLoading = settled === null || (!setupStep && !goalsUnreadable && lastStatus.current === null && !pillsSettled);
  const bigLine = statusText ?? headline.text;

  const pauseGoal = async (id: string) => {
    const res = await apiFetch(`/api/workspace/autopilot/goals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    if (!res.ok) throw new Error(await errorOf(res, "Could not pause that goal."));
    window.dispatchEvent(new Event("autopilot:goals-changed"));
    setEditing(null);
    await onChanged();
  };

  const connect = async (slug: string) => {
    setHeadlineError(null);
    try {
      await startReconnectFlow(slug);
    } catch (e) {
      setHeadlineError((e as Error).message || "Could not start the connection.");
    } finally {
      setConnectorsKey((k) => k + 1);
    }
  };

  const waiting = useWaitingQuestions();
  const [answeredQ, setAnsweredQ] = useState<Record<string, Answered>>({});
  const { pullOpened } = waiting;
  const onAnswered = useCallback(
    (id: string, a: Answered) => {
      setAnsweredQ((m) => ({ ...m, [id]: a }));
      void pullOpened();
    },
    [pullOpened],
  );
  const hogNote = data.head_of_growth?.note ?? null;
  const hogUnreadable = data.unreadable.includes("head_of_growth");
  const noteNeed = noteNeeds(hogNote);
  const needRows: NoteSectionRow[] | null = noteNeed.sectioned ? noteNeed.rows : null;
  const needsMore = noteNeed.more;
  const leftForYou: NoteSectionRow[] = noteNeed.rows;
  const leftLabel = needRows ? "Needs you" : "Left for you";
  const urgentRows = leftForYou.filter((r) => r.urgent);
  const calmRows = leftForYou.filter((r) => !r.urgent);
  const needsRowKey = (r: NoteSectionRow): string => r.rid ?? `line:${r.line}`;
  const waitingMoves = waitingMovesOf(data.goal_work);
  const openQuestions = waiting.questions.filter((q) => !answeredQ[q.id]);
  const needs = needsYouState({
    questions: { state: waiting.state, open: openQuestions },
    pending: !workSettled ? "loading" : pending,
    note: hogNote,
    goalWork: data.goal_work,
    unreadable: data.unreadable,
  });
  const needsState: SourceState = needs.kind;
  const needsTotal = needs.kind === "ready" ? needs.total : 0;
  const needsCapped = needs.kind === "ready" && needs.capped;
  useEffect(() => {
    if (!onScreen) return;
    setNeedsYouTenant(workspace?.tenantId);
    publishFromPage(needs);
  });
  useEffect(() => {
    if (!onScreen) return;
    return () => releaseFromPage();
  }, [onScreen]);
  const countless = oneState && activeGoals.length === 0 && !goalsUnreadable;
  const needsCount = `${needsTotal}${needsCapped ? "+" : ""}`;
  const retryNeeds = () => {
    void waiting.reload();
    setWorkKey((k) => k + 1);
    void onChanged();
  };

  const needsHashScrolled = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#growth-needs") return;
    if (needsHashScrolled.current || needsState !== "ready") return;
    needsHashScrolled.current = true;
    const jump = () => document.getElementById(NEEDS_ID)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    const t1 = window.setTimeout(jump, 50);
    const t2 = window.setTimeout(jump, 1200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [needsState]);

  const [questionsJumpTick, setQuestionsJumpTick] = useState(0);
  useEffect(() => {
    const onJump = () => setQuestionsJumpTick((t) => t + 1);
    window.addEventListener(QUESTIONS_JUMP_EVENT, onJump);
    return () => window.removeEventListener(QUESTIONS_JUMP_EVENT, onJump);
  }, []);
  useEffect(() => {
    if (needsState !== "ready" || !takeQuestionsJump()) return;
    const jump = () =>
      (document.getElementById(QUESTIONS_ANCHOR_ID) ?? document.getElementById(NEEDS_ID))?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    const t1 = window.setTimeout(jump, 50);
    const t2 = window.setTimeout(jump, 1200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [needsState, questionsJumpTick]);

  const act = (action: HeadlineAction) => {
    switch (action.kind) {
      case "review":
        setReviewOpen(true);
        document.getElementById(NEEDS_ID)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        return;
      case "add_goal":
        setEditing({ create: undefined });
        return;
      case "connect":
        void connect(action.slug);
        return;
      case "enter_number": {
        const goal = activeGoals.find((g) => g.id === action.goalId);
        if (goal) setEditing({ goal: editableGoal(goal) });
        return;
      }
      case "add_rivals":
        setKnowOpen(true);
        setAddRivalRequest((n) => n + 1);
        return;
      case "set_voice":
        setKnowOpen(true);
        setVoiceEditRequest((n) => n + 1);
        return;
      case "ask":
        onAsk?.(action.question);
        return;
      case "recheck":
        setWorkKey((k) => k + 1);
        setRecheck((k) => k + 1);
        setConnectorsKey((k) => k + 1);
        void waiting.reload();
        void onChanged();
        return;
      case "start_run":
        return;
    }
  };

  const needsEdit = ["add_goal", "connect", "enter_number", "add_rivals", "set_voice"].includes(headline.action.kind);
  const showAction =
    setupStep && (!needsEdit || canEdit) && (headline.action.kind !== "ask" || onAsk !== undefined);

  const appliedFor = useRef<string | null>(null);
  const pendingKey = plan?.pending_acceptance ? `${plan.id}:${plan.version}` : null;
  useEffect(() => {
    if (!pendingKey || appliedFor.current === pendingKey) return;
    appliedFor.current = pendingKey;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/growth-strategy/apply", {
          method: "POST",
        });
        if (res.ok) await onChanged();
      } catch {
        appliedFor.current = null;
      }
    })();
  }, [pendingKey, onChanged]);

  const [channelError, setChannelError] = useState<string | null>(null);

  const withSaving = useCallback(
    async (slug: string, write: () => Promise<Response>, fallback: string) => {
      setSavingSlugs((prev) => new Set(prev).add(slug));
      setChannelError(null);
      try {
        const res = await write();
        if (!res.ok) {
          setChannelError(
            res.status === 403 || res.status === 409
              ? await errorOf(res, fallback)
              : res.status === 404
                ? "Adding channels is not available yet. Try again after the next update."
                : `${fallback} Try again in a moment.`,
          );
          return;
        }
        await onChanged();
      } catch {
        setChannelError(`${fallback} Check your connection and try again.`);
      } finally {
        setSavingSlugs((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    },
    [onChanged],
  );

  const toggleAutorun = (slug: string, next: boolean) =>
    withSaving(
      slug,
      () =>
        apiFetch(`/api/workspace/growth/channels/${encodeURIComponent(slug)}/autorun`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autorun: next, ...(slug === "chatgpt_ads" && next ? { paid_consent: "chatgpt-growth-v1" } : {}) }),
        }),
      "Could not save that change.",
    );

  const setInPlan = (slug: string, inPlan: boolean) =>
    withSaving(
      slug,
      () =>
        apiFetch(`/api/workspace/growth/channels/${encodeURIComponent(slug)}/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ in_plan: inPlan }),
        }),
      inPlan
        ? `Could not add ${channelName(slug) ?? "that channel"}.`
        : `Could not remove ${channelName(slug) ?? "that channel"}.`,
    );

  const askZavi = async () => {
    setAsking(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/growth-strategy/draft", {
        method: "POST",
      });
      if (!res.ok) {
        const refusal = creditRefusalFrom(await res.clone().json().catch(() => null), "plan");
        setCredit(refusal);
        setError(
          refusal?.headline ??
            (await errorOf(res, `Could not start the analysis (HTTP ${res.status}).`)),
        );
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { status?: string; run_id?: string };
      if (body.status === "already_drafted_today") {
        setNote("Zavi already worked on your plan today. It appears here when it lands.");
      } else {
        onDraftStarted?.(body.run_id);
      }
      await onChanged();
    } catch (e) {
      setError((e as Error).message || "Could not start the analysis.");
    } finally {
      setAsking(false);
    }
  };

  const icon =
    headline.action.kind === "ask" ? (
      <MessageCircle className="h-4 w-4" aria-hidden="true" />
    ) : headline.action.kind === "connect" ? (
      <Plug className="h-4 w-4" aria-hidden="true" />
    ) : headline.action.kind === "set_voice" ? (
      <Pencil className="h-4 w-4" aria-hidden="true" />
    ) : headline.action.kind === "recheck" ? null : (
      <Plus className="h-4 w-4" aria-hidden="true" />
    );
  const companyName = facts?.name || workspace?.tenantName?.trim() || "your company";
  const nextCheckIn = hogNote?.next_review_at ? shortDate(hogNote.next_review_at) : null;
  const forYou = pending ? Math.max(0, pending.total - pending.toApprove) : 0;
  const needsAside =
    needsState === "ready" && needsTotal > 0
      ? countless
        ? "Waiting for you"
        : [
            `${needsCount} waiting`,
            pending && pending.toApprove > 0 ? `${pending.toApprove}${pending.capped ? "+" : ""} to approve` : null,
            forYou > 0 ? `${forYou} for you` : null,
          ]
            .filter(Boolean)
            .join(" · ")
      : null;
  const asked = useYouAsked(data);
  const editingGoal: GrowthGoal | undefined =
    editing && "goal" in editing ? liveGoals.find((g) => g.id === editing.goal.id) : undefined;

  return (
    <div className="mx-auto max-w-[720px] pb-8 text-ink compact:pb-6">
      <div className="mb-5 space-y-3 empty:hidden">
        {data.unreadable.length > 0 && (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-xl border border-marigold/30 bg-marigold/[0.06] px-3.5 py-3"
          >
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-marigold/15 text-warn dark:text-marigold">
              <CircleAlert className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">
                Could not load {data.unreadable.map(humanize).join(", ")}.
              </span>
              <span className="block text-[13px] [line-height:1.375] text-inkMuted">Missing data is unknown until it loads.</span>
            </span>
            <button
              type="button"
              onClick={() => void onChanged()}
              className="inline-flex h-8 shrink-0 items-center rounded-full border border-rule bg-cream px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']"
            >
              Retry
            </button>
          </div>
        )}
        {drafting && !error && (
          <p role="status" className="text-sm text-inkMuted">
            {draftPhase ? strategyProgressLine(draftPhase) : BUILDING_LINE}
          </p>
        )}
        {draftSlow && !plan && !error && (
          <p role="status" className="text-sm text-inkMuted">
            Your growth strategy is taking longer than usual. We’re still checking and will show it here when it’s ready.
          </p>
        )}
        {draftFailed && !drafting && !error && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rule px-3 py-2 text-sm text-warn dark:text-marigold">
            <CircleAlert className="h-4 w-4" aria-hidden="true" />
            Something went wrong cooking your strategy
            {retryCharged && <span className="text-inkMuted">This try uses your credits.</span>}
            {onRetryDraft && (
              <Button className="ml-auto" disabled={retryingDraft} onClick={onRetryDraft}>
                Try again
              </Button>
            )}
          </div>
        )}
        {error && credit && error === credit.headline ? (
          <CreditRefusalNotice refusal={credit} />
        ) : (error || note) && (
          <p
            role={error ? "alert" : "status"}
            className={error ? "text-sm text-warn dark:text-marigold" : "text-sm text-inkMuted"}
          >
            {error ?? note}
          </p>
        )}
      </div>

      {}
      <section aria-label="Growth brief" className="mt-2">
        <div className="flex flex-wrap items-start justify-between gap-4 compact:gap-3">
          <div className="min-w-0 flex-1 compact:basis-full">
            <p className="truncate text-[13px] font-semibold uppercase tracking-[0.02em] text-inkMuted">
              {`Growth brief for ${companyName} · from Zavi`}
            </p>
            {headlineLoading ? (
              <HeadlineSkeleton />
            ) : (
              <p
                data-testid="headline-text"
                className="mt-1.5 text-[26px] font-extrabold tracking-[-0.01em] text-ink [line-height:32px] compact:text-[22px] compact:[line-height:28px]"
              >
                {bigLine}
              </p>
            )}
            {(nextCheckIn || hogNote) && (
              <p className="mt-1 text-[14px] text-inkMuted">
                {nextCheckIn ? `Next check-in ${nextCheckIn}` : null}
                {nextCheckIn && hogNote ? " · " : null}
                {hogNote && (
                  <button
                    type="button"
                    onClick={() => setNoteOpen(true)}
                    className="font-semibold text-inkSoft underline decoration-rule underline-offset-[3px] hover:text-ink"
                  >
                    Read the full note
                  </button>
                )}
              </p>
            )}
          </div>
          {needsState === "ready" && needsTotal > 0 && !countless && (
            <button
              type="button"
              onClick={() => document.getElementById(NEEDS_ID)?.scrollIntoView?.({ behavior: "smooth", block: "start" })}
              className="mt-1 inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-rule bg-creamDeep pl-1.5 pr-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 compact:mt-0 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']"
            >
              <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-danger/15 px-1.5 text-[12px] font-semibold tabular-nums text-danger dark:bg-danger/20 dark:text-[#ff8a8f]">{needsCount}</span>
              need you
              <ArrowDown className="h-3.5 w-3.5 text-inkMuted" aria-hidden />
            </button>
          )}
        </div>
        {!headlineLoading &&
          (headline.action.kind === "start_run" && setupStep ? (
            <HeadlineRun
              key={headline.action.slug}
              slug={headline.action.slug}
              label={headline.action.label}
              costLabel={platformFor(headline.action.slug).hideRunCost ? null : runCostLabel(runCredits[headline.action.slug] ?? null)}
              onRan={(slug) => {
                setStarted((prev) => new Set(prev).add(slug));
                setWorkKey((k) => k + 1);
              }}
            />
          ) : (
            showAction && (
              <div className="mt-3">
                <PrimaryButton
                  onClick={() => act(headline.action)}
                  href={
                    headline.action.kind === "connect" && FORM_CONNECTORS.has(headline.action.slug)
                      ? connectorSetupHref(headline.action.slug)
                      : undefined
                  }
                >
                  {icon}
                  {headline.action.label}
                </PrimaryButton>
              </div>
            )
          ))}
        {headlineError && (
          <p role="alert" className="mt-2 text-sm text-warn dark:text-marigold">
            {headlineError}
          </p>
        )}
      </section>

      {}
      <MoneyTable />

      <div className="mt-7">
        {}
        <StoryStep
          n={1}
          title="Your goals"
          aside={goalsUnreadable ? undefined : <span className="tabular-nums">{goalCountLabel(activeGoals.length)}</span>}
        >
          {building && activeGoals.length === 0 && !goalsUnreadable ? (
            <GoalsBars ariaLabel="Setting your goals" />
          ) : (
            <SettledSection ready={pillsSettled} skeleton={<GoalsBars ariaLabel="Loading your goals" />}>
              <StoryGoals
                goals={data.goals}
                active={liveGoals}
                pills={settledPills}
                fixes={settledFixes}
                plan={plan}
                detail={data.detail}
                unavailable={goalsUnreadable}
                canEdit={canEdit}
                onEdit={(goal) => setEditing({ goal: editableGoal(goal) })}
                onCreate={(initial) => setEditing({ create: initial })}
                onChanged={onChanged}
                removed={removedGoals}
                onRemovedChange={onRemovedChange}
              />
            </SettledSection>
          )}
        </StoryStep>

        <StoryBecause>held back by…</StoryBecause>

        <StoryStep n={2} title="What's in the way" aside={<StoryWayAside statement={plan?.constraint_statement ?? undefined} onAsk={onAsk} />}>
          {building && !plan?.constraint_statement?.trim() && !data.unreadable.includes("plan") ? (
            <BlockerBars ariaLabel="Working out what's in the way" />
          ) : (
            <StoryWay
              plan={plan}
              planUnavailable={data.unreadable.includes("plan")}
              alsoFix={data.detail?.also_fix}
              goals={activeGoals}
              work={data.goal_work}
              workUnavailable={workUnreadable}
              conflicts={data.constraint_conflicts ?? []}
              building={building}
              onAsk={onAsk}
              canEdit={canEdit}
              onChanged={onChanged}
            />
          )}
        </StoryStep>

        <StoryBecause>so Zavi is…</StoryBecause>

        <StoryStep n={3} title="What Zavi is doing">
          <HeadOfGrowthCard
            key={String(data.head_of_growth?.autopilot === true)}
            part="switch"
            hog={data.head_of_growth}
            unavailable={hogUnreadable}
            channels={data.channels}
            canClaim={canEdit}
            canSwitch={canEdit}
            onChanged={onChanged}
          />
          <div className="mt-3">
            {building && planChannels.length === 0 && !data.unreadable.includes("channels") ? (
              <ChannelsBars ariaLabel="Picking your channels" />
            ) : (
              <SettledSection
                ready={data.unreadable.includes("channels") || workSettled}
                skeleton={<ChannelsBars ariaLabel="Loading your channels" />}
              >
                <GrowthChannels
                  variant="story"
                  lead={<AdBudgetSection variant="story" />}
                  channels={data.channels}
                  bets={bets}
                  moves={data.detail?.growth_moves}
                  unavailable={data.unreadable.includes("channels")}
                  hasLivePlan={hasLivePlan}
                  hasPlan={plan !== null}
                  canEdit={canEdit}
                  canStop={canEdit || role === "member"}
                  savingSlugs={savingSlugs}
                  onToggleAutorun={toggleAutorun}
                  onSetInPlan={setInPlan}
                  onAskZavi={() => void askZavi()}
                  asking={asking}
                  error={channelError}
                  onAsk={onAsk}
                  work={channelWork}
                  autopilot={data.head_of_growth?.autopilot === true}
                  channelLocks={channelLocks}
                />
              </SettledSection>
            )}
          </div>
        </StoryStep>

        <StoryBecause>so far…</StoryBecause>

        <StoryStep n={4} title="What happened" aside={workUnreadable ? undefined : <StoryHappenedAside work={data.goal_work} />}>
          <StoryHappened work={data.goal_work} workUnavailable={workUnreadable} asked={asked} />
        </StoryStep>

        <StoryBecause>to keep going, it needs you…</StoryBecause>

        <StoryStep n={5} id={NEEDS_ID} title="What needs you" tone="needs" last aside={needsAside}>
          <SettledSection
            ready={needsState !== "loading"}
            skeleton={
              <SkeletonBars
                ariaLabel="Loading what needs you"
                minHeight={96}
                bars={[
                  { w: "w-full", h: "h-10" },
                  { w: "w-2/3", h: "h-10" },
                ]}
              />
            }
          >
            {needsState === "failed" && (
              <p role="alert" className="mb-2 flex flex-wrap items-center gap-2 text-[14px] text-warn dark:text-marigold">
                Couldn&apos;t check what needs you.
                <button
                  type="button"
                  onClick={retryNeeds}
                  className="font-semibold text-ink underline decoration-rule underline-offset-2"
                >
                  Try again
                </button>
              </p>
            )}
            {needsState === "ready" && needsTotal === 0 && waiting.questions.length === 0 ? (
              <p className="rounded-2xl border border-rule px-4 py-3.5 text-[14px] text-inkMuted">Nothing needs you right now.</p>
            ) : (
              (waiting.questions.length > 0 || leftForYou.length > 0 || needsMore || waitingMoves.length > 0 || (pending?.total ?? 0) > 0) && (
                <div className="rounded-2xl border border-rule bg-cream">
                  <ul>
                    {urgentRows.map((row) => (
                      <NeedsYouFixRow key={needsRowKey(row)} row={row} label={leftLabel} onChanged={() => void onChanged()} />
                    ))}
                    <WaitingForYou
                      questions={waiting.questions}
                      canAnswer={waiting.canAnswer}
                      queuedCount={waiting.queuedCount}
                      answered={answeredQ}
                      onAnswered={onAnswered}
                      onAsk={onAsk}
                    />
                    {calmRows.map((row) => (
                      <NeedsYouFixRow key={needsRowKey(row)} row={row} label={leftLabel} onChanged={() => void onChanged()} />
                    ))}
                    {needsMore && (
                      <li className="border-t border-rule px-4 py-3 text-[13px] text-inkMuted first:border-t-0">
                        {needsMore.line}{" "}
                        <a href={needsMore.url} className="font-semibold text-ink underline decoration-rule underline-offset-2">
                          Open
                        </a>
                      </li>
                    )}
                    {waitingMoves.map(({ move, actsOn }) => (
                      <li key={move.decision_id} className="border-t border-rule px-4 py-3.5 first:border-t-0">
                        <WaitingMove move={move} actsOn={actsOn} onChanged={onChanged} />
                      </li>
                    ))}
                  </ul>
                  {pending && pending.total > 0 && (
                    <div data-testid="needs-you-review-bar" className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-3 [ul:empty+&]:border-t-0">
                      <span className="text-[13px] text-inkMuted">
                        {countless
                          ? "Nothing runs until you OK it."
                          : pending.total === 1 && !pending.capped
                            ? "1 action waits for your OK."
                            : `${pending.total}${pending.capped ? "+" : ""} actions wait for your OK.`}
                      </span>
                      <PrimaryButton onClick={() => setReviewOpen((v) => !v)}>
                        {reviewOpen ? "Hide list" : countless ? "Review" : `Review all ${pending.total}${pending.capped ? "+" : ""}`}
                      </PrimaryButton>
                    </div>
                  )}
                  {reviewOpen && pending && pending.total > 0 && (
                    <div className="border-t border-rule px-4 pb-3">
                      <GrowthReviewList
                        inChannels={pending.inChannels}
                        focusDecisionId={focusDecisionId}
                        revision={approvalsRevision}
                        onAsk={onAsk}
                        onResolved={() => setWorkKey((k) => k + 1)}
                      />
                    </div>
                  )}
                </div>
              )
            )}
          </SettledSection>
        </StoryStep>
      </div>

      {}
      <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-rule pt-4 text-[13px] text-inkMuted">
        <button
          type="button"
          onClick={() => setKnowOpen(true)}
          className="font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
        >
          What Zavi knows about you
        </button>
        <span>· Company, rivals, data, brand voice</span>
        {health && health.notSyncing > 0 && (
          <span className="rounded-full bg-warnBg px-2 py-0.5 text-[12px] font-semibold text-warn dark:bg-marigold/15 dark:text-marigold">
            {`${health.notSyncing} not syncing`}
          </span>
        )}
      </p>
      {footer && <div className="mt-6">{footer}</div>}

      <StoryDrawer open={knowOpen} title="What Zavi knows about you" onClose={() => setKnowOpen(false)}>
        <p className="text-[13px] text-inkMuted">I plan from this. Fix anything that is wrong.</p>
        <div className="mt-2 divide-y divide-rule">
          <GrowthCompanyCard
            fallbackName={workspace?.tenantName ?? null}
            canEdit={canEdit}
            sourcedFacts={data.detail?.company_facts}
            summary={data.detail?.summary}
            footer={companyFooter}
            onFacts={setFacts}
            addRivalRequest={addRivalRequest}
          />
          <GrowthConnections
            anyMeasured={anyMeasured}
            onConnected={setConnected}
            refreshKey={connectorsKey}
            onHealth={setHealth}
          />
          <GrowthBrandVoice
            data={personalization.data}
            loading={personalization.loading}
            loadError={personalization.error}
            canEdit={canEdit}
            onSave={personalization.save}
            variant="memo"
            editRequest={voiceEditRequest}
          />
        </div>
      </StoryDrawer>

      <StoryDrawer open={noteOpen} title="Latest note from Zavi" onClose={() => setNoteOpen(false)}>
        <HeadOfGrowthCard
          key={`note-${String(data.head_of_growth?.autopilot === true)}`}
          part="note"
          hog={data.head_of_growth}
          unavailable={hogUnreadable}
          channels={data.channels}
          canClaim={canEdit}
          onChanged={onChanged}
        />
      </StoryDrawer>

      {editing !== null && (
        <Portal>
          <div className="workspace-shell">
            <GoalEditor
              key={"goal" in editing ? editing.goal.id : "new"}
              goal={"goal" in editing ? editing.goal : null}
              initialObjective={"create" in editing ? editing.create : undefined}
              onClose={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null);
                await onChanged();
              }}
              onPause={"goal" in editing ? () => pauseGoal(editing.goal.id) : undefined}
              history={
                editingGoal ? (
                  <GoalHistory
                    goal={editingGoal}
                    format={(v) => formatGoalNumber(editingGoal.target_metric, v)}
                    onAsk={onAsk}
                  />
                ) : undefined
              }
            />
          </div>
        </Portal>
      )}
    </div>
  );
}

function HeadlineRun({
  slug,
  label,
  costLabel,
  onRan,
}: {
  slug: string;
  label: string;
  costLabel: string | null;
  onRan: (slug: string) => void;
}) {
  const { press, busy, fired, blocked, error, credit } = useChannelRunPress({
    slug,
    onRan: () => onRan(slug),
  });
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={() => void press()} disabled={blocked}>
          <Play className="h-4 w-4" aria-hidden="true" />
          {busy ? "Starting…" : label}
        </PrimaryButton>
        {!fired && costLabel && <span className="text-[13px] text-inkMuted">{costLabel}</span>}
      </div>
      {error && credit && error === credit.headline ? (
        <CreditRefusalNotice refusal={credit} className="mt-2" />
      ) : (
        error && (
          <p role="alert" className="mt-2 text-sm text-warn dark:text-marigold">
            {error}
          </p>
        )
      )}
    </>
  );
}

function HeadlineSkeleton() {
  return <HeadlineBars ariaLabel="Checking what needs you" />;
}
