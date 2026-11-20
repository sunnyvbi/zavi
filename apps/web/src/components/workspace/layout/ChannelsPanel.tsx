"use client";

import { RunStoppedNote } from "@/components/agents/ApprovalBlock";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Inbox, OctagonAlert, PanelRightClose, Wrench } from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import { lockedTierOf, planBadgeLabel, planUpgradeMessage, type LockTier } from "@/lib/workspace/planUpgrade";
import { tierDisplayName, type BillingTerm } from "@/lib/marketing/pricing";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "../actions/channelPlanLock";
import { PlanUpgradeDialog, type PlanWork } from "../PlanUpgradeDialog";
import { isMember } from "@/lib/members";
import { upgradeHash } from "@/lib/workspace/pendingPlan";
import { trackEvent } from "@/lib/analytics/events";
import { platformFor } from "../actions/platforms";
import {
  cx,
  FOCUS_RING,
  IconButton,
  PANEL_HEADER_BOX,
  PANEL_HEADER_TITLE,
  useOpenStatic,
} from "./shared";
import { apiFetch } from "@/lib/api";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { sharedJson } from "@/lib/workspace/sharedRead";
import { cardButton } from "../actions/card/styles";
import { approveDecision, type ApproveExtras } from "@/lib/approvals/approveDecision";
import { toast } from "@/components/ui/toast";
import { followSocialPost, pendingSocialPosts, socialPostFollowActive, socialPostNotice } from "@/lib/workspace/socialPostFollow";
import { followPostInToast } from "../actions/topActions/postToast";
import {
  approve as approveChannelAction,
  redoChannelAction,
  setChannelAction,
} from "@/lib/workspace/channelActionsApi";
import {
  daysOpen,
  decisionTitle,
  dispatchCardHeadline,
  handlerPreview,
  isHighStakesDecision,
  loadedScheduleGuard,
  stakesClassOf,
} from "@/app/approvals/approvalsHelpers";
import type { ColumnChrome } from "./columnChrome";
import { APPROVALS_CHANGED_EVENT, CHANNEL_RUN_STARTED_EVENT, readTopActionContext } from "../actions/topActions/api";
import { ATTENTION_CHANGED_EVENT } from "@/lib/workspace/needsYou";
import { isChannelSlug, SOCIAL_LIMITS, socialLimit, type Channel } from "@zavi/shared";
import {
  actionsByChannel,
  DISPLAY_CHANNELS,
  orderedChannels,
  sortChannelsByAttention,
} from "@/lib/workspace/feedRows";
import { groupByRun, runProgress } from "@/lib/workspace/runGroup";
import { RunActionsDrawer, type RunActionVerb } from "./RunActionsDrawer";
import {
  RECIPE_STEP_CLASS,
  findingBand,
  recipeFindings,
  runBreakdown,
  runCaveat,
  runReadsNotDone,
  runSummary,
  metricLabel,
  recipeStepHeadline,
  singleRecipeStep,
  type RecipeFindingView,
} from "@/lib/workspace/recipeStep";
import { ActionDrawer, type DeliveryMode } from "./ActionDrawer";
import {
  ChannelDetailPage,
  ChannelDrawer,
  type ChannelDetail,
  type ProbeVerdict,
} from "./ChannelDrawer";
import {
  ChannelRow,
  ChannelsPage,
  waitingLabel,
  type ChannelEntry,
} from "./ChannelsPage";
import { LockedChannelPreview } from "./LockedChannelPreview";
import { shouldShowSiteNotice, SiteUnreadableNotice, type SiteReadState } from "./SiteUnreadableNotice";
import { canExecuteChannel, canReadChannel, needYouTally, UPGRADE_TO_START } from "./channelTally";
import { CompactActionRow } from "./ChannelFixes";
import { ClampedText, InlineActionBody, SOCIAL_PUBLISH_CLASS } from "./InlineActionBody";
import { useChannelNotices } from "./useChannelNotices";
import { EmailCampaignCard } from "@/components/email/EmailCampaignCard";
import { EMAIL_CARD_CLASSES } from "@/components/email/emailCardClasses";
import { useChannelChatOpener } from "../actions/channelChat";
import { base as cardBase } from "../agent/cardViews";

export type Decision = {
  id: string;
  decision_class: string;
  body: Record<string, unknown>;
  handler: string | null;
  emitted_at: string;
  agent_slug?: string | null;
  run_stopped?: boolean;
  thread_id?: string | null;
  channel_slug?: string | null;
  run_group?: { run_id: string; position: number; of: number } | null;
  action_source?: "decision" | "channel_action";
  exec_class?: string | null;
  card_kind?: string | null;
  primary_label?: string | null;
  done_label?: string | null;
};

const isChannelAction = (d: Decision) => d.action_source === "channel_action";
type FoldRow = Pick<Decision, "action_source" | "thread_id"> & { decision_class?: string | null };
export const EMAIL_CARD_LINGER_MS = 3000;
export const BOARD_EVENT_COALESCE_MS = 250;
const isEmailCard = (d: FoldRow) => typeof d.decision_class === "string" && EMAIL_CARD_CLASSES.has(d.decision_class);
const isLiveDraft = (d: FoldRow) =>
  (typeof d.thread_id === "string" && d.thread_id.length > 0) ||
  d.decision_class === SOCIAL_PUBLISH_CLASS ||
  d.decision_class === "engineer.ship-pr" ||
  isEmailCard(d);
export const chatStagedItemsOf = <T extends FoldRow>(items: readonly T[]): T[] =>
  items.filter((d) => d.action_source !== "channel_action" && isLiveDraft(d));
export const priorItemsOf = <T extends FoldRow>(items: readonly T[]): T[] =>
  items.filter((d) => d.action_source !== "channel_action" && !isLiveDraft(d));
const isExecutable = (d: Decision) =>
  isChannelAction(d) && typeof d.exec_class === "string" && d.exec_class.length > 0;

const executesOnApprove = (d: Pick<Decision, "decision_class" | "handler">) =>
  d.decision_class === SOCIAL_PUBLISH_CLASS || Boolean(d.handler);

type CloseOutVerb = "approve" | "reject" | "did_it" | "archive" | "snooze";

const CHANNEL_ACTION_VERB: Record<CloseOutVerb, "acted" | "rejected" | "snoozed"> = {
  approve: "acted",
  did_it: "acted",
  reject: "rejected",
  archive: "snoozed",
  snooze: "snoozed",
};

async function writeVerb(d: Decision, verb: CloseOutVerb, extras: ApproveExtras = {}, ownUnverifiedConfirm = false): Promise<{ ok: boolean; status?: number; declined?: boolean } | null> {
  if (isChannelAction(d)) {
    try {
      if (verb === "approve" && isExecutable(d)) await approveChannelAction(d.id);
      else await setChannelAction(d.id, { action: CHANNEL_ACTION_VERB[verb] });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  const post = (path: string) =>
    apiFetch(`/api/approvals/${d.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  if (verb === "did_it" && executesOnApprove(d)) return { ok: false };
  const loaded = loadedScheduleGuard(d).expectedScheduledAt;
  if (verb === "approve" || verb === "did_it") {
    try {
      const r = await approveDecision(d.id, { ...(loaded === undefined ? {} : { expected_scheduled_at: loaded }), ...(verb === "approve" ? extras : {}) }, undefined, { ownUnverifiedConfirm });
      return r ?? { ok: false, declined: true };
    } catch {
      return null;
    }
  }
  return await (verb === "reject" ? post("reject") : post(verb === "archive" ? "archive" : "snooze")).catch(() => null);
}

type TenantChannel = {
  channel_slug: string;
  delivery_mode: DeliveryMode;
  work_state: "idle" | "running" | "needs_review" | "delivered";
  priority: number;
  last_run_at: string | null;
  last_probe_at?: string | null;
  last_probe_delta?: ProbeVerdict | null;
  plan_intent?: string | null;
  plan_rationale?: string | null;
  fit?: { value: "high" | "medium" | "low"; line: string } | null;
  connected?: boolean;
  connectors?: string[];
  linked_connectors?: string[];
  runnable?: boolean;
  locked?: boolean;
  locked_tier?: string | null;
  first_round_open?: boolean;
};

type Group = { channel: Channel; items: Decision[] };

function hasRunBlocks(items: Decision[]): boolean {
  return items.some(
    (d) =>
      runSummary(d.body) !== null ||
      runCaveat(d.body) !== null ||
      runBreakdown(d.body) !== null ||
      runReadsNotDone(d.body).length > 0,
  );
}

function RunBlocks({ items }: { items: Decision[] }) {
  const [blocks] = useState(() => {
    const pick = <T,>(read: (b: Record<string, unknown>) => T | null): T | null =>
      items.map((d) => read(d.body)).find((v) => v !== null) ?? null;
    return {
      summary: pick(runSummary),
      caveat: pick(runCaveat),
      breakdown: pick(runBreakdown),
      reads:
        items.map((d) => runReadsNotDone(d.body)).find((r) => r.length > 0) ?? [],
    };
  });
  const { summary, caveat, breakdown, reads } = blocks;

  if (!summary && !caveat && !breakdown && reads.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-col gap-3 border-t border-rule pt-2.5">
      {}
      {caveat && (
        <div className="border-l-2 border-danger pl-2.5">
          <p className="text-[13px] font-semibold leading-[17px] text-ink">
            {caveat.title}
          </p>
          <p className="mt-0.5 text-[12px] leading-[17px] text-inkMuted">
            {caveat.detail}
          </p>
          {caveat.impact && (
            <p className="mt-1 text-[12px] font-medium leading-[17px] text-ink">
              {caveat.impact}
            </p>
          )}
        </div>
      )}

      {summary && (
        <div className="flex items-baseline gap-2">
          <span className="text-[22px] font-semibold leading-none tracking-[-0.01em] text-ink [font-variant-numeric:tabular-nums]">
            {summary.value}
            {summary.unit ? (
              <span className="ml-0.5 text-[13px] font-medium text-inkMuted">
                {summary.unit}
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 text-[12px] leading-[16px] text-inkMuted">
            <span className="font-medium text-ink">{summary.label}</span>{" "}
            {summary.context}
          </span>
        </div>
      )}

      {breakdown && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-inkLight">
            {breakdown.title}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  {breakdown.columns.map((c, i) => (
                    <th
                      key={c + i}
                      scope="col"
                      className={cx(
                        "border-b border-rule pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-inkLight",
                        i === 0 ? "text-left" : "text-right",
                      )}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {breakdown.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.cells.map((cell, ci) => (
                      <td
                        key={ci}
                        className={cx(
                          "border-b border-rule/60 py-1.5 align-baseline",
                          ci === 0
                            ? "pr-2 text-left text-ink"
                            : "pl-2 text-right text-inkMuted [font-variant-numeric:tabular-nums]",
                        )}
                      >
                        {}
                        {ci === r.cells.length - 1 && r.status ? (
                          <span
                            className={cx(
                              "rounded px-1.5 py-0.5 font-medium",
                              r.status === "pass"
                                ? "bg-successBg text-success"
                                : r.status === "warn"
                                  ? "bg-warnBg text-warn"
                                  : "bg-dangerBg text-danger",
                            )}
                          >
                            {cell}
                          </span>
                        ) : (
                          cell
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {breakdown.note && (
            <p className="mt-1.5 text-[12px] leading-[16px] text-inkMuted">
              {breakdown.note}
            </p>
          )}
        </div>
      )}

      {reads.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[12px] font-medium text-inkMuted">
            {reads.length} {reads.length === 1 ? "read" : "reads"} did not complete
          </summary>
          <ul className="mt-1.5 flex flex-col gap-2">
            {reads.map((r, i) => (
              <li key={i} className="text-[12px] leading-[17px]">
                <span className="font-medium text-ink">{r.what}</span>
                <span className="text-inkMuted">: {r.why}</span>
                {}
                {r.impact && (
                  <span className="block text-inkMuted">{r.impact}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const STATE_LABEL: Record<TenantChannel["work_state"], string | null> = {
  idle: null,
  running: "Working on it",
  needs_review: "Ready for you",
  delivered: "Done",
};

const waitingText = (count: number) =>
  `${waitingLabel(count)} ${count === 1 ? "action" : "actions"} waiting`;

const ageLabel = (iso: string) => {
  const days = daysOpen(iso);
  return days === 0 ? "today" : days === 1 ? "1 day open" : `${days} days open`;
};

const stakesRank = (d: Decision) =>
  isHighStakesDecision(d.decision_class, d.handler, d.body) ? 0 : 1;

type BoardSnapshot = {
  decisions: Decision[];
  pendingCounts: Record<string, number>;
  notDoneByRun: Record<string, number>;
  channels: TenantChannel[];
  tenantTier: string | null;
  hasStrategy: boolean;
  siteRead: SiteReadState | null;
};

let boardCache: BoardSnapshot | null = null;

export const RUNNING_POLL_MS = 10_000;

export function clearChannelBoardCache(): void {
  boardCache = null;
}

function useDecisions(refreshKey: number) {
  const [seed] = useState(() => boardCache);
  const [decisions, setDecisions] = useState<Decision[] | null>(seed?.decisions ?? null);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>(seed?.pendingCounts ?? {});
  const [notDoneByRun, setNotDoneByRun] = useState<Record<string, number>>(seed?.notDoneByRun ?? {});
  const [channels, setChannels] = useState<TenantChannel[]>(seed?.channels ?? []);
  const [tenantTier, setTenantTier] = useState<string | null>(seed?.tenantTier ?? null);
  const [hasStrategy, setHasStrategy] = useState(seed?.hasStrategy ?? false);
  const [siteRead, setSiteRead] = useState<SiteReadState | null>(seed?.siteRead ?? null);
  const [error, setError] = useState(false);
  const loadSeq = useRef(0);
  const approvalsSeq = useRef(0);
  const channelsSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const fresh = seq > 1;
    const [approvals, channelState] = await Promise.all([
      sharedJson<{
        decisions?: Decision[];
        channel_pending_counts?: Record<string, number>;
        run_not_done_counts?: Record<string, number>;
      }>("/api/approvals", { fresh }),
      sharedJson<{
        channels?: TenantChannel[];
        tenant_tier?: string | null;
        has_strategy?: boolean;
        site_read?: SiteReadState;
      }>("/api/channels", { fresh }),
    ]);

    if (approvals && seq > approvalsSeq.current) {
      approvalsSeq.current = seq;
      setDecisions(approvals.decisions ?? []);
      setPendingCounts(approvals.channel_pending_counts ?? {});
      setNotDoneByRun(approvals.run_not_done_counts ?? {});
      setError(false);
    } else if (!approvals && seq > approvalsSeq.current) {
      setError(true);
      setDecisions((d) => d ?? []);
    }
    if (channelState && seq > channelsSeq.current) {
      channelsSeq.current = seq;
      setChannels(channelState.channels ?? []);
      setTenantTier(channelState.tenant_tier ?? null);
      setHasStrategy(channelState.has_strategy === true);
      setSiteRead(channelState.site_read ?? null);
    }
  }, []);
  const boardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueLoad = useCallback(() => {
    if (boardTimer.current !== null) return;
    boardTimer.current = setTimeout(() => {
      boardTimer.current = null;
      void load();
    }, BOARD_EVENT_COALESCE_MS);
  }, [load]);
  useEffect(
    () => () => {
      if (boardTimer.current !== null) clearTimeout(boardTimer.current);
      boardTimer.current = null;
    },
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const keySeen = useRef(refreshKey);
  useEffect(() => {
    if (keySeen.current === refreshKey) return;
    keySeen.current = refreshKey;
    queueLoad();
  }, [refreshKey, queueLoad]);
  useEffect(() => {
    if (decisions === null || error) return;
    boardCache = { decisions, pendingCounts, notDoneByRun, channels, tenantTier, hasStrategy, siteRead };
    registerSessionScopedCache(clearChannelBoardCache);
  }, [decisions, error, pendingCounts, notDoneByRun, channels, tenantTier, hasStrategy, siteRead]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  const anyRunning = channels.some((c) => c.work_state === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => void load(), RUNNING_POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, load]);
  useEffect(() => {
    window.addEventListener(APPROVALS_CHANGED_EVENT, queueLoad);
    window.addEventListener(ATTENTION_CHANGED_EVENT, queueLoad);
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, queueLoad);
    return () => {
      window.removeEventListener(APPROVALS_CHANGED_EVENT, queueLoad);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, queueLoad);
      window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, queueLoad);
    };
  }, [queueLoad]);
  return {
    decisions,
    pendingCounts,
    notDoneByRun,
    setNotDoneByRun,
    channels,
    tenantTier,
    hasStrategy,
    siteRead,
    error,
    reload: load,
    setDecisions,
  };
}

export type PinPosting =
  | { phase: "posting" }
  | { phase: "posted"; url: string | null; leaving?: boolean }
  | { phase: "failed"; message: string }
  | { phase: "uncertain"; message: string }
  | { phase: "slow" };

export const isPinterestPin = (d: Pick<Decision, "decision_class" | "body">): boolean =>
  d.decision_class === SOCIAL_PUBLISH_CLASS && (d.body as { channel?: unknown } | undefined)?.channel === "pinterest_pin";

const isInstagramImage = (d: Pick<Decision, "decision_class" | "body">): boolean =>
  d.decision_class === SOCIAL_PUBLISH_CLASS && d.body?.channel === "instagram_image";

function instagramCaptionError(d: Pick<Decision, "decision_class" | "body">): string | null {
  if (!isInstagramImage(d)) return null;
  const text = (d.body.payload as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || text.length === 0) return "Add a caption before approving.";
  return text.length > SOCIAL_LIMITS.instagram_image.text
    ? `Shorten the caption to ${SOCIAL_LIMITS.instagram_image.text} characters before approving.`
    : null;
}

const followedPostPlatform = (d: Pick<Decision, "decision_class" | "body">): string | null =>
  isPinterestPin(d) ? "Pinterest" : isInstagramImage(d) ? "Instagram" : null;

export const PIN_POSTED_LINGER_MS = 2500;
export const PIN_FADE_MS = 500;

function PinPostingRow({ posting, platform, onDismiss }: { posting: PinPosting; platform: string; onDismiss?: () => void }) {
  const pin = platform === "Pinterest";
  const dismiss = onDismiss && posting.phase !== "posting" && (
    <button type="button" onClick={onDismiss} className={cx(cardButton.base, cardButton.secondary)}>
      Dismiss
    </button>
  );
  if (posting.phase === "posting") {
    return (
      <p role="status" data-testid="pin-posting" className="flex items-center gap-2 text-ca-action font-medium text-ca-secondary">
        <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-ca-border border-t-ca-action motion-reduce:animate-none" />
        Posting to {platform}…
      </p>
    );
  }
  if (posting.phase === "posted") {
    return (
      <div className="flex w-full items-center justify-between gap-3">
        <p role="status" data-testid="pin-posted" className="text-ca-action font-medium text-ca-success">
          ✓ Posted to {platform}
          {posting.url && (
            <a href={posting.url} target="_blank" rel="noopener noreferrer" className="ml-2 font-semibold text-ca-primary underline underline-offset-4 hover:no-underline">
              Open {pin ? "pin" : "post"} ↗
            </a>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <p role="alert" data-testid="pin-post-failed" className="text-ca-action text-ca-danger">
        {posting.phase === "failed"
          ? `Couldn't post: ${posting.message}`
          : posting.phase === "uncertain"
            ? posting.message
            : `Still posting. ${platform} has not answered yet; check ${pin ? "your board" : "your account"} before trying again.`}
      </p>
      {dismiss}
    </div>
  );
}

type PinDraft = { text: string; title: string; board_id: string; link: string };
type PinBoards = { list: Array<{ id: string; label: string }>; failed: boolean };

const PIN_CHECK_LABELS: Array<[string, string]> = [
  ["board", "Board"],
  ["media", "Image"],
  ["link", "Link"],
  ["identity", "Your site"],
];

export function pinUnverifiedReasons(readiness: unknown): string[] {
  const checks = readiness && typeof readiness === "object" ? (readiness as { checks?: unknown }).checks : null;
  if (!checks || typeof checks !== "object") return [];
  return PIN_CHECK_LABELS.flatMap(([key, label]) => {
    const c = (checks as Record<string, { status?: unknown; reason?: unknown } | undefined>)[key];
    if (c?.status !== "unverified") return [];
    return [`${label}: ${typeof c.reason === "string" && c.reason ? c.reason : "Zavi could not check this."}`];
  });
}

function validPinLink(link: string): boolean {
  const v = link.trim();
  if (!v.startsWith("https://") || v.length > 2048) return false;
  try {
    return new URL(v).hostname.length > 0;
  } catch {
    return false;
  }
}

const strField = (v: unknown) => (typeof v === "string" ? v : "");

function pinEdits(payload: Record<string, unknown>, draft: PinDraft): ApproveExtras | undefined {
  const out: ApproveExtras = {};
  if (draft.text !== strField(payload.text)) out.payload_text = draft.text;
  if (draft.title.trim() !== strField(payload.title)) out.title = draft.title.trim();
  if (draft.board_id !== strField(payload.board_id)) out.board_id = draft.board_id;
  if (draft.link.trim() !== strField(payload.link)) out.link = draft.link.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

function decisionHeadline(d: Decision): string {
  const recipe =
    d.decision_class === RECIPE_STEP_CLASS ? recipeStepHeadline(d.body) : null;
  const dispatch = dispatchCardHeadline(d.body);
  const preview = handlerPreview(d.handler, d.body)?.replace(/^[\s→·–—-]+/, "");
  const { verbLabel } = decisionTitle(d.decision_class, d.body);
  return recipe || dispatch?.headline || preview || verbLabel || d.decision_class;
}

function DecisionEmailCard({
  decision,
  channelSlug,
  onApproved,
  onRejected,
}: {
  decision: Decision;
  channelSlug: string;
  onApproved: () => void;
  onRejected: () => void;
}) {
  const openChat = useChannelChatOpener();
  const onAskZavi = openChat
    ? () =>
        openChat({
          target: "action",
          action: { ...cardBase(decision.id, channelSlug, "send_message", decisionHeadline(decision), decision.emitted_at ?? ""), body: {} },
          mode: "ask",
          onRedo: () => Promise.resolve(false),
        })
    : undefined;
  return <EmailCampaignCard rail="decisions" id={decision.id} onApproved={onApproved} onRejected={onRejected} onAskZavi={onAskZavi} />;
}

export function DecisionCard({
  decision,
  channel,
  mode,
  busy,
  onApprove,
  onReject,
  onReview,
  onOpen,
  onOpenChannel,
  posting,
  onDismissPosting,
  error,
  confirmReasons,
}: {
  decision: Decision;
  confirmReasons?: string[];
  channel: Channel;
  mode: DeliveryMode;
  busy: boolean;
  posting?: PinPosting;
  onDismissPosting?: () => void;
  error?: string | null;
  onApprove: (extras?: ApproveExtras) => void;
  onReject: () => void;
  onReview: () => void;
  onOpen: () => void;
  onOpenChannel: () => void;
}) {
  const d = decision;
  const opensChannel = isChannelAction(d) && !isExecutable(d);
  const primaryLabel = d.primary_label?.trim() || "Open";
  const actionLabel = d.body?.action_label;
  const approveLabel =
    isExecutable(d) && typeof actionLabel === "string" && actionLabel.trim()
      ? actionLabel.trim()
      : "Approve";
  const high = isHighStakesDecision(stakesClassOf(d), d.handler, d.body);
  const dispatch = dispatchCardHeadline(d.body);
  const pinBoard =
    d.decision_class === SOCIAL_PUBLISH_CLASS && d.body?.channel === "pinterest_pin"
      ? (() => {
          const b = (d.body?.payload as { board_name?: unknown } | undefined)?.board_name;
          return typeof b === "string" && b.trim() ? b.trim() : "";
        })()
      : null;
  const title = pinBoard === null ? decisionHeadline(d) : "New pin";
  const [draft, setDraft] = useState<PinDraft | null>(null);
  const [boards, setBoards] = useState<PinBoards | null>(null);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  useEffect(() => {
    if (confirmReasons && confirmReasons.length > 0) setConfirming(confirmReasons);
  }, [confirmReasons]);
  const pinPayload = (d.body?.payload ?? {}) as Record<string, unknown>;
  const edits = pinBoard !== null && draft !== null ? pinEdits(pinPayload, draft) : undefined;
  const pinCap = socialLimit("pinterest_pin")?.text ?? 500;
  const titleCap = socialLimit("pinterest_pin")?.title ?? 100;
  const draftInvalid =
    draft !== null &&
    (draft.text.length > pinCap ||
      !draft.text.trim() ||
      !draft.title.trim() ||
      draft.title.trim().length > titleCap ||
      !draft.board_id ||
      !validPinLink(draft.link));
  const unverified = pinBoard !== null ? pinUnverifiedReasons(d.body?.readiness) : [];
  const recheckedOnApprove = edits?.link !== undefined || edits?.board_id !== undefined;
  const openEdit = () => {
    setDraft({ text: strField(pinPayload.text), title: strField(pinPayload.title), board_id: strField(pinPayload.board_id), link: strField(pinPayload.link) });
    readTopActionContext("pinterest_organic", "create_pin")
      .then((c) => {
        const list = (c as { boards?: unknown }).boards;
        setBoards({ list: Array.isArray(list) ? (list as PinBoards["list"]) : [], failed: (c as { boards_error?: unknown }).boards_error === true });
      })
      .catch(() => setBoards({ list: [], failed: true }));
  };
  const approvePin = () => {
    if (unverified.length > 0 && !recheckedOnApprove) setConfirming(unverified);
    else onApprove(edits);
  };
  const boardOptions = (() => {
    const list = boards?.list ?? [];
    const current = strField(pinPayload.board_id);
    return current && !list.some((b) => b.id === current) ? [{ id: current, label: pinBoard || "Current board" }, ...list] : list;
  })();
  const field =
    "h-10 w-full rounded-xl border border-ca-strong bg-ca-bg px-3 text-ca-row text-ca-xdark focus-visible:shadow-ca-focus focus-visible:outline-none";
  const source = channel.name;
  const canAct = mode === "execute";
  const detail = dispatch
    ? `→ ${dispatch.targetLabel}`
    : ageLabel(d.emitted_at);
  const primaryButton = cx(cardButton.base, cardButton.primary);
  const secondaryButton = cx(cardButton.base, cardButton.secondary);
  const waiting = canAct && !opensChannel && !busy && !posting;
  const captionError = instagramCaptionError(d);
  return (
    <li
      data-leaving={posting?.phase === "posted" && posting.leaving ? "" : undefined}
      data-waiting={waiting ? "true" : undefined}
      className={cx(
        "list-none rounded-2xl border border-ca-border bg-ca-bg p-5 transition-[opacity,transform] duration-ca-rise ease-ca-standard motion-reduce:transition-none",
        posting?.phase === "posted" && posting.leaving && "pointer-events-none -translate-y-1 opacity-0",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={!!posting}
        className={cx("w-full rounded-sm text-left focus-visible:shadow-ca-focus focus-visible:outline-none")}
      >
        <span className="block truncate text-ca-eyebrow text-ca-secondary" title={`${source} · ${detail}`}>
          {source} · {detail}
        </span>
        <span className="mt-1.5 block text-ca-title font-semibold tracking-tight text-ca-xdark [overflow-wrap:anywhere]">
          {title}
        </span>
      </button>
      <InlineActionBody
        decision={d}
        editText={draft?.text}
        editFields={draft === null ? undefined : { title: "", link: draft.link.trim(), board_id: draft.board_id }}
        recheck={recheckedOnApprove}
        onEditPost={draft === null ? undefined : (next) => setDraft({ ...draft, text: next.text })}
      />
      {pinBoard !== null && draft !== null && (
        <div data-testid="pin-edit-fields" className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-ca-action font-medium text-ca-secondary">
            <span className="flex items-baseline justify-between">
              Title
              <span className={draft.title.trim().length > titleCap ? "text-ca-danger" : undefined}>{`${draft.title.trim().length} / ${titleCap}`}</span>
            </span>
            <input aria-label="Pin title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={field} />
          </label>
          <label className="flex flex-col gap-1.5 text-ca-action font-medium text-ca-secondary">
            Board
            <select aria-label="Pin board" value={draft.board_id} onChange={(e) => setDraft({ ...draft, board_id: e.target.value })} className={field}>
              {boardOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            {boards === null && <span>Loading your boards…</span>}
            {boards?.failed && <span>Zavi could not load your boards just now. The pin keeps its board.</span>}
          </label>
          <label className="flex flex-col gap-1.5 text-ca-action font-medium text-ca-secondary">
            Link
            <input aria-label="Pin link" type="url" inputMode="url" value={draft.link} onChange={(e) => setDraft({ ...draft, link: e.target.value })} className={field} />
            {!validPinLink(draft.link) && <span className="text-ca-danger">Use a full web address that starts with https://</span>}
          </label>
        </div>
      )}
      {d.run_stopped === true && <RunStoppedNote />}
      {!posting && captionError && <p role="alert" className="mt-2 text-ca-action text-ca-danger">{captionError}</p>}
      {error && (
        <p role="alert" data-testid="pin-approve-error" className="mt-2 text-ca-action text-ca-danger">
          {error}
        </p>
      )}
      {posting ? (
        <div className="mt-4 flex items-center border-t border-ca-border pt-4">
          <PinPostingRow posting={posting} platform={followedPostPlatform(d) ?? channel.name} onDismiss={onDismissPosting} />
        </div>
      ) : pinBoard !== null && confirming !== null ? (
        <div role="alert" data-testid="pin-unverified-confirm" className="mt-4 rounded-xl bg-ca-subtle p-4">
          <p className="text-ca-action font-semibold text-ca-xdark">Zavi could not check everything on this pin</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-ca-action text-ca-xdark">
            {confirming.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-ca-action text-ca-secondary">Post it only if you have checked these yourself.</p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(null)}
              className={secondaryButton}
            >
              Go back
            </button>
            <button
              type="button"
              disabled={busy || draftInvalid}
              onClick={() => {
                setConfirming(null);
                onApprove({ ...(edits ?? {}), confirm_unverified: true });
              }}
              className={primaryButton}
            >
              Post anyway
            </button>
          </div>
        </div>
      ) : (
      <div className={cx("mt-4 flex flex-wrap items-center gap-2 border-t border-ca-border pt-4", pinBoard === null ? "justify-end" : "justify-between")}>
        {pinBoard !== null && (
          <span data-testid="pin-posts-note" className="mr-auto text-ca-action text-ca-secondary">
            Posts to Pinterest when you approve
          </span>
        )}
        {pinBoard !== null && canAct && !opensChannel && (
          <button
            type="button"
            disabled={busy}
            onClick={() => (draft === null ? openEdit() : setDraft(null))}
            className={secondaryButton}
          >
            {draft === null ? "Edit pin" : "Cancel edit"}
          </button>
        )}
        {opensChannel && (
          <button
            type="button"
            onClick={onOpenChannel}
            className={primaryButton}
          >
            {primaryLabel}
          </button>
        )}
        {!opensChannel && !canAct && (
          <button
            type="button"
            onClick={onOpen}
            className={secondaryButton}
          >
            Open
          </button>
        )}
        {!opensChannel && canAct && isInstagramImage(d) && (
          <button type="button" disabled={busy} onClick={onOpen} className={secondaryButton}>
            Edit caption
          </button>
        )}
        {!opensChannel && canAct && (
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className={secondaryButton}
          >
            Reject
          </button>
        )}
        {!opensChannel && canAct && (
          <button
            type="button"
            disabled={busy || !!captionError || draftInvalid}
            onClick={high ? onReview : pinBoard !== null ? approvePin : () => onApprove()}
            className={primaryButton}
          >
            {high ? "Review" : approveLabel}
          </button>
        )}
      </div>
      )}
    </li>
  );
}

function fmtFindingNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

const FINDING_BAR_FILL = {
  pass: "bg-success",
  warn: "bg-warn",
  fail: "bg-danger",
} as const;

function FindingBar({ finding }: { finding: RecipeFindingView }) {
  const band = findingBand(finding);
  if (band === null || finding.numericValue === null || finding.target === null)
    return null;
  const value = finding.numericValue;
  const target = finding.target;
  const span = Math.max(Math.abs(value), Math.abs(target));
  const width = span === 0 ? 100 : Math.max(4, Math.min(100, (Math.abs(value) / span) * 100));
  const unit = finding.unit ? ` ${finding.unit}` : "";
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-4 text-inkMuted">
      <span aria-hidden className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-rule">
        <span
          className={cx("block h-full rounded-full", FINDING_BAR_FILL[band])}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="tabular-nums text-ink">
        {fmtFindingNumber(value)}
        {unit}
      </span>
      <span className="tabular-nums">
        target {fmtFindingNumber(target)}
        {unit}
      </span>
    </p>
  );
}

function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden={!open}
      className={cx(
        "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

export function ChannelsPanel({
  collapsed,
  width,
  onToggle,
  chrome,
  variant = "column",
  inlineRail = false,
  railExtra,
}: {
  collapsed: boolean;
  width?: number;
  onToggle: () => void;
  chrome?: ColumnChrome;
  variant?: "column" | "page";
  inlineRail?: boolean;
  railExtra?: React.ReactNode;
}) {
  const isPage = variant === "page";
  const { approvalsPending, openAgentTab, treeAgents, tenantName, tenantId, currentUserId, role } = useWorkspace();
  const treeLockBySlug = useMemo(
    () => new Map((treeAgents ?? []).map((a) => [a.slug, lockedTierOf(a)])),
    [treeAgents],
  );
  const openStatic = useOpenStatic();
  const {
    decisions,
    pendingCounts,
    notDoneByRun,
    setNotDoneByRun,
    channels,
    tenantTier,
    hasStrategy,
    siteRead,
    error,
    reload,
    setDecisions,
  } = useDecisions(approvalsPending);
  const { unseen, markSeen } = useChannelNotices(currentUserId, tenantName, pendingCounts);
  const [extraCounts, setExtraCounts] = useState<Record<string, number>>({});
  const onExtraCount = useCallback(
    (slug: string, n: number) => setExtraCounts((c) => (c[slug] === n ? c : { ...c, [slug]: n })),
    [],
  );
  const [channelItems, setChannelItems] = useState<Record<string, Decision[]>>({});
  const [loadingChannel, setLoadingChannel] = useState<string | null>(null);
  const failedChannels = useRef(new Set<string>());
  const loadChannelActions = useCallback(async (slug: string) => {
    setLoadingChannel(slug);
    try {
      const res = await apiFetch(
        `/api/approvals?channel=${encodeURIComponent(slug)}`,
      );
      if (!res.ok) throw new Error();
      const data = (await res.json()) as {
        decisions?: Decision[];
        run_not_done_counts?: Record<string, number>;
      };
      failedChannels.current.delete(slug);
      setChannelItems((m) => ({ ...m, [slug]: data.decisions ?? [] }));
      if (data.run_not_done_counts) setNotDoneByRun(data.run_not_done_counts);
    } catch {
      failedChannels.current.add(slug);
    } finally {
      setLoadingChannel((c) => (c === slug ? null : c));
    }
  }, [setNotDoneByRun]);
  const loadedChannelsRef = useRef<string[]>([]);
  loadedChannelsRef.current = Object.keys(channelItems);
  const channelReloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const loadChannelActionsRef = useRef(loadChannelActions);
  loadChannelActionsRef.current = loadChannelActions;
  const queueLoadedChannels = useCallback(() => {
    for (const slug of loadedChannelsRef.current) {
      if (channelReloads.current.has(slug)) continue;
      channelReloads.current.set(
        slug,
        setTimeout(() => {
          channelReloads.current.delete(slug);
          void loadChannelActionsRef.current(slug);
        }, BOARD_EVENT_COALESCE_MS),
      );
    }
  }, []);
  useEffect(() => {
    const pending = channelReloads.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);
  useEffect(() => {
    window.addEventListener(APPROVALS_CHANGED_EVENT, queueLoadedChannels);
    window.addEventListener(ATTENTION_CHANGED_EVENT, queueLoadedChannels);
    return () => {
      window.removeEventListener(APPROVALS_CHANGED_EVENT, queueLoadedChannels);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, queueLoadedChannels);
    };
  }, [queueLoadedChannels]);
  const pendingSeen = useRef(approvalsPending);
  useEffect(() => {
    if (pendingSeen.current === approvalsPending) return;
    pendingSeen.current = approvalsPending;
    queueLoadedChannels();
  }, [approvalsPending, queueLoadedChannels]);
  const [selected, setSelected] = useState<Decision | null>(null);
  const [selectedRun, setSelectedRun] = useState<{
    channel: Channel;
    items: Decision[];
    total: number;
  } | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const busyIdsRef = useRef(new Set<string>());
  const [postEdits, setPostEdits] = useState<Record<string, { text: string; thread?: string[] }>>({});
  const editedDecision = (d: Decision): Decision => isInstagramImage(d) && postEdits[d.id]
    ? { ...d, body: { ...d.body, payload: { ...(d.body.payload as Record<string, unknown>), text: postEdits[d.id].text } } }
    : d;
  const [posting, setPosting] = useState<Record<string, PinPosting>>({});
  const [postingCards, setPostingCards] = useState<Record<string, Decision>>({});
  const postingCardsRef = useRef(postingCards);
  useEffect(() => {
    postingCardsRef.current = postingCards;
  }, [postingCards]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [cardConfirms, setCardConfirms] = useState<Record<string, string[]>>({});

  const sorted = useMemo(() => {
    const live = decisions ?? [];
    const kept = Object.values(postingCards).filter((d) => !live.some((x) => x.id === d.id));
    return [...live, ...kept].sort(
      (a, b) =>
        stakesRank(a) - stakesRank(b) ||
        b.emitted_at.localeCompare(a.emitted_at),
    );
  }, [decisions, postingCards]);

  const heldOrderRef = useRef<Map<string, number> | null>(null);

  const stateBySlug = useMemo(
    () => new Map(channels.map((c) => [c.channel_slug, c])),
    [channels],
  );

  const groups = useMemo<Group[]>(() => {
    const items = actionsByChannel(sorted);
    const pendingBySlug = new Map(
      orderedChannels().map(
        (c) =>
          [c.slug, pendingCounts[c.slug] ?? items.get(c.slug)?.length ?? 0] as const,
      ),
    );
    const workStateBySlug = new Map(
      [...stateBySlug].map(([slug, c]) => [slug, c.work_state] as const),
    );
    const ranked = sortChannelsByAttention(orderedChannels(), {
      pendingBySlug,
      stateBySlug: workStateBySlug,
    });
    const held = heldOrderRef.current;
    const finalOrder = held
      ? [...ranked].sort(
          (a, b) =>
            (held.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
            (held.get(b.slug) ?? Number.MAX_SAFE_INTEGER),
        )
      : ranked;
    if (!held && decisions !== null && !error) {
      heldOrderRef.current = new Map(ranked.map((c, i) => [c.slug, i]));
    }
    return finalOrder.map((channel) => ({
      channel,
      items: items.get(channel.slug) ?? [],
    }));
  }, [sorted, decisions, error, stateBySlug, pendingCounts]);

  const entries = useMemo<ChannelEntry[]>(
    () =>
      groups.map((g) => {
        const state = stateBySlug.get(g.channel.slug);
        const waiting = pendingCounts[g.channel.slug] ?? g.items.length;
        const noticeWaiting = unseen(g.channel.slug, waiting);
        const total = waiting + (extraCounts[g.channel.slug] ?? 0);
        const planLock =
          lockedTierOf(state) ?? treeLockBySlug.get(g.channel.slug) ?? null;
        const lock: ChannelEntry["lock"] = state?.locked
          ? { kind: "soon" }
          : planLock
            ? {
                kind: "plan",
                label: planBadgeLabel(planLock),
                tier: planLock,
                ...(state?.first_round_open === true ? { open: true } : {}),
              }
            : null;
        const readable = canReadChannel({ lock });
        const waitingLine = waitingText(total);
        const running = state?.work_state === "running";
        return {
          channel: g.channel,
          count: g.items.length,
          waiting,
          noticeWaiting,
          running,
          subtitle: running
            ? STATE_LABEL.running
            : lock?.kind === "plan" && !readable
              ? waiting > 0
                ? waitingLine
                : (platformFor(g.channel.slug).description ?? null)
              : noticeWaiting > 0
                ? waitingText(noticeWaiting)
                : total > 0
                  ?
                    waitingText(total)
                  : state
                    ? STATE_LABEL[state.work_state]
                    : null,
          description: platformFor(g.channel.slug).description ?? null,
          lock,
          topAction: (() => {
            const first = (channelItems[g.channel.slug] ?? g.items)[0];
            return readable && first ? decisionHeadline(first) : null;
          })(),
        };
      }),
    [groups, stateBySlug, pendingCounts, extraCounts, treeLockBySlug, channelItems, unseen],
  );

  const tally = needYouTally(entries);
  const total = decisions === null ? 0 : tally.items;
  const upgradeToStart = decisions !== null && tally.lockedOnly;

  const [upgrade, setUpgrade] = useState<{
    feature: string;
    tier: Exclude<LockTier, "free">;
    title?: string;
    work?: PlanWork;
  } | null>(null);
  const planWork = useCallback(
    (tier: Exclude<LockTier, "free">, clicked?: ChannelEntry): PlanWork | undefined => {
      const group = entries.filter(
        (e) => e.lock?.kind === "plan" && e.lock.tier === tier && !canReadChannel(e),
      );
      const total = group.reduce((sum, e) => sum + e.waiting, 0);
      if (total === 0) return undefined;
      return {
        total,
        channels: group.filter((e) => e.waiting > 0).length,
        company: tenantName ?? null,
        clicked:
          clicked && clicked.waiting > 0 && !canReadChannel(clicked)
            ? { name: clicked.channel.name, count: clicked.waiting }
            : undefined,
      };
    },
    [entries, tenantName],
  );
  const goToPlans = useCallback(
    (tier: Exclude<LockTier, "free">, term: BillingTerm = "6mo") => {
      openStatic("settings");
      window.setTimeout(() => {
        window.location.hash = upgradeHash({ tier, term });
      }, 0);
    },
    [openStatic],
  );
  const showUpgrade = useCallback(
    (entry: ChannelEntry, clicked = false) => {
      if (entry.lock?.kind !== "plan") return;
      if (!isMember(role)) {
        if (clicked) trackEvent("pricing_plan_selected", { tier: entry.lock.tier, term: "6mo", location: "paywall", tenant_id: tenantId });
        goToPlans(entry.lock.tier);
        return;
      }
      setUpgrade({
        feature: entry.channel.name,
        tier: entry.lock.tier,
        work: planWork(entry.lock.tier, entry),
      });
    },
    [planWork, role, goToPlans, tenantId],
  );
  const clickUpgrade = useCallback((entry: ChannelEntry) => showUpgrade(entry, true), [showUpgrade]);
  const showPlanUpgrade = useCallback(
    (tier: Exclude<LockTier, "free">, clicked = false) => {
      if (!isMember(role)) {
        if (clicked) trackEvent("pricing_plan_selected", { tier, term: "6mo", location: "paywall", tenant_id: tenantId });
        goToPlans(tier);
        return;
      }
      setUpgrade({
        feature: `${planBadgeLabel(tier)} channels`,
        tier,
        title: `These channels are on the ${planBadgeLabel(tier)}`,
        work: planWork(tier),
      });
    },
    [planWork, role, goToPlans, tenantId],
  );
  const clickPlanUpgrade = useCallback((tier: Exclude<LockTier, "free">) => showPlanUpgrade(tier, true), [showPlanUpgrade]);

  const ensureChannelActions = useCallback(
    (entry: ChannelEntry) => {
      const slug = entry.channel.slug;
      if (
        entry.waiting > entry.count &&
        channelItems[slug] === undefined &&
        loadingChannel !== slug &&
        !failedChannels.current.has(slug)
      )
        void loadChannelActions(slug);
    },
    [channelItems, loadingChannel, loadChannelActions],
  );

  const showChannel = useCallback((entry: ChannelEntry, opened = false) => {
    if (opened) failedChannels.current.delete(entry.channel.slug);
    ensureChannelActions(entry);
    markSeen(entry.channel.slug, entry.waiting);
  }, [ensureChannelActions, markSeen]);

  const channelActions = (slug: string) => {
    const items = channelItems[slug] ?? actionsByChannel(sorted).get(slug) ?? [];
    const kept = Object.values(postingCards).filter((d) => d.channel_slug === slug && !items.some((x) => x.id === d.id));
    return kept.length > 0 ? [...items, ...kept] : items;
  };

  const planGate = (slug: string | null | undefined): ChannelEntry | null =>
    entries.find((e) => e.channel.slug === slug && e.lock?.kind === "plan" && !canExecuteChannel(e)) ?? null;
  const upgradeInstead = (d: Decision): boolean => {
    const gate = planGate(d.channel_slug);
    if (gate) showUpgrade(gate);
    return gate !== null;
  };
  const zaviActsOnApprove = (d: Decision) =>
    isChannelAction(d) ? isExecutable(d) : executesOnApprove(d);

  const review = (d: Decision) => {
    if (upgradeInstead(d)) return;
    if (d.agent_slug && d.thread_id)
      void openAgentTab(d.agent_slug, { threadId: d.thread_id, push: true });
    else if (d.agent_slug) void openAgentTab(d.agent_slug, { push: true });
    else void openAgentTab("operator", { push: true });
  };

  const setBusy = (id: string, on: boolean) => {
    if (on) busyIdsRef.current.add(id);
    else busyIdsRef.current.delete(id);
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const dropDecision = (id: string) => {
    setDecisions((list) => (list ?? []).filter((x) => x.id !== id));
    setChannelItems((m) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter((x) => x.id !== id)])),
    );
  };

  const decide = async (d: Decision, verb: "approve" | "reject", extras?: ApproveExtras) => {
    if (busyIdsRef.current.has(d.id) || postingCardsRef.current[d.id]) return;
    if (verb === "approve" && zaviActsOnApprove(d) && upgradeInstead(d)) return;
    const captionError = verb === "approve" ? instagramCaptionError(editedDecision(d)) : null;
    if (captionError) { setActionError(captionError); return; }
    setBusy(d.id, true);
    setActionError(null);
    setCardErrors((m) => (m[d.id] ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== d.id)) : m));
    const caption = isInstagramImage(d) ? postEdits[d.id]?.text : undefined;
    const res = await writeVerb(d, verb === "approve" ? "approve" : "reject", caption !== undefined ? { ...extras, payload_text: caption } : extras, isPinterestPin(d));
    if (res?.declined) {
      setBusy(d.id, false);
      return;
    }
    const ambiguousApproval = res === null || (res?.status !== undefined && res.status >= 500);
    if ((res?.ok || ambiguousApproval) && verb === "approve" && followedPostPlatform(d)) {
      setBusy(d.id, false);
      void followChannelPost(editedDecision(d));
      return;
    }
    if (res?.ok) {
      dropDecision(d.id);
    } else if (res !== null && verb === "approve" && isPinterestPin(d) && "json" in res) {
      const r = (await (res as Response).json().catch(() => null)) as { error?: { code?: unknown; message?: unknown; unverified?: unknown } } | null;
      const reasons = r?.error?.code === "requires_unverified_confirm" && Array.isArray(r.error.unverified) ? r.error.unverified.filter((x): x is string => typeof x === "string") : [];
      const message = typeof r?.error?.message === "string" ? r.error.message : "Couldn't approve that one. Open it to review.";
      if (reasons.length > 0) setCardConfirms((m) => ({ ...m, [d.id]: reasons }));
      else setCardErrors((m) => ({ ...m, [d.id]: message }));
    } else if (res !== null)
      setActionError(`Couldn't ${verb} that one. Open it to review.`);
    setBusy(d.id, false);
  };

  const followChannelPost = async (d: Decision) => {
    const platform = followedPostPlatform(d);
    if (!platform) return;
    postingCardsRef.current = { ...postingCardsRef.current, [d.id]: d };
    setPostingCards((m) => ({ ...m, [d.id]: d }));
    setPosting((m) => ({ ...m, [d.id]: { phase: "posting" } }));
    const out = await followSocialPost(d.id, platform, tenantId);
    const notice = socialPostNotice(out, platform);
    if (out.state === "posted") {
      setPosting((m) => ({ ...m, [d.id]: { phase: "posted", url: out.url } }));
      toast.add({
        ...notice,
        ...(out.url ? { actionProps: { children: platform === "Pinterest" ? "Open pin" : "Open post", onClick: () => window.open(out.url!, "_blank", "noopener") } } : {}),
      });
    } else if (out.state === "failed") {
      setPosting((m) => ({ ...m, [d.id]: { phase: "failed", message: out.message } }));
      toast.add(notice);
    } else if (out.state === "approval_uncertain") {
      delete postingCardsRef.current[d.id];
      setPostingCards((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      setPosting((m) => {
        const next = { ...m };
        delete next[d.id];
        return next;
      });
      toast.add(notice);
    } else if (out.state === "scheduled") {
      toast.add(notice);
      dismissPosting(d.id);
    } else if (out.state === "uncertain") {
      setPosting((m) => ({ ...m, [d.id]: { phase: "uncertain", message: out.message } }));
      toast.add(notice);
    } else {
      setPosting((m) => ({ ...m, [d.id]: { phase: "slow" } }));
      toast.add(notice);
    }
  };

  useEffect(() => {
    if (!tenantId) return;
    const resume = () => {
      for (const post of pendingSocialPosts(tenantId)) {
        if (socialPostFollowActive(tenantId, post.decisionId)) continue;
        const retained = postingCardsRef.current[post.decisionId];
        if (retained && followedPostPlatform(retained)) void followChannelPost(retained);
        else void followPostInToast(post.decisionId, post.platform, undefined, tenantId);
      }
    };
    resume();
    window.addEventListener("focus", resume);
    return () => window.removeEventListener("focus", resume);
  }, [tenantId]);
  const dismissPosting = (id: string) => {
    delete postingCardsRef.current[id];
    setPostingCards((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    setPosting((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    dropDecision(id);
  };

  const postedKey = Object.entries(posting)
    .filter(([, p]) => p.phase === "posted")
    .map(([id, p]) => `${id}:${p.phase === "posted" && p.leaving ? "out" : "in"}`)
    .join(",");
  useEffect(() => {
    if (!postedKey) return;
    const timers = postedKey.split(",").map((entry) => {
      const [id, stage] = entry.split(":");
      return stage === "in"
        ? window.setTimeout(
            () => setPosting((m) => (m[id]?.phase === "posted" ? { ...m, [id]: { ...m[id], leaving: true } as PinPosting } : m)),
            PIN_POSTED_LINGER_MS,
          )
        : window.setTimeout(() => dismissPosting(id), PIN_FADE_MS);
    });
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postedKey]);

  const modeFor = (slug: string): DeliveryMode =>
    stateBySlug.get(slug)?.delivery_mode ?? "advise";

  const itemModeFor = (d: Decision, slug: string): DeliveryMode =>
    executesOnApprove(d) ? "execute" : modeFor(slug);

  const closeOut = async (d: Decision, verb: CloseOutVerb) => {
    if (busyIdsRef.current.has(d.id) || postingCardsRef.current[d.id]) return;
    if (verb === "approve" && zaviActsOnApprove(d) && upgradeInstead(d)) return;
    const captionError = verb === "approve" ? instagramCaptionError(editedDecision(d)) : null;
    if (captionError) { setActionError(captionError); return; }
    setBusy(d.id, true);
    setActionError(null);
    const caption = isInstagramImage(d) ? postEdits[d.id]?.text : undefined;
    const res = await writeVerb(d, verb, caption !== undefined ? { payload_text: caption } : {});
    if (res?.declined) {
      setBusy(d.id, false);
      return;
    }
    const ambiguousApproval = res === null || (res?.status !== undefined && res.status >= 500);
    if ((res?.ok || ambiguousApproval) && verb === "approve" && followedPostPlatform(d)) {
      setBusy(d.id, false);
      setSelected(null);
      void followChannelPost(editedDecision(d));
      return;
    }
    if (res?.ok) {
      const notDoneRun =
        verb === "snooze" || verb === "archive" ? d.run_group?.run_id : undefined;
      if (notDoneRun)
        setNotDoneByRun((m) => ({
          ...m,
          [notDoneRun]: (m[notDoneRun] ?? 0) + 1,
        }));
      setDecisions((list) => (list ?? []).filter((x) => x.id !== d.id));
      setChannelItems((m) =>
        d.channel_slug && m[d.channel_slug]
          ? { ...m, [d.channel_slug]: m[d.channel_slug].filter((x) => x.id !== d.id) }
          : m,
      );
      setSelected(null);
    } else {
      setActionError("That didn't go through. Try again in a moment.");
    }
    setBusy(d.id, false);
  };

  const card = (channel: Channel) => (d: Decision) =>
    isEmailCard(d) ? (
      <li key={d.id} data-testid={`action-${d.id}`} className="list-none">
        <DecisionEmailCard decision={d} channelSlug={channel.slug} onApproved={() => window.setTimeout(() => dropDecision(d.id), EMAIL_CARD_LINGER_MS)} onRejected={() => dropDecision(d.id)} />
      </li>
    ) : (
    <DecisionCard
      key={d.id}
      decision={editedDecision(d)}
      channel={channel}
      mode={itemModeFor(d, channel.slug)}
      onOpen={() => {
        setActionError(null);
        setSelected(d);
      }}
      busy={busyIds.has(d.id)}
      posting={posting[d.id]}
      onDismissPosting={() => dismissPosting(d.id)}
      error={cardErrors[d.id] ?? null}
      confirmReasons={cardConfirms[d.id]}
      onApprove={(extras) => void decide(d, "approve", extras)}
      onReject={() => void decide(d, "reject")}
      onReview={() => review(d)}
      onOpenChannel={() => {
        setActionError(null);
        setDetailSlug(channel.slug);
      }}
    />
  );

  const compactRow = (channel: Channel) => (d: Decision) => {
    const mode = itemModeFor(d, channel.slug);
    const high = isHighStakesDecision(stakesClassOf(d), d.handler, d.body);
    const step =
      d.decision_class === RECIPE_STEP_CLASS ? singleRecipeStep(d.body) : null;
    const autonomous = mode === "execute" && !high && !executesOnApprove(d);
    const who = autonomous
      ? "Zavi can do it"
      : mode === "execute"
        ? "Needs approval"
        : mode === "produce"
          ? "Draft ready"
          : "You do it";
    const days = daysOpen(d.emitted_at);
    const age = days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
    return (
      <CompactActionRow
        key={d.id}
        title={decisionHeadline(d)}
        meta={`${who} · ${step?.effort ? `takes ${step.effort}` : age}`}
        isNew={days === 0}
        blocking={step?.blocking === true}
        icon={
          step?.blocking ? (
            <OctagonAlert className="h-[18px] w-[18px]" />
          ) : step?.deliverable ? (
            <FileText className="h-[18px] w-[18px]" />
          ) : (
            <Wrench className="h-[18px] w-[18px]" />
          )
        }
        primaryLabel={autonomous ? "Fix" : "Review"}
        primaryTone={autonomous ? "loud" : "quiet"}
        busy={busyIds.has(d.id)}
        onPrimary={() => {
          setActionError(null);
          if (autonomous) void decide(d, "approve");
          else setSelected(d);
        }}
        onAskZavi={() => review(d)}
      />
    );
  };

  const rows = (channel: Channel) => (items: Decision[]) =>
    groupByRun(items).map((row) => {
      if (!row.run_id || row.items.length < 2) {
        const only = row.items[0];
        if (!hasRunBlocks(row.items)) return card(channel)(only);
        return (
          <li key={row.key} className="list-none">
            <RunBlocks items={row.items} />
            <ul className="mt-2 flex flex-col gap-2.5">{card(channel)(only)}</ul>
          </li>
        );
      }
      const progress = runProgress(row, notDoneByRun[row.run_id] ?? 0);
      const total = progress?.total ?? row.items.length;
      const done = progress?.done ?? 0;
      return (
        <li
          key={row.key}
          data-nav-only=""
          className="rounded-2xl border border-rule bg-cream p-3.5"
        >
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setSelectedRun({ channel, items: row.items, total });
            }}
            className={cx("w-full text-left", FOCUS_RING)}
          >
            {}
            <span className="flex items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-[18px] text-ink">
                  {channel.name} · {row.items.length} of {total} left
                  {done > 0 ? ` · ${done} done` : ""}
                </span>
              </span>
            </span>
          </button>
          <RunBlocks items={row.items} />
          {(() => {
            const findings =
              row.items
                .map((d) => recipeFindings(d.body))
                .find((f) => f.length > 0) ?? [];
            if (findings.length === 0) return null;
            return (
              <ul className="mt-2.5 flex flex-col gap-2 border-t border-rule pt-2.5">
                {findings.map((f) => (
                  <li key={f.metricId} className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className={cx(
                        "mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full",
                        f.status === "failing"
                          ? "bg-ink"
                          : f.status === "measured"
                            ? "bg-rule"
                            : "border border-rule bg-transparent",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-[18px] text-ink [overflow-wrap:anywhere]">
                        {}
                        <span className="text-inkMuted">{metricLabel(f.metricId)}</span>
                        <span aria-hidden="true" className="text-inkMuted"> · </span>
                        <span className="font-medium">{f.value}</span>
                        {}
                        <span className="sr-only">
                          {f.status === "failing"
                            ? ", needs work"
                            : f.status === "measured"
                              ? ", looks fine"
                              : ", not checked"}
                        </span>
                        {f.status === "unmeasured" && (
                          <span aria-hidden="true" className="text-inkMuted">
                            {" "}
                            · not checked
                          </span>
                        )}
                      </p>
                      {}
                      <FindingBar finding={f} />
                      {f.blocks.length > 0 && (
                        <p className="mt-0.5 text-[12px] leading-4 text-inkMuted [overflow-wrap:anywhere]">
                          Blocks: {f.blocks.join(". ")}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            );
          })()}
          <ol className="mt-2.5 flex flex-col gap-2.5 border-t border-rule pt-2.5">
            {row.items.map((d, i) => {
              const step = singleRecipeStep(d.body);
              return (
                <li key={d.id} className="flex items-start gap-2">
                  <span className="mt-0.5 min-w-[14px] text-[13px] font-semibold text-inkMuted">
                    {d.run_group?.position ?? i + 1}.
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-medium leading-5 text-ink [overflow-wrap:anywhere]">
                      {step?.title ?? recipeStepHeadline(d.body) ?? "This action"}
                      {step?.blocking && (
                        <span className="ml-1 inline-block whitespace-nowrap rounded-full bg-ink px-2 py-0.5 align-middle text-[11px] font-medium leading-4 text-cream">
                          Blocking
                        </span>
                      )}
                      {step?.deliverable && (
                        <span className="ml-1 inline-block whitespace-nowrap rounded-full border border-rule bg-bone px-2 py-0.5 align-middle text-[11px] font-medium leading-4 text-ink">
                          {step.deliverable.kindLabel} ready
                        </span>
                      )}
                    </p>
                    {step?.body && (
                      <div className="mt-2">
                        <ClampedText text={step.body} lines={2} />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-3 flex items-center justify-end">
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                setSelectedRun({ channel, items: row.items, total });
              }}
              className={cx(
                "h-10 rounded-full border border-rule bg-cream px-4 text-[16px] font-medium text-ink hover:bg-creamDeep",
                FOCUS_RING,
              )}
            >
              Open all
            </button>
          </div>
        </li>
      );
    });

  if (collapsed) {
    const railControls = (
      <>
        <button
          type="button"
          onClick={onToggle}
          title="Show channels"
          aria-label={
            total > 0
              ? `Show channels: ${total} items need you`
              : upgradeToStart
                ? `Show channels: ${UPGRADE_TO_START}`
                : "Show channels"
          }
          className={cx(
            "relative flex h-10 w-10 items-center justify-center rounded-cta text-ink hover:bg-bone",
            FOCUS_RING,
          )}
        >
          <Inbox className="h-[18px] w-[18px]" aria-hidden />
          {total > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-ink px-1 text-center text-[11px] font-bold leading-[18px] text-cream">
              {total}
            </span>
          )}
        </button>
      </>
    );
    if (inlineRail) return railControls;
    return (
      <aside
        aria-label="Growth Channels"
        style={{ width }}
        className="flex h-full shrink-0 flex-col items-center gap-2 rounded-2xl bg-cream pt-3 shadow-elev"
        {...(chrome?.dropProps ?? {})}
      >
        {railControls}
        {railExtra && (
          <>
            <span
              aria-hidden
              className="my-0.5 h-px w-6 shrink-0 rounded-full bg-rule"
            />
            {railExtra}
          </>
        )}
      </aside>
    );
  }

  const detailFor = (slug: string): ChannelDetail | null => {
    const ch = DISPLAY_CHANNELS.find((c) => c.slug === slug);
    if (!ch) return null;
    const st = stateBySlug.get(slug);
    return {
      channel: ch,
      mode: modeFor(slug),
      connected: st?.connected ?? false,
      connectors: st?.connectors ?? [...ch.connectors],
      ...(st?.linked_connectors ? { linkedConnectors: st.linked_connectors } : {}),
      workState: st?.work_state ?? "idle",
      lastRunAt: st?.last_run_at ?? null,
      lastProbeAt: st?.last_probe_at ?? null,
      lastProbeDelta: st?.last_probe_delta ?? null,
      runnable: st?.runnable ?? isChannelSlug(slug),
      planIntent: st?.plan_intent ?? null,
      planRationale: st?.plan_rationale ?? null,
      fit: st?.fit ?? null,
      hasStrategy,
    };
  };

  const detailProps = (slug: string, detail: ChannelDetail) => {
    const items = channelActions(slug);
    const priorItems = priorItemsOf(items);
    const chatItems = chatStagedItemsOf(items);
    return {
      detail,
      actionCount: items.length,
      onExtraCount,
      error: actionError,
      children: rows(detail.channel)(items),
      prior: {
        ids: priorItems.map((d) => d.id),
        render: (ids: readonly string[]) =>
          rows(detail.channel)(priorItems.filter((d) => ids.includes(d.id))),
      },
      chatStaged: {
        ids: chatItems.map((d) => d.id),
        render: (ids: readonly string[]) =>
          rows(detail.channel)(chatItems.filter((d) => ids.includes(d.id))),
      },
      compact: items.map(compactRow(detail.channel)),
    };
  };

  const notices = (
    <>
      {siteRead && shouldShowSiteNotice(siteRead, decisions === null ? null : decisions.length, channels) && (
        <SiteUnreadableNotice siteRead={siteRead} onDone={() => void reload()} />
      )}
      {decisions === null && (
        <span role="status" aria-busy="true" className="sr-only">
          Loading pending actions…
        </span>
      )}
      {error && (
        <div className="m-3 rounded-xl border border-danger/20 bg-dangerBg px-3 py-2.5 text-[12px] font-medium text-danger">
          Couldn&apos;t load pending actions.{" "}
          <button
            type="button"
            onClick={() => void reload()}
            className={cx("font-bold underline", FOCUS_RING)}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );

  const actionErrorNotice = actionError && (
    <p
      role="alert"
      className="m-3 rounded-xl bg-dangerBg px-3 py-2.5 text-[12px] font-medium text-danger"
    >
      {actionError}
    </p>
  );

  const planLockFor = (slug: string): ChannelPlanLock => {
    const gate = planGate(slug);
    const lock = gate?.lock;
    return {
      tierName: lock?.kind === "plan" ? tierDisplayName(lock.tier) : null,
      soon: entries.some((e) => e.channel.slug === slug && e.lock?.kind === "soon"),
      upgrade: (tier, opts) => {
        if (gate) showUpgrade(gate, opts?.clicked === true);
        else if (tier && tier !== "free") showPlanUpgrade(tier, opts?.clicked === true);
      },
    };
  };

  const detailDrawer = (() => {
    if (!detailSlug) return null;
    const detail = detailFor(detailSlug);
    if (!detail) return null;
    return (
      <ChannelPlanLockProvider value={planLockFor(detailSlug)}>
        <ChannelDrawer
          {...detailProps(detailSlug, detail)}
          onClose={() => setDetailSlug(null)}
          onOpenConnectors={() => {
            openStatic("brain");
            setDetailSlug(null);
          }}
        />
      </ChannelPlanLockProvider>
    );
  })();

  const overlays = (
    <>
      {detailDrawer}

      {upgrade && (
        <PlanUpgradeDialog
          feature={upgrade.feature}
          tier={upgrade.tier}
          title={upgrade.title}
          work={upgrade.work}
          onGoToPlans={(term) => {
            goToPlans(upgrade.tier, term);
            setUpgrade(null);
          }}
          onClose={() => setUpgrade(null)}
        />
      )}

      {selectedRun && (
        <RunActionsDrawer
          key={selectedRun.channel.slug}
          channelName={selectedRun.channel.name}
          actions={selectedRun.items}
          total={selectedRun.total}
          notDone={notDoneByRun[selectedRun.items[0]?.run_group?.run_id ?? ""] ?? 0}
          busyIds={busyIds}
          error={actionError}
          onClose={() => setSelectedRun(null)}
          onVerb={(a, verb: RunActionVerb) => {
            const d = selectedRun.items.find((x) => x.id === a.id);
            if (!d) return;
            void closeOut(d, verb).then(() => {
              setSelectedRun((cur) => {
                if (!cur) return cur;
                const left = cur.items.filter((x) => x.id !== a.id);
                return left.length === 0 ? null : { ...cur, items: left };
              });
            });
          }}
          onRefine={async (a, message) => {
            const source = selectedRun.items.find((x) => x.id === a.id);
            const gate = planGate(selectedRun.channel.slug);
            const lock = gate?.lock;
            if (gate && lock?.kind === "plan") {
              showUpgrade(gate);
              throw new Error(planUpgradeMessage(null, lock.tier));
            }
            if (source && isChannelAction(source)) {
              await redoChannelAction(a.id, message);
              return;
            }
            const res = await apiFetch(`/api/approvals/${a.id}/redo`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message }),
              idempotent: true,
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as {
                error?: { message?: string };
              } | null;
              throw new Error(
                body?.error?.message ?? "That didn't send. Try again in a moment.",
              );
            }
          }}
          onOpenThread={() => {
            const first = selectedRun.items[0];
            if (first) review(first);
            setSelectedRun(null);
          }}
        />
      )}

      {selected && (
        <ActionDrawer
          decision={selected}
          postEdit={postEdits[selected.id]}
          approveBlockedReason={instagramCaptionError(editedDecision(selected))}
          onEditPost={isInstagramImage(selected) ? (next) => setPostEdits((edits) => ({ ...edits, [selected.id]: next })) : undefined}
          mode={itemModeFor(selected, selected.channel_slug ?? "")}
          busy={busyIds.has(selected.id)}
          error={actionError}
          onClose={() => setSelected(null)}
          onApprove={() => void closeOut(selected, "approve")}
          onReject={() => void closeOut(selected, "reject")}
          onDidIt={() => void closeOut(selected, "did_it")}
          onDidntDoIt={() => void closeOut(selected, "archive")}
          onNotNow={() => void closeOut(selected, "snooze")}
          onOpenThread={() => {
            review(selected);
            setSelected(null);
          }}
        />
      )}
    </>
  );

  if (isPage) {
    return (
      <aside
        aria-label="Growth Channels"
        className="flex h-full min-h-0 w-full flex-col overflow-clip bg-cream"
        onScroll={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
          if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
        }}
      >
        <ChannelsPage
          entries={entries}
          loading={decisions === null}
          companyName={tenantName ?? null}
          currentPlan={tenantTier}
          canComparePlans={!isMember(role)}
          directUpgrade={!isMember(role)}
          notices={
            <>
              {notices}
              {actionErrorNotice}
            </>
          }
          onShow={showChannel}
          onPeek={ensureChannelActions}
          onUpgrade={clickUpgrade}
          onPlanGate={showUpgrade}
          onUpgradePlan={clickPlanUpgrade}
          renderDetail={(slug, close, leading) => {
            const detail = detailFor(slug);
            if (!detail) return null;
            return (
              <ChannelPlanLockProvider value={planLockFor(slug)}>
                <ChannelDetailPage
                  {...detailProps(slug, detail)}
                  leading={leading}
                  onClose={close}
                  onOpenConnectors={() => openStatic("brain")}
                />
              </ChannelPlanLockProvider>
            );
          }}
        />
        {overlays}
      </aside>
    );
  }

  return (
    <aside
      aria-label="Growth Channels"
      style={{ width }}
      className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-2xl bg-cream shadow-elev"
    >
      <div
        {...(chrome?.dropProps ?? {})}
        className={cx("flex pl-4", PANEL_HEADER_BOX)}
      >
        <Inbox className="h-4 w-4 shrink-0 text-ink" aria-hidden />
        <h2 className={PANEL_HEADER_TITLE}>Growth Channels</h2>
        {(total > 0 || decisions === null || error) && (
          <span
            className={cx(
              "h-2 w-2 rounded-full",
              total > 0 ? "bg-success" : "bg-inkLight",
            )}
            aria-label={
              decisions === null
                ? "Loading"
                : error
                  ? "Couldn't load approvals"
                  : `${total} pending`
            }
          />
        )}
        <span className="flex-1" />
        <IconButton label="Hide channels" onClick={onToggle}>
          <PanelRightClose className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </div>

      <div className="ws-scroll min-h-0 flex-1">
        {notices}
        {entries.map((entry, index) => {
          const open = openKey === entry.channel.slug;
          const shown = channelActions(entry.channel.slug);
          return (
            <ChannelRow
              key={entry.channel.slug}
              entry={entry}
              loading={decisions === null}
              index={index}
              expanded={open}
              onUpgrade={clickUpgrade}
              onOpen={() => {
                const next = open ? null : entry.channel.slug;
                if (next) showChannel(entry, true);
                setOpenKey(next);
              }}
              onPreview={
                isMember(role) ? () => setOpenKey(open ? null : entry.channel.slug) : undefined
              }
            >
              <Collapse open={open}>
                {entry.lock?.kind === "plan" && !canReadChannel(entry) ? (
                  open && (
                    <LockedChannelPreview
                      entry={entry}
                      onUpgrade={() => clickUpgrade(entry)}
                    />
                  )
                ) : shown.length === 0 ? (
                  <div className="flex items-center gap-2 px-4 pb-3.5 pt-0.5">
                    <p className="flex-1 text-[13px] leading-5 text-inkMuted">
                      {loadingChannel === entry.channel.slug
                        ? "Loading this channel's actions…"
                        : entry.waiting > 0
                          ? `${waitingText(entry.waiting)}, not loaded yet.`
                          : "Nothing waiting here yet."}
                    </p>
                    <button
                      type="button"
                      onClick={() => setDetailSlug(entry.channel.slug)}
                      className={cx(
                        "h-10 shrink-0 rounded-full border border-rule bg-cream px-3.5 text-[16px] font-medium text-ink hover:bg-creamDeep",
                        FOCUS_RING,
                      )}
                    >
                      Details
                    </button>
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2.5 px-3 pb-3.5 pt-1.5">
                    {}
                    <li className="flex items-center justify-between gap-2 px-1">
                      <span className="text-[13px] text-inkMuted">
                        {}
                        Account, schedule and what changed.
                      </span>
                      <button
                        type="button"
                        onClick={() => setDetailSlug(entry.channel.slug)}
                        className={cx(
                          "h-8 shrink-0 rounded-full border border-rule bg-cream px-3 text-[13px] font-medium text-ink hover:bg-creamDeep",
                          FOCUS_RING,
                        )}
                      >
                        Details
                      </button>
                    </li>
                    {detailSlug !== entry.channel.slug && rows(entry.channel)(shown)}
                  </ul>
                )}
              </Collapse>
            </ChannelRow>
          );
        })}
        {actionErrorNotice}
      </div>
      {overlays}
    </aside>
  );
}
