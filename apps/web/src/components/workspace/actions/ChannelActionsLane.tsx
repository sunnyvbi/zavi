"use client";

import { cardButton, cardLink } from "./card/styles";
import { useTabHidden } from "../layout/tabHidden";
import { AnalyticsPortal } from "../layout/channelPage";
import { ChannelBalance } from "./managed-campaigns/ChannelBalance";
import { announceEmailCardChanged } from "@/lib/workspace/emailCardEvents";
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActionsEmpty,
  HeldCardsQueued,
  StaleSignupBanner,
  type ChannelRunInfo,
} from "../layout/ChannelEmptyStates";
import { ATTENTION_CHANGED_EVENT } from "@/lib/workspace/needsYou";
import { ApiError, releaseHeldChannelActions, signupPreviewWeeks, type ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ChannelDetail } from "../layout/channelDetail";
import { rankChannelCards } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { markChannelSeen } from "@/lib/workspace/channelSeen";
import { CHECK_CARD_PREFIX } from "../agent/legacyChannelActions";
import { channelCardPool } from "./channelCardPool";
import { ActionSection, type KindGroup } from "./ActionSection";
import { ChannelActionCard } from "./ChannelActionCard";
import { usePendingCampaignReview } from "./managed-campaigns/campaignReviewRequest";
import { groupByTarget, type LaneEntry } from "./cardGroups";
import { ChannelPlanBlock } from "./ChannelPlanBlock";
import { movePlanDay } from "./ChannelSchedule";
import { AlsoConnect, ConnectCard, connectFirst, connectable } from "./ChannelDashboard";
import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { ChannelFitPill, ChannelValueLine, type ChannelFit } from "./ChannelValueLine";
import { platformFor } from "./platforms";
import { cardKind, kindBuckets, kindPlural } from "./registry";
import { execInFlight, type ActionHandlers, type ActionItem } from "./types";
import { showsAccountSnapshot } from "./platformSpec";
import { legacyApprovalHandlers } from "../agent/legacyChannelActions";
import { useChannelHistoryRead, type ChannelHistoryState } from "./useChannelHistory";
import { storeUnresolved, useChannelActions } from "./useChannelActions";
import { ChannelRefreshLine, useChannelReadFailure } from "../layout/ChannelRefresh";
import { useChannelChatOpener } from "./channelChat";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "./channelPlanLock";
import { TopActionsRow } from "./topActions/TopActionsRow";
import { APPROVALS_CHANGED_EVENT, CHANNEL_ACTIONS_CHANGED_EVENT, CHANNEL_RUN_STARTED_EVENT, askTopActionAgain, forgetChannelRun, readTopActionRun, recentChannelRun, recentChannelRunStart } from "./topActions/api";
import { ChannelRunPressLatchContext, announceChannelRunEnded, recallRunId } from "../layout/useChannelRunPress";
import { StartersPanel, useStarterRun } from "./StartersPanel";
import { CookingCard } from "../layout/ChannelEmptyCard";
import { CHANNEL_CARD_PARAM } from "../navigation/workspaceRoutes";
import { fetchDecision } from "@/lib/approvals/decisionApi";
import { LiveDecisionCard } from "@/components/agents/LiveDecisionCard";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { STATIC_TITLES, type StaticKind } from "../layout/shared";

const DECISION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function markCheckDone(
  slug: string,
  key: string,
  refresh: () => void | Promise<void>,
  setNotice: (n: string | null) => void,
  hide: (hidden: boolean) => void,
): Promise<boolean> {
  setNotice(null);
  hide(true);
  try {
    const res = await apiFetch(`/api/channels/${slug}/checks/${encodeURIComponent(key)}/done`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Could not save that. (HTTP ${res.status})`);
  } catch (e) {
    hide(false);
    setNotice((e as Error).message);
    return false;
  }
  await refresh();
  return true;
}

export type PriorRows = {
  ids: readonly string[];
  render: (ids: readonly string[]) => ReactNode;
};

export function switchSignal(
  couldBeSwitched: boolean,
  history: ChannelHistoryState,
): boolean | "unknown" {
  if (!couldBeSwitched) return false;
  if (history.state === "loading" || history.state === "idle") return "unknown";
  if (history.state === "error") return false;
  return history.history.pre_switch.length > 0;
}

const LIVE_POLL_MS = 20_000;

const RUN_WATCH_MS = 20 * 60 * 1000;
const RUN_STATUS_POLL_MS = 5_000;
const RUN_STALL_MS = 10 * 60 * 1000;
const RUN_ECHO_MS = 60_000;
const RUN_STILL_GOING = new Set(["queued", "pending", "dispatched", "running", "in_progress", "started", "blocked", "paused_awaiting_child"]);
const RUN_QUIET_END = new Set(["success", "paused_awaiting_approval"]);

const EXEC_FAST_MS = 2 * 60 * 1000;
const EXEC_WATCH_MS = 20 * 60 * 1000;

export function execPollDelay(sinceMs: number): number {
  if (sinceMs < EXEC_FAST_MS) return 3_000;
  if (sinceMs < EXEC_WATCH_MS) return 10_000;
  return 60_000;
}

export function preSwitchCount(history: ChannelHistoryState): number {
  return history.state === "ready" ? history.history.pre_switch.length : 0;
}

const OVERVIEW_HOLD_MS = 3000;

function OverviewLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="pt-5">
      <span className="sr-only">Reading what is waiting on this channel</span>
      <div aria-hidden className="flex items-center gap-3">
        <span className="size-5 animate-pulse rounded-md bg-ca-subtle [animation-duration:1.6s] motion-reduce:animate-none" />
        <span className="h-5 w-56 max-w-[60%] animate-pulse rounded-md bg-ca-subtle [animation-duration:1.6s] motion-reduce:animate-none" />
      </div>
      <div data-testid="channel-overview-loading" aria-hidden className="mt-5 grid gap-3">
        {["w-[38%]", "w-[52%]"].map((w) => (
          <div key={w} className="flex items-center gap-3.5 rounded-2xl border border-ca-border px-4 py-4">
            <span className="size-9 shrink-0 animate-pulse rounded-[10px] bg-ca-subtle [animation-duration:1.6s] motion-reduce:animate-none" />
            <span className="min-w-0 flex-1">
              <span className={`block h-3.5 ${w} animate-pulse rounded-md bg-ca-subtle [animation-duration:1.6s] motion-reduce:animate-none`} />
              <span className="mt-2 block h-3 w-[70%] animate-pulse rounded-md bg-ca-subtle [animation-duration:1.6s] motion-reduce:animate-none" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function laneKinds(
  entries: readonly LaneEntry<ActionItem>[],
  taken: readonly string[],
  openKinds: ReadonlySet<string>,
  onToggle: (kind: string) => void,
  platform?: { postsNoun?: string },
): KindGroup[] {
  const lead = (e: LaneEntry<ActionItem>) => (e.kind === "group" ? e.members[0]! : e.card);
  return kindBuckets(entries, (e) => cardKind(lead(e))).map((b) => ({
    kind: b.kind,
    label: kindPlural(b.kind, platform),
    entries: b.entries,
    lead: taken.includes(b.kind) ? 0 : 1,
    open: openKinds.has(b.kind),
    onToggle: () => onToggle(b.kind),
  }));
}

export function cardsOnScreen(kinds: readonly KindGroup[]): ActionItem[] {
  return kinds
    .flatMap((g) => (g.open ? g.entries : g.entries.slice(0, g.lead)))
    .flatMap((e) => (e.kind === "group" ? e.members : [e.card]));
}

export function ChannelActionsLane({
  slug,
  legacy,
  workState,
  lastRunAt,
  planIntent = null,
  planRationale = null,
  fit = null,
  hasStrategy = false,
  actionCount,
  connected,
  publishReady = false,
  surfaceOff = false,
  hasConnectors,
  connectors,
  linkedConnectors,
  extraCards,
  children,
  prior,
  chatStaged,
  onPainted,
}: {
  slug: string;
  legacy: ReactNode;
  workState: ChannelDetail["workState"];
  lastRunAt: string | null;
  planIntent?: string | null;
  planRationale?: string | null;
  fit?: ChannelFit | null;
  hasStrategy?: boolean;
  actionCount: number;
  connected: boolean;
  publishReady?: boolean;
  surfaceOff?: boolean;
  hasConnectors: boolean;
  connectors?: readonly string[];
  linkedConnectors?: readonly string[];
  extraCards?: {
    cards: ReactNode[];
    more?: ReactNode[];
    metrics?: ChannelMetric[];
    settled?: boolean;
    position: "before" | "after";
    notice?: string | null;
    kinds?: string[];
    reload?: () => void;
  };
  children: ReactNode;
  prior?: PriorRows;
  chatStaged?: PriorRows;
  onPainted?: (slug: string) => void;
}) {
  const runPressLatch = useRef(new Set<string>());
  const [payload, setPayload] = useState<unknown>(null);
  const platformRow = platformFor(slug);
  const platform = platformRow.accountFromPayload ? { ...platformRow, account: platformRow.accountFromPayload(payload) ?? platformRow.account } : platformRow;
  const channel = useChannelActions(slug, { all: true });
  const starter = useStarterRun(slug, Boolean(platform.starters));
  const openChat = useChannelChatOpener();
  const planLock = useChannelPlanLock();
  const couldBeSwitched =
    channel.store === "channel_actions" && channel.actions.length === 0;
  const historyRead = useChannelHistoryRead(slug, { enabled: couldBeSwitched });
  const history = historyRead.history;

  const { reload: reloadChannel } = channel;
  const { reload: reloadHistory } = historyRead;
  const retryReads = useCallback(() => {
    reloadChannel();
    reloadHistory();
  }, [reloadChannel, reloadHistory]);
  const inlineRefresh = useChannelReadFailure(channel.failed || historyRead.failed, retryReads);
  const unresolved = storeUnresolved(channel);
  const [pressedAt, setPressedAt] = useState<string | null>(null);
  const pressedAtRef = useRef<string | null>(null);
  const listRead = useRef(false);
  if (!channel.loading) listRead.current = true;

  const hasCards = channel.actions.length > 0;
  const seenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!hasCards || seenFor.current === slug) return;
    seenFor.current = slug;
    const ctl = new AbortController();
    let settled = false;
    void markChannelSeen(slug, ctl.signal).then((outcome) => {
      settled = outcome !== "aborted";
    });
    return () => {
      ctl.abort();
      if (!settled && seenFor.current === slug) seenFor.current = null;
    };
  }, [hasCards, slug]);

  const [watchUntil, setWatchUntil] = useState<number | null>(() => {
    const at = recentChannelRunStart(slug, RUN_WATCH_MS);
    return at === null ? null : at + RUN_WATCH_MS;
  });
  const [startedHereAt, setStartedHereAt] = useState<string | null>(() => {
    const at = recentChannelRunStart(slug, RUN_WATCH_MS);
    return at === null ? null : new Date(at).toISOString();
  });
  const [watchRun, setWatchRun] = useState<string | null>(() => recentChannelRun(slug, RUN_WATCH_MS)?.runId ?? null);
  const [blindStart, setBlindStart] = useState(() => {
    const r = recentChannelRun(slug, RUN_WATCH_MS);
    return r !== null && r.runId === null;
  });
  const [runEnd, setRunEnd] = useState<"failed" | "slow" | null>(null);
  const refreshPayload = useRef<() => void>(() => {});
  const reloadRef = useRef(channel.reload);
  reloadRef.current = channel.reload;
  useEffect(() => {
    const started = (e: Event) => {
      const detail = (e as CustomEvent<{ slug?: string; fromLane?: boolean }>).detail;
      if (detail?.slug !== slug || detail.fromLane) return;
      setWatchUntil(Date.now() + RUN_WATCH_MS);
      setStartedHereAt(new Date().toISOString());
      const runId = recentChannelRun(slug, RUN_WATCH_MS)?.runId ?? null;
      setWatchRun(runId);
      setBlindStart(runId === null);
      setRunEnd(null);
      reloadRef.current();
    };
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
    return () => window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  }, [slug]);
  const tabHidden = useTabHidden();
  const refreshSilentRef = useRef(channel.refreshSilent);
  refreshSilentRef.current = channel.refreshSilent;
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug !== slug) return;
      void refreshSilentRef.current();
    };
    window.addEventListener(CHANNEL_ACTIONS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CHANNEL_ACTIONS_CHANGED_EVENT, changed);
  }, [slug]);
  const missed = channel.missed;
  const missId = missed ? `${missed.run_id}:${missed.at}` : null;
  const missStoreKey = `zavi:top-action-miss-closed:${slug}`;
  const [missClosed, setMissClosed] = useState<string | null>(() => {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(missStoreKey);
    } catch {
      return null;
    }
  });
  const closeMiss = () => {
    if (!missId) return;
    setMissClosed(missId);
    try {
      window.localStorage.setItem(missStoreKey, missId);
    } catch {
      return;
    }
  };
  const missSuperseded = Boolean(
    missed && [...channel.actions, ...channel.completed].some((a) => a.email_card && Date.parse(a.proposed_at) > Date.parse(missed.at)),
  );
  const showMiss = Boolean(missed && missId !== missClosed && !missSuperseded);
  useEffect(() => {
    if (!missed || !startedHereAt || Date.parse(missed.at) < Date.parse(startedHereAt)) return;
    setWatchUntil(null);
  }, [missed, startedHereAt]);
  const cardKey = [...channel.actions, ...channel.completed]
    .map((a) => a.id)
    .concat(prior?.ids ?? [], chatStaged?.ids ?? [])
    .sort()
    .join("|");
  const freshKey = channel.actions
    .filter((a) => a.status === "pending" && a.channel_slug === slug)
    .map((a) => a.id)
    .concat(prior?.ids ?? [], chatStaged?.ids ?? [])
    .sort()
    .join("|");
  const idsAtStart = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (watchUntil === null || !blindStart) {
      idsAtStart.current = null;
      return;
    }
    if (channel.loading) return;
    const now = new Set(cardKey ? cardKey.split("|") : []);
    if (idsAtStart.current === null) {
      idsAtStart.current = now;
      return;
    }
    const seen = idsAtStart.current;
    if (freshKey && freshKey.split("|").some((id) => !seen.has(id))) {
      idsAtStart.current = null;
      setWatchUntil(null);
    }
  }, [cardKey, freshKey, watchUntil, blindStart, channel.loading]);
  const [runEnded, setRunEnded] = useState<{ serverAt: number; state: ChannelDetail["workState"]; at: number } | null>(null);
  const prevWorkState = useRef(workState);
  const wasStale = useRef(false);
  const [settlingRun, setSettlingRun] = useState(false);
  const reloadExtraRef = useRef(extraCards?.reload);
  reloadExtraRef.current = extraCards?.reload;
  useEffect(() => {
    const was = prevWorkState.current;
    prevWorkState.current = workState;
    if (was === "running" && workState !== "running" && !wasStale.current) {
      setWatchUntil(null);
      setStartedHereAt(null);
      setSettlingRun(true);
      reloadExtraRef.current?.();
      void refreshSilentRef.current().finally(() => setSettlingRun(false));
    }
  }, [workState]);
  const runStartedHere = watchUntil !== null;
  const parentRunAt = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  const watchedRunAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!runStartedHere || workState !== "running" || !(parentRunAt > watchedRunAt.current)) return;
    watchedRunAt.current = parentRunAt;
  }, [runStartedHere, workState, parentRunAt]);
  useEffect(() => {
    if (!runEnded || workState === "running" || !(parentRunAt > runEnded.serverAt)) return;
    setRunEnded({ ...runEnded, serverAt: parentRunAt });
  }, [runEnded, workState, parentRunAt]);
  const parentStale =
    workState === "running" &&
    runEnded !== null &&
    (Number.isFinite(runEnded.serverAt) ? !(parentRunAt > runEnded.serverAt) : Date.now() - runEnded.at < RUN_ECHO_MS);
  useEffect(() => {
    if (!runEnded || !parentStale || Number.isFinite(runEnded.serverAt) || !Number.isFinite(parentRunAt)) return;
    setRunEnded({ ...runEnded, serverAt: parentRunAt });
  }, [runEnded, parentStale, parentRunAt]);
  useEffect(() => {
    wasStale.current = parentStale;
  });
  const parentRunning = workState === "running" && !parentStale;
  const runInFlight = parentRunning || runStartedHere;
  const writingHere = runStartedHere && watchRun !== null;
  useEffect(() => {
    if (!writingHere || !watchRun || tabHidden) return;
    let over = false;
    let reading = false;
    const check = async () => {
      if (over || reading) return;
      reading = true;
      let r: Awaited<ReturnType<typeof readTopActionRun>>;
      try {
        r = await readTopActionRun(slug, watchRun);
      } catch (e) {
        if (!over && e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410)) {
          over = true;
          forgetChannelRun(slug, watchRun);
          setWatchUntil(null);
          setWatchRun(null);
          setRunEnd(null);
          void refreshSilentRef.current();
        }
        return;
      } finally {
        reading = false;
      }
      if (over || RUN_STILL_GOING.has(r.status)) return;
      over = true;
      const filed = Array.isArray(r.actions) && r.actions.length > 0;
      forgetChannelRun(slug, watchRun);
      setWatchUntil(null);
      setWatchRun(null);
      setRunEnd(RUN_QUIET_END.has(r.status) || filed ? null : "failed");
      setSettlingRun(true);
      void refreshSilentRef.current().finally(() => setSettlingRun(false));
      window.dispatchEvent(new CustomEvent(APPROVALS_CHANGED_EVENT));
    };
    const onAttention = () => void check();
    void check();
    const id = setInterval(() => void check(), RUN_STATUS_POLL_MS);
    window.addEventListener(ATTENTION_CHANGED_EVENT, onAttention);
    return () => {
      over = true;
      clearInterval(id);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, onAttention);
    };
  }, [writingHere, watchRun, slug, tabHidden]);
  const emailLane = platform.headTools === "email_campaign";
  const { refreshSilent: refreshRunEnd } = channel;
  useEffect(() => {
    if (watchUntil === null || tabHidden) return;
    const watchFrom = watchUntil - RUN_WATCH_MS - 5_000;
    let stopped = false;
    let stalled = false;
    const id = setInterval(() => {
      const pinned = recallRunId(slug);
      if (!pinned || pinned.at < watchFrom) return;
      readTopActionRun(slug, pinned.id)
        .then((r) => {
          if (stopped) return;
          if (r.status === "queued" || r.status === "running") {
            if (stalled || Date.now() - pinned.at < RUN_STALL_MS) return;
            stalled = true;
            setRunEnd("slow");
            refreshPayload.current();
            window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
            return;
          }
          if (recallRunId(slug)?.id !== pinned.id) return;
          forgetChannelRun(slug, pinned.id);
          setWatchUntil((w) => (w === watchUntil ? null : w));
          setRunEnded({ serverAt: watchedRunAt.current, state: r.status === "success" ? "delivered" : "needs_review", at: Date.now() });
          setRunEnd(null);
          runPressLatch.current.delete(slug);
          announceChannelRunEnded(slug);
          setSettlingRun(true);
          void refreshRunEnd().finally(() => setSettlingRun(false));
          refreshPayload.current();
          window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
        })
        .catch(() => undefined);
    }, RUN_STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [watchUntil, slug, refreshRunEnd, tabHidden]);
  const execSignature = channel.actions
    .filter(execInFlight)
    .map((a) => `${a.id}:${a.exec_status}`)
    .sort()
    .join("|");
  const emailsWatched = useRef<{ moving: Set<string>; done: Set<string> } | null>(null);
  const emailMoving = channel.actions.filter((a) => a.email_card === true && execInFlight(a)).map((a) => a.id).sort().join("|");
  const emailDone = channel.completed.filter((a) => a.email_card === true).map((a) => a.id).sort().join("|");
  const emailListRead = !channel.loading;
  useEffect(() => {
    if (!emailListRead) return;
    const moving = new Set(emailMoving ? emailMoving.split("|") : []);
    const done = new Set(emailDone ? emailDone.split("|") : []);
    const was = emailsWatched.current;
    emailsWatched.current = { moving, done };
    if (!was) return;
    const landed = new Set([...was.moving].filter((id) => !moving.has(id)));
    done.forEach((id) => {
      if (!was.done.has(id)) landed.add(id);
    });
    landed.forEach((id) => announceEmailCardChanged({ rail: "channel_actions", id, source: "channel-lane" }));
  }, [emailListRead, emailMoving, emailDone]);
  const execSince = useRef<number>(0);
  useEffect(() => {
    execSince.current = Date.now();
  }, [execSignature]);
  const [execKick, setExecKick] = useState(0);
  const resumeExecWatch = useCallback(() => {
    execSince.current = Date.now();
    setExecKick((k) => k + 1);
  }, []);
  const cardExecuting = execSignature !== "";
  const { refreshSilent } = channel;
  const reloadExtra = extraCards?.reload;
  useEffect(() => {
    if (!runInFlight || tabHidden) return;
    const id = setInterval(() => {
      if (watchUntil !== null && Date.now() > watchUntil) {
        setWatchUntil(null);
        if (watchRun !== null || slug === "linkedin_ads") {
          setWatchRun(null);
          setRunEnd("slow");
        }
        refreshPayload.current();
        return;
      }
      if (!cardExecuting) {
        void refreshSilent();
        reloadExtra?.();
      }
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [runInFlight, cardExecuting, watchUntil, watchRun, slug, refreshSilent, reloadExtra, tabHidden]);
  useEffect(() => {
    if (!cardExecuting || tabHidden) return;
    void refreshSilent();
    let id: ReturnType<typeof setTimeout>;
    const next = () => {
      id = setTimeout(() => {
        void refreshSilent();
        next();
      }, execPollDelay(Date.now() - execSince.current));
    };
    next();
    return () => clearTimeout(id);
  }, [cardExecuting, execSignature, execKick, refreshSilent, tabHidden]);

  const wantsDashboard = Boolean(platform.kpiFallback || platform.extras?.length);
  const [dashboardSettled, setDashboardSettled] = useState(!wantsDashboard);
  const onDashboardSettled = useCallback(() => setDashboardSettled(true), []);
  const [tablesTail, setTablesTail] = useState<HTMLElement | null>(null);
  const [tablesTop, setTablesTop] = useState<HTMLElement | null>(null);
  const [noticeAt, setNoticeAt] = useState<HTMLElement | null>(null);
  const [showAllCards, setShowAllCards] = useState(false);
  const [openKinds, setOpenKinds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleKind = useCallback(
    (kind: string) =>
      setOpenKinds((prev) => {
        const next = new Set(prev);
        if (next.has(kind)) next.delete(kind);
        else next.add(kind);
        return next;
      }),
    [],
  );
  const onPayload = useCallback((p: unknown, refetch?: () => void) => {
    setPayload(p);
    if (refetch) refreshPayload.current = refetch;
  }, []);
  const onRefetch = useCallback((_p: unknown, refetch?: () => void) => {
    if (refetch) refreshPayload.current = refetch;
  }, []);
  const [stagedBusy, setStagedBusy] = useState<string | null>(null);
  const [published, setPublished] = useState<ReadonlySet<string>>(() => new Set<string>());
  const publishedRef = useRef<Set<string>>(new Set<string>());
  const [dayOverride, setDayOverride] = useState<Readonly<Record<string, {
    day: string | null;
    time: string | null;
    timezone: string | null;
    timed: boolean;
    baseDay: string | null;
    baseTime: string | null;
  }>>>({});
  const movingRef = useRef<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [doneChecks, setDoneChecks] = useState<ReadonlySet<string>>(() => new Set<string>());
  const setCardHidden = (id: string, hidden: boolean) =>
    setDoneChecks((cur) => {
      if (cur.has(id) === hidden) return cur;
      const next = new Set(cur);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  const hideablePool = channelCardPool(platform, payload, channel.actions, published);
  const hideableKey = [...hideablePool.checks, ...hideablePool.staged].map((c) => c.id).join("\n");
  useEffect(() => {
    const present = new Set(hideableKey.split("\n"));
    setDoneChecks((cur) => {
      const keep = [...cur].filter((id) => present.has(id));
      return keep.length === cur.size ? cur : new Set(keep);
    });
  }, [hideableKey]);
  const completedRef = useRef(channel.completed);
  completedRef.current = channel.completed;
  const anchorStop = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!focusId) return;
    setFocusId(null);
    const safe = focusId.replace(/["\\]/g, "\\$&");
    const find = () =>
      document.querySelector<HTMLElement>(`[data-testid="coming-up-item"][data-card-id="${safe}"]`) ??
      document.querySelector<HTMLElement>(`[data-testid="action-${safe}"]`);
    const first = find();
    if (!first) {
      const done = completedRef.current.find((a) => a.id === focusId);
      if (done?.email_card) window.location.assign(`/workspace/email-cards/channel_actions/${encodeURIComponent(done.id)}`);
      return;
    }
    anchorStop.current?.();
    let el: HTMLElement = first;
    const scroller = el.closest(".ws-scroll") ?? document.body;
    const block = (): ScrollLogicalPosition =>
      el.getBoundingClientRect().height > Math.min(scroller.clientHeight || window.innerHeight, window.innerHeight) ? "start" : "center";
    el.scrollIntoView?.({ block: block(), behavior: "smooth" });
    const flash = ["shadow-[0_0_36px_rgba(255,255,255,0.32)]"];
    el.classList.add(...flash);
    let unflash = window.setTimeout(() => el.classList.remove(...flash), 1600);
    const userEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    const offsetOf = () => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    let offset = offsetOf();
    let recentres = 0;
    let settled = false;
    const stop = () => {
      observer?.disconnect();
      window.clearTimeout(settle);
      for (const name of userEvents) window.removeEventListener(name, stop, true);
      if (anchorStop.current === stop) anchorStop.current = null;
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!el.isConnected) {
              const moved = find();
              if (!moved) return stop();
              el = moved;
              offset = Number.NaN;
              if (settled) {
                settled = false;
                recentres = 0;
                settle = window.setTimeout(expire, 4000);
              }
            } else if (settled) return;
            const next = offsetOf();
            if (Math.abs(next - offset) < 1) return;
            offset = next;
            if (++recentres > 8) return stop();
            el.scrollIntoView?.({ block: block() });
            el.classList.add(...flash);
            window.clearTimeout(unflash);
            unflash = window.setTimeout(() => el.classList.remove(...flash), 1600);
          });
    for (const child of Array.from(scroller.children)) observer?.observe(child);
    for (const name of userEvents) window.addEventListener(name, stop, true);
    const expire = () => {
      if (el.dataset.testid === "coming-up-item" || !document.querySelector('[data-testid="coming-up"]')) return stop();
      settled = true;
    };
    let settle = window.setTimeout(expire, 4000);
    anchorStop.current = stop;
  }, [focusId, showAllCards, openKinds]);
  useEffect(() => () => anchorStop.current?.(), []);
  const approvalHandlers = legacyApprovalHandlers({
    setBusy: setStagedBusy,
    setNotice: channel.setNotice,
    refetch: () => {
      channel.reload();
      refreshPayload.current();
    },
    approvedNote: "Posted. It is live on your account now.",
  });
  const [painted, setPainted] = useState(false);
  const [holdExpired, setHoldExpired] = useState(false);
  useEffect(() => {
    setHoldExpired(false);
    const timer = setTimeout(() => setHoldExpired(true), OVERVIEW_HOLD_MS);
    return () => clearTimeout(timer);
  }, [slug]);
  const sourcesSettled = dashboardSettled && (extraCards?.settled ?? true);
  const ready = !channel.loading && (sourcesSettled || holdExpired);
  const [extrasLate, setExtrasLate] = useState(false);
  const firstPaint = useRef(true);
  useEffect(() => {
    if (!ready) return;
    setPainted(true);
    if (firstPaint.current) {
      firstPaint.current = false;
      if (!(extraCards?.settled ?? true)) setExtrasLate(true);
    }
  }, [ready, extraCards?.settled]);
  const holding = !painted && !ready;
  const laneShown = painted || ((platform.isDecisionId || channel.store === "decisions") && !channel.loading);
  useEffect(() => {
    if (laneShown) onPainted?.(slug);
  }, [laneShown, onPainted, slug]);
  const workspace = useWorkspaceOptional();
  const activeTab = workspace?.tabs?.find((t) => t.id === workspace.activeTabId);
  const payloadAction =
    activeTab?.payload.kind === "channels" && activeTab.payload.channel === slug && typeof activeTab.payload.action === "string"
      ? activeTab.payload.action
      : null;
  const [urlAction, setUrlAction] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(CHANNEL_CARD_PARAM),
  );
  const restoredAction = useRef(urlAction ? payloadAction : null);
  if (restoredAction.current !== null && payloadAction !== restoredAction.current) restoredAction.current = null;
  const linkedId = (payloadAction !== restoredAction.current ? payloadAction : null) ?? urlAction;
  const openCardRef = useRef<((id: string) => void) | null>(null);
  const linkDone = useRef(false);
  const linkLookedUp = useRef(false);
  const linkedIdRef = useRef<string | null>(linkedId);
  linkedIdRef.current = linkedId;
  const [linkedDecision, setLinkedDecision] = useState<string | null>(null);
  const linkedDrawn = useRef<string | null>(null);
  const consumedUrl = useRef<string | null>(null);
  useEffect(() => {
    const id = linkedDrawn.current;
    if (!id || linkedDecision !== null) return;
    if (chatStaged?.ids.includes(id) || prior?.ids.includes(id)) return;
    if (typeof document === "undefined" || document.querySelector(`[data-testid="action-${id}"]`)) return;
    linkedDrawn.current = null;
    setLinkedDecision(id);
  });
  useEffect(() => {
    linkDone.current = false;
    linkLookedUp.current = false;
    if (linkedDrawn.current !== (linkedId ?? consumedUrl.current)) linkedDrawn.current = null;
    if (linkedId) setLinkedDecision((cur) => (cur === linkedId ? cur : null));
  }, [linkedId]);
  const consumeUrlLink = (id: string) => {
    if (urlAction === id) consumedUrl.current = id;
    setUrlAction((cur) => (cur === id ? null : cur));
  };
  useEffect(() => {
    if (!linkedId || linkDone.current || !painted || !sourcesSettled) return;
    if (channel.actions.some((a) => a.id === linkedId) || channel.completed.some((a) => a.id === linkedId)) {
      linkDone.current = true;
      openCardRef.current?.(linkedId);
      consumeUrlLink(linkedId);
      return;
    }
    if (linkLookedUp.current || !DECISION_ID_RE.test(linkedId)) return;
    linkLookedUp.current = true;
    const asked = linkedId;
    void fetchDecision(asked).then((got) => {
      if (linkedIdRef.current !== asked || linkDone.current) return;
      consumeUrlLink(asked);
      if (!got.ok) {
        if (!got.notFound) console.warn(`[channel lane] could not look up linked card: ${got.error}`);
        return;
      }
      const home = got.home;
      if (home.kind === "channel" && home.slug === slug) {
        linkDone.current = true;
        const drawn = typeof document !== "undefined" ? document.querySelector(`[data-testid="action-${asked}"]`) : null;
        if (drawn) {
          linkedDrawn.current = asked;
          setFocusId(asked);
          return;
        }
        setLinkedDecision(asked);
        return;
      }
      if (!workspace) return;
      const kind: StaticKind = home.kind === "growth" ? "autopilot" : home.kind === "channel" ? "channels" : "needs-you";
      const payload =
        home.kind === "channel"
          ? { kind: "channels" as const, channel: home.slug, action: linkedId }
          : { kind, decision: linkedId };
      workspace.openTab({ kind, title: STATIC_TITLES[kind], payload: payload as never, dirty: false, pinned: false });
    });
  }, [linkedId, painted, sourcesSettled, channel.actions, channel.completed, slug, workspace]);

  const requestedReview = usePendingCampaignReview();
  const reviewReloaded = useRef<string | null>(null);
  const reviewOpened = useRef<string | null>(null);
  const { reload: reloadActions } = channel;
  useEffect(() => {
    if (!requestedReview) {
      reviewOpened.current = null;
      reviewReloaded.current = null;
      return;
    }
    if (!platform.sponsoredPostReview) return;
    if (channel.actions.some((a) => a.id === requestedReview)) {
      if (reviewOpened.current === requestedReview) return;
      reviewOpened.current = requestedReview;
      openCardRef.current?.(requestedReview);
      return;
    }
    if (reviewReloaded.current === requestedReview) return;
    reviewReloaded.current = requestedReview;
    reloadActions();
  }, [requestedReview, platform.sponsoredPostReview, channel.actions, reloadActions]);

  const inHeading = !surfaceOff && platform.topActionsInHeading === true && showsAccountSnapshot(platform);
  const refreshLine = inlineRefresh ? <ChannelRefreshLine onRetry={retryReads} /> : null;
  const linkedCard = linkedDecision ? (
    <div className="mb-4" data-testid="linked-decision">
      <LiveDecisionCard
        decisionId={linkedDecision}
        title={platform.name}
        surface="channel"
        onResolved={() => channel.reload()}
      />
      <button
        type="button"
        onClick={() => setLinkedDecision(null)}
        className={`mt-2 ${cardLink}`}
      >
        Hide this card
      </button>
    </div>
  ) : null;

  if (platform.isDecisionId || channel.store === "decisions") {
    return (
      <>
        {refreshLine}
        {linkedCard}
        {extraCards && extraCards.cards.length > 0 && (
          <div className="mt-5 flex flex-col gap-4">
            {extraCards.cards}
            {showAllCards && extraCards.more}
            {(extraCards.more?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setShowAllCards((v) => !v)}
                className={`self-start ${cardLink}`}
              >
                {showAllCards ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
        {!surfaceOff && <TopActionsRow slug={slug} channelName={platform.name} actions={platform.topActions} onChanged={() => { channel.reload(); refreshPayload.current(); }} menu={platform.createMenu} direct={platform.createDirect} />}
        {legacy}
      </>
    );
  }

  if (channel.store === "unknown" && !unresolved) return <OverviewLoading />;

  const actingHandlers: ActionHandlers = {
    ...channel.handlers,
    onSetStatus: (...args) => {
      resumeExecWatch();
      return channel.handlers.onSetStatus(...args);
    },
    ...(channel.handlers.onApprove
      ? {
          onApprove: (a: ActionItem) => {
            resumeExecWatch();
            return channel.handlers.onApprove!(a);
          },
        }
      : {}),
  };
  const publish: ActionHandlers["onPublish"] = planLock?.tierName
    ? async () => {
        planLock.upgrade();
        return false;
      }
    : platform.publish ? (action, content) => platform.publish!(action, content, { tenantId: workspace?.tenantId }) : undefined;
  const baseHandlers =
    platform.publish && (connected || publishReady)
      ? { ...actingHandlers, onPublish: publish }
      : actingHandlers;

  const { checks: allChecks, staged: allStaged, stagedIds, liveIds, outdatedActions, operatorNotes, customerActions } = hideablePool;
  const checks = allChecks.filter((c) => !doneChecks.has(c.id));
  const staged = allStaged.filter((c) => !doneChecks.has(c.id));
  const chatStagedIds = chatStaged ? chatStaged.ids.filter((id) => !liveIds.has(id)) : [];
  const priorIds = prior ? prior.ids.filter((id) => !liveIds.has(id)) : null;
  const priorCount = priorIds ? priorIds.length : actionCount;
  const priorRows = prior && priorIds ? prior.render(priorIds) : children;
  const cookingCard = <CookingCard slug={slug} name={platform.name} startedAt={parentRunning ? lastRunAt : startedHereAt ?? pressedAt} />;
  const cooking = unresolved || !listRead.current || !(runInFlight || settlingRun || pressedAt !== null) ? undefined
    : writingHere ? <div role="status" data-testid="top-action-writing">{cookingCard}</div> : cookingCard;
  const refuseStagedRedo = () => {
    channel.setNotice(
      "Zavi cannot rewrite a staged post yet. Edit the text on the card, or dismiss it and ask Zavi in chat for a new one.",
    );
    return Promise.resolve(false);
  };

  const ranked = rankChannelCards([...staged, ...customerActions, ...checks], (c) => stagedIds.has(c.id));
  const readPlan = new Map(ranked.map((c) => [c.id, { day: c.plan_day ?? null, time: c.plan_time ?? null }]));
  const pool = ranked.map((c) => {
    const o = dayOverride[c.id];
    return o && (c.plan_day ?? null) === o.baseDay && (!o.timed || ("plan_time" in c && (c.plan_time ?? null) === o.baseTime))
      ? {
          ...c,
          plan_day: o.day,
          ...(o.timed ? { plan_time: o.time, plan_timezone: o.timezone } : {}),
        }
      : c;
  });
  const extraMore = extraCards?.more ?? [];
  const groupable = (c: ActionItem) => !stagedIds.has(c.id) && !c.id.startsWith(CHECK_CARD_PREFIX);
  const laneEntries: LaneEntry<ActionItem>[] = groupByTarget(pool, groupable);
  const kinds = laneKinds(laneEntries, extrasLate ? [] : (extraCards?.kinds ?? []), openKinds, toggleKind, platform);
  const shown = cardsOnScreen(kinds);
  const hidden = channel.more + (showAllCards ? 0 : extraMore.length);
  const extraShown = extraCards && {
    cards: showAllCards ? [...extraCards.cards, ...extraMore] : extraCards.cards,
    position: extraCards.position,
  };

  const handlers: ActionHandlers = platform.stagedCards
    ? {
        ...baseHandlers,
        inHistory: (a: ActionItem) => !a.id.startsWith(CHECK_CARD_PREFIX) && !stagedIds.has(a.id),
        ...(baseHandlers.onPublish
          ? {
              onPublish: async (a: ActionItem, c: { text: string; thread: string[] | null }) => {
                channel.setNotice(null);
                let posted: boolean;
                try {
                  posted = await baseHandlers.onPublish!(a, c);
                } catch (e) {
                  if (!upgradeOnPlanRefusal(planLock, e)) channel.setNotice((e as Error).message);
                  return false;
                }
                if (posted) {
                  publishedRef.current.add(a.id);
                  if (a.staged_draft_id) publishedRef.current.add(a.staged_draft_id);
                  setPublished(new Set(publishedRef.current));
                  if (a.staged_draft_id) refreshPayload.current();
                }
                return posted;
              },
            }
          : {}),
        onReopen: baseHandlers.onReopen
          ? (a: ActionItem) => (a.id.startsWith(CHECK_CARD_PREFIX) || stagedIds.has(a.id) ? Promise.resolve(false) : baseHandlers.onReopen!(a))
          : undefined,
        onSetStatus: (a, status, opts) =>
          a.id.startsWith(CHECK_CARD_PREFIX)
            ?
              status === "acted"
              ? markCheckDone(
                  slug,
                  a.id.slice(CHECK_CARD_PREFIX.length),
                  () => {
                    channel.reload();
                    refreshPayload.current();
                  },
                  channel.setNotice,
                  (hidden) => setCardHidden(a.id, hidden),
                )
              : baseHandlers.onSetStatus(a, status, opts)
            : stagedIds.has(a.id)
              ?
                status === "acted" && publishedRef.current.has(a.id)
                ? Promise.resolve()
                : (async () => {
                    setCardHidden(a.id, true);
                    const result = await approvalHandlers.onSetStatus(a, status === "acted" ? "rejected" : status, opts);
                    if (result === false) setCardHidden(a.id, false);
                    return result;
                  })()
              : baseHandlers.onSetStatus(a, status, opts),
        onRedo: (a, note, kind) =>
          stagedIds.has(a.id) ? refuseStagedRedo() : kind ? baseHandlers.onRedo(a, note, kind) : baseHandlers.onRedo(a, note),
        ...(openChat
          ? {
              onOpenChat: (a: ActionItem) =>
                stagedIds.has(a.id)
                  ? openChat({ target: "action", action: a, mode: "ask", onRedo: refuseStagedRedo })
                  : baseHandlers.onOpenChat?.(a),
              onOpenRedoChat: (a: ActionItem) =>
                stagedIds.has(a.id) ? void refuseStagedRedo() : baseHandlers.onOpenRedoChat?.(a),
              onOpenAnswerChat: (a: ActionItem) =>
                stagedIds.has(a.id) ? void refuseStagedRedo() : baseHandlers.onOpenAnswerChat?.(a),
            }
          : {}),
      }
    : baseHandlers;

  const movePlan = async (a: ActionItem, day: string | null, time?: string): Promise<string | null> => {
    if (planLock?.tierName) {
      planLock.upgrade();
      return null;
    }
    if (movingRef.current.has(a.id)) return "Still moving this post.";
    movingRef.current.add(a.id);
    const base = readPlan.get(a.id) ?? { day: null, time: null };
    const timed = "plan_time" in a;
    setDayOverride((o) => ({
      ...o,
      [a.id]: {
        day,
        time: timed ? (time ?? null) : null,
        timezone: a.plan_timezone ?? null,
        timed,
        baseDay: base.day,
        baseTime: base.time,
      },
    }));
    try {
      const held = await movePlanDay(a, day, time);
      setDayOverride((o) => ({
        ...o,
        [a.id]: {
          day: held.plan_day,
          time: timed ? (held.plan_time ?? null) : null,
          timezone: timed ? (held.plan_timezone ?? a.plan_timezone ?? null) : null,
          timed,
          baseDay: base.day,
          baseTime: base.time,
        },
      }));
      void refreshSilent();
      return null;
    } catch (e) {
      setDayOverride((o) => {
        const rest = { ...o };
        delete rest[a.id];
        return rest;
      });
      if (upgradeOnPlanRefusal(planLock, e)) return null;
      return (e as Error).message || "Could not move this post.";
    } finally {
      movingRef.current.delete(a.id);
    }
  };
  const laneHandlers: ActionHandlers = platform.planDayLine === false ? handlers : { ...handlers, onMovePlanDay: movePlan };
  const openCard = (id: string) => {
    if (!shown.some((c) => c.id === id)) {
      const holds = (e: LaneEntry<ActionItem>) => (e.kind === "group" ? e.members.some((m) => m.id === id) : e.card.id === id);
      const g = kinds.find((k) => k.entries.some(holds));
      if (g && !g.open) g.onToggle();
    }
    setFocusId(id);
  };
  openCardRef.current = openCard;

  const run: ChannelRunInfo = {
    slug,
    name: platform.name,
    switched: switchSignal(couldBeSwitched, history),
    priorCount: preSwitchCount(history),
    foldBelow: priorCount > 0,
    onPress: () => {
      pressedAtRef.current = new Date().toISOString();
      setPressedAt(pressedAtRef.current);
    },
    onPressEnd: () => {
      pressedAtRef.current = null;
      setPressedAt(null);
    },
    onRan: () => {
      setBlindStart(false);
      setWatchUntil(Date.now() + RUN_WATCH_MS);
      setStartedHereAt(pressedAtRef.current ?? new Date().toISOString());
      channel.reload();
      window.dispatchEvent(new CustomEvent(CHANNEL_RUN_STARTED_EVENT, { detail: { slug, fromLane: true } }));
    },
  };

  const liveWorkState: ChannelDetail["workState"] =
    runInFlight || settlingRun ? "running" : parentStale && runEnded ? runEnded.state : workState;
  const showConnect = hasConnectors && !connected && !platform.kpiFallback && !!connectors?.[0];
  const liveLastRunAt = parentRunning ? lastRunAt : startedHereAt;

  const staleWeeks = channel.actions.reduce<number | null>((max, a) => {
    const w = signupPreviewWeeks(a);
    return w !== null && (max === null || w > max) ? w : max;
  }, null);

  const heldQueued = (
    <HeldCardsQueued
      count={channel.heldCount}
      name={platform.name}
      onRelease={async () => {
        try {
          await releaseHeldChannelActions(slug);
          channel.reload();
          return true;
        } catch {
          return false;
        }
      }}
    />
  );

  return (
    <ChannelRunPressLatchContext.Provider value={runPressLatch}>
      {refreshLine}
      {linkedCard}
      {holding && <OverviewLoading />}
      {}
      <div
        data-testid="channel-overview"
        hidden={holding}
        className={holding ? "hidden" : "contents"}
      >
        {}
        <AnalyticsPortal>
        <div data-section="analytics" className="flex flex-col gap-10">
        <section aria-label="How the account is doing" data-section="snapshot" hidden={!showsAccountSnapshot(platform)} className={showsAccountSnapshot(platform) ? undefined : "hidden"}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-ca-heading font-semibold tracking-tight text-ca-xdark">How the account is doing</h2>
            {fit && (
              <span data-testid="fit-pill-slot" className="relative top-[2px] inline-flex">
                <ChannelFitPill fit={fit} />
              </span>
            )}
            {inHeading && (
              <TopActionsRow
                inline
                slug={slug}
                channelName={platform.name}
                actions={platform.topActions}
                onApprove={actingHandlers.onApprove}
                onChanged={() => {
                  channel.reload();
                  refreshPayload.current();
                }}
                onStarted={run.onRan}
              />
            )}
          </div>
          {(fit || !platform.hideStrategyPrompt) && <ChannelValueLine fit={fit} hasStrategy={hasStrategy} />}
          <ChannelMetricsRow
            showEmpty={!showConnect}
            slug={slug}
            metrics={extraCards?.metrics?.length ? [...channel.metrics, ...extraCards.metrics] : channel.metrics}
            platform={platform}
            loading={channel.metricsLoading}
            connected={connected}
            hasConnectors={hasConnectors}
            connectors={connectors}
            onSettled={onDashboardSettled}
            tablesInto={tablesTail}
            topInto={tablesTop}
            noticeInto={noticeAt}
            onPayload={platform.stagedCards || platform.accountFromPayload ? onPayload : onRefetch}
            onActionsChanged={channel.reload}
          />
          {}
          {showConnect && connectors && (
            <div className={platform.connect ?? connectFirst(connectors) ? "mt-5" : "mt-2"}>
              <ConnectCard
                slug={slug}
                platform={platform}
                connectors={connectors}
                onConnect={connectFirst(connectors)}
              />
            </div>
          )}
          {}
          {connected && linkedConnectors && connectable(connectors, linkedConnectors).length > 0 && (
            <div className="mt-5">
              <AlsoConnect platform={platform} connectors={connectors} linked={linkedConnectors} />
            </div>
          )}
        </section>
        {}
        <div ref={setTablesTop} data-section="top-items" className="flex flex-col gap-10 empty:hidden" />
        </div>
        </AnalyticsPortal>
        <div ref={setNoticeAt} data-section="read-problem" className="mt-5 empty:hidden" />
        {outdatedActions.length > 0 && <div className="mt-4 text-ca-action text-ca-secondary"><p role="status">Saved recommendations need a refresh for the managed campaign setup. Run this channel again before acting on them.</p><details className="mt-2"><summary>Previous recommendations (read-only)</summary><ul className="mt-2 list-disc pl-5">{outdatedActions.map(a => <li key={a.id}>{a.title}</li>)}</ul></details></div>}
        {operatorNotes.length > 0 && <p role="status" className="mt-4 text-ca-action text-ca-secondary">Zavi needs to complete {operatorNotes.length} setup {operatorNotes.length === 1 ? "check" : "checks"}. Your next steps are listed below; no confirmation is needed for Zavi’s setup work.</p>}
        {channel.notice && (
          <p role="status" className="mt-4 text-ca-action text-ca-secondary">
            {channel.notice}
          </p>
        )}
        {staleWeeks !== null && (
          <StaleSignupBanner run={run} weeks={staleWeeks} running={liveWorkState === "running"} />
        )}
        {platform.newItem && openChat && (
          <div className="mt-4">
            <button
              type="button"
              data-testid="channel-new-item"
              onClick={() => openChat({ target: "channel", draft: { text: platform.newItem!.request, nonce: Date.now() } })}
              className={`${cardButton.base} ${cardButton.primary}`}
            >
              {platform.newItem.label}
            </button>
          </div>
        )}
        {platform.starters && !unresolved && (
          <div className="mt-6">
            <StartersPanel
              slug={slug}
              starter={starter}
              actions={channel.actions}
              running={liveWorkState === "running"}
              onRan={run.onRan}
              onChanged={channel.refreshSilent}
            />
          </div>
        )}
        {!surfaceOff && !inHeading && (
          <TopActionsRow
            slug={slug}
            channelName={platform.name}
            actions={platform.topActions}
            onApprove={actingHandlers.onApprove}
            onChanged={() => {
              channel.reload();
              refreshPayload.current();
            }}
            onStarted={run.onRan}
            menu={platform.createMenu} direct={platform.createDirect}
            leading={platform.campaignWorkspace?.headerBalance ? <ChannelBalance spec={platform.campaignWorkspace} variant="pill" /> : undefined}
          />
        )}
        <div className="mt-8">
          {missed?.repeat && showMiss && (
            <div role="status" data-testid="top-action-miss-repeat" className="mb-6 rounded-2xl border border-ca-border bg-ca-subtle px-5 py-3 text-ca-action text-ca-xdark">
              <p data-testid="top-action-miss-repeat-title" className="font-medium">{missed.repeat.title}</p>
              <p data-testid="top-action-miss-repeat-detail" className="mt-0.5 text-ca-dark">{missed.repeat.detail}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {workspace?.role != null && !isMember(workspace.role) && (
                  <button
                    type="button"
                    data-testid="top-action-miss-change"
                    onClick={() => askTopActionAgain(slug, missed.key, missed.repeat?.inputs)}
                    className={`${cardButton.base} ${cardButton.primary}`}
                  >
                    Change brief
                  </button>
                )}
                <button
                  type="button"
                  data-testid="top-action-miss-cancel"
                  onClick={closeMiss}
                  className={`${cardButton.base} ${cardButton.secondary}`}
                >
                  Cancel
                </button>
              </div>
              {missed.repeat.credits && <p data-testid="top-action-miss-repeat-credits" className="mt-2 text-[12px] leading-4 text-ca-secondary">{missed.repeat.credits}</p>}
            </div>
          )}
          {missed && !missed.repeat && showMiss && (
            <div role="status" data-testid="top-action-miss" className="mb-3 flex items-start gap-3 rounded-2xl border border-ca-border bg-ca-subtle px-5 py-3 text-ca-action text-ca-xdark">
              <div className="min-w-0 flex-1">
                <p>
                  Zavi didn&apos;t write {missed.noun}: {/[.!?…]$/.test(missed.reason) ? missed.reason : `${missed.reason}.`}
                </p>
                {workspace?.role != null && !isMember(workspace.role) && (
                  <button
                    type="button"
                    data-testid="top-action-miss-again"
                    onClick={() => askTopActionAgain(slug, missed.key)}
                    className={`mt-2 ${cardButton.base} ${cardButton.secondary}`}
                  >
                    Try again
                  </button>
                )}
              </div>
              <button
                type="button"
                data-testid="top-action-miss-close"
                onClick={closeMiss}
                className={`shrink-0 ${cardButton.base} ${cardButton.secondary}`}
              >
                Cancel
              </button>
            </div>
          )}
          {extraCards?.notice && (
            <p role="status" className="mb-3 rounded-2xl border border-ca-border bg-ca-subtle px-5 py-3 text-ca-action text-ca-xdark">
              {extraCards.notice}
            </p>
          )}
          <ActionSection
            lead={channel.plan ? [
              <ChannelPlanBlock
                key={channel.plan.id}
                plan={channel.plan}
                channelName={platform.name}
                writing={runStartedHere}
                onChange={async (note) => {
                  const ok = await channel.changePlan(note);
                  if (ok) run.onRan();
                  return ok;
                }}
              />,
            ] : undefined}
            extra={extraShown}
            title={platform.sectionTitle ?? "Next steps"}
            actions={pool}
            completed={channel.completed}
            kinds={kinds}
            platform={platform}
            handlers={laneHandlers}
            busyId={channel.busyId ?? stagedBusy}
            redoState={channel.redoState}
            more={hidden}
            onShowLess={showAllCards && extraMore.length > 0 ? () => setShowAllCards(false) : undefined}
            onShowMore={() => setShowAllCards(true)}
            cooking={cooking}
            emptyGroups={!unresolved}
            keepEmpty={pressedAt !== null && !runInFlight}
            empty={unresolved || writingHere ? null : channel.heldCount > 0 ? heldQueued : (
              <ActionsEmpty
                workState={liveWorkState}
                lastRunAt={liveLastRunAt}
                filteredReason={outdatedActions.length > 0
                  ? "Saved recommendations need a refresh before they can appear as current next steps. See Previous recommendations above."
                  : operatorNotes.length > 0 ? "Only Zavi setup checks are listed right now. No customer action is listed here."
                  : chatStagedIds.length > 0 ? "Pending steps are listed below." : null}
                run={run}
                planIntent={planIntent}
                planRationale={planRationale}
                quietRun={platform.runIsSecondary === true}
                hideCost={platform.hideRunCost === true}
              />
            )}
          />
          {}
          {!unresolved && !writingHere && channel.heldCount > 0 && pool.length + (extraShown?.cards.length ?? 0) > 0 && (
            <div className="mt-4">{heldQueued}</div>
          )}
        </div>
        {}
        {platform.tablesLast && (
          <div ref={setTablesTail} data-section="setup" className="mt-6 flex flex-col gap-6 empty:hidden" />
        )}
        {}
        {!writingHere && runEnd !== null && !(runEnd === "failed" && showMiss) && (
          <div role="status" className="mt-4 flex items-start gap-3 rounded-2xl border border-ca-border bg-ca-subtle px-5 py-3 text-ca-action text-ca-xdark">
            <p data-testid="top-action-run-end" className="min-w-0 flex-1">
              {runEnd === "failed"
                ? "Zavi could not finish this run, so nothing new was added. Try again."
                : "This run may have stopped, or it is taking longer than usual. Nothing new has come back yet. Check back in a few minutes."}
            </p>
            {runEnd === "failed" && (
              <button
                type="button"
                data-testid="top-action-run-end-cancel"
                onClick={() => setRunEnd(null)}
                className={`shrink-0 ${cardButton.base} ${cardButton.secondary}`}
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {chatStagedIds.length > 0 && (
          <ul data-testid="chat-staged" className="mt-4 flex list-none flex-col gap-3 p-0">
            {chatStaged!.render(chatStagedIds)}
          </ul>
        )}
        {}
        <PriorItemsFold count={unresolved ? 0 : priorCount}>{priorRows}</PriorItemsFold>
      </div>
    </ChannelRunPressLatchContext.Provider>
  );
}

export function PriorItemsFold({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  if (count <= 0) return null;
  const rows = Children.toArray(children);
  const isNavOnly = (node: ReactNode) =>
    isValidElement<{ "data-nav-only"?: string }>(node) &&
    node.props["data-nav-only"] !== undefined;
  const navOnly = rows.filter(isNavOnly);
  const verbBearing = rows.filter((node) => !isNavOnly(node));
  return (
    <details
      data-testid="prior-items"
      className="mt-4 rounded-xl border border-ca-border bg-ca-bg px-4 py-3"
    >
      {}
      <summary className="cursor-pointer text-[13px] font-semibold text-ca-xdark">
        Older suggestions ({count})
      </summary>
      <p className="mt-2 text-[13px] leading-5 text-ca-secondary">
        Written before Zavi re-checked this channel. The numbers behind them are
        out of date, so they are read-only here. Run the channel again for fresh
        ones.
      </p>
      {navOnly.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2.5">{navOnly}</ul>
      )}
      {verbBearing.length > 0 && (
        <fieldset disabled className="m-0 mt-3 min-w-0 border-0 p-0">
          <ul className="flex flex-col gap-2.5 opacity-70">{verbBearing}</ul>
        </fieldset>
      )}
    </details>
  );
}
