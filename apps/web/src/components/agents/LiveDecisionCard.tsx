"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { approveDecision, rejectDecision } from "@/lib/approvals/approveDecision";
import { fetchDecision, fetchFindMoney, type BudgetChoiceView, type DecisionSurface, type FindMoneyResult, type LiveDecisionRow, type MoveView, type RaiseAsk, type ViewerRole } from "@/lib/approvals/decisionApi";
import { BudgetChoicePanel, cutsCantWords } from "./BudgetChoicePanel";
import { MoveCard, useMoveClaim } from "./MoveCard";
import { approveExtrasFor, loadedScheduleGuard, scheduleMovedNotice } from "@/app/approvals/approvalsHelpers";
import type { ApproveExtras } from "@/lib/approvals/approveDecision";
import { UNWIRED_APPROVE_HANDLERS, WEB_ONLY_APPROVE_CLASSES } from "@/lib/approvals/oneClick";
import { BusinessControlsApprovalCard } from "@/components/workspace/actions/BusinessControlsApprovalCard";
import { EmailCampaignCard } from "@/components/email/EmailCampaignCard";
import { EMAIL_CARD_CLASSES } from "@/components/email/emailCardClasses";
import { PostPreview } from "@/components/workspace/PostPreview";
import {
  OWNER_OR_ADMIN_APPROVE_REASON,
  VIEWER_APPROVE_REASON,
  composioChatCardState,
  type ComposioCardPhase,
} from "@/app/approvals/composioChatCard";
import { isXAdsClass } from "@/app/approvals/xAdsDecision";
import { isTiktokAdsClass } from "@/app/approvals/tiktokAdsDecision";
import { ProposalFields } from "./ProposalCard";
import { Markdown } from "@/components/workspace/Markdown";
import { approvedAtLabel, decisionSlipModel, makeReadGate, slipStage, type SlipModel, type SlipStage } from "./slip/decisionSlip";
import { SLIP_PRIMARY, SLIP_QUIET, SLIP_SECONDARY, SlipCard, SlipFlag, SlipFooter, SlipReceipt, SlipSection, SlipSlab, SlipTracker, type SlipStep } from "./slip/SlipParts";
import { BulkSendProgress } from "./BulkSendProgress";

export type LiveDecisionCardResolution = "approved" | "rejected";

export const LIVE_DECISION_POLL_MS = 5_000;
export const OUTCOME_UNKNOWN_POLL_WINDOW_MS = 30_000;

export function liveApproveExtras(row: LiveDecisionRow): ApproveExtras {
  const fingerprint = row.body?.fingerprint;
  const sched = loadedScheduleGuard({ decision_class: row.decision_class, body: row.body });
  return {
    ...approveExtrasFor({ decision_class: row.decision_class, post_revision: row.post_revision, handler: liveDecisionHandler(row), body: row.body }),
    ...(WEB_ONLY_APPROVE_CLASSES.has(row.decision_class) && typeof fingerprint === "string" ? { expected_fingerprint: fingerprint } : {}),
    ...("expectedScheduledAt" in sched ? { expected_scheduled_at: sched.expectedScheduledAt ?? null } : {}),
  };
}

export const NOT_IN_LIST_LINE = "This card is not in your list any more.";
export const FAILED_RETRY_GUIDANCE = " Ask Zavi in this chat to try again, or reject it.";
const DISPATCH_ERROR_MAX = 300;

const COMPOSIO_HANDLER = "composio.execute_tool";

export const UNWIRED_APPROVE_REASON = "Zavi can't run this kind of action yet. Do it yourself, then reject this card.";

export function liveDecisionHandler(row: Pick<LiveDecisionRow, "handler" | "decision_class">): string {
  if (row.handler) return row.handler;
  const c = row.decision_class;
  if (c.startsWith("meta_ads.") || c.startsWith("google_ads.") || isXAdsClass(c) || isTiktokAdsClass(c)) return c;
  return COMPOSIO_HANDLER;
}

export type LiveDecisionState = {
  phase: ComposioCardPhase;
  appName: string;
  approveBlockedReason: string | null;
};

export function liveDecisionState(
  row: LiveDecisionRow,
  viewerRole: ViewerRole | null,
  needsOwnerAdmin: boolean,
  now: number = Date.now(),
): LiveDecisionState {
  const base = composioChatCardState(row, viewerRole, now);
  const phase = base.phase;
  let approveBlockedReason = base.approveBlockedReason;
  if (row.handler && UNWIRED_APPROVE_HANDLERS.has(row.handler)) approveBlockedReason = UNWIRED_APPROVE_REASON;
  else if (viewerRole === "viewer") approveBlockedReason = VIEWER_APPROVE_REASON;
  else if (needsOwnerAdmin && viewerRole === "member") approveBlockedReason = OWNER_OR_ADMIN_APPROVE_REASON;
  return { phase, appName: base.appName, approveBlockedReason };
}

export const ADVICE_POLL_MS = 5_000;
export const ADVICE_WAIT_MS = 30_000;
export const ADVICE_SLOW_POLL_MS = 15_000;
export const ADVICE_GIVE_UP_MS = 10 * 60_000;
export const ADVICE_UNAVAILABLE_LINE = "Zavi could not check this change for warnings. Look it over before you approve.";
export const ADVICE_PENDING_LINE = "Zavi is still checking this change for warnings. Look it over before you approve.";

export const AUTOPILOT_DISAGREES = "Autopilot disagrees:";
export const AUTOPILOT_NOTES = "Autopilot notes:";

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export const SUPERSEDED_LINE = "Closed: the budget changed before this was approved, so it was based on an old amount. Nothing was changed.";

export function isFounderAdOrder(row: Pick<LiveDecisionRow, "decision_class" | "body">): boolean {
  return /^(meta_ads|google_ads)\./.test(row.decision_class) && row.body?.origin === "user_initiated_chat";
}

export function liveDecisionNotes(
  row: Pick<LiveDecisionRow, "body" | "cgo_hold" | "founder_advice"> & Partial<Pick<LiveDecisionRow, "decision_class">>,
  adviceTimedOut = false,
): {
  held: string | null;
  evidence: string | null;
  disagrees: string | null;
  notes: string | null;
  adviceUnavailable: string | null;
} {
  const hold = row.cgo_hold;
  const held = hold && hold.words.length ? `Autopilot held this: ${hold.words.join("; ")}.` : null;
  const note = typeof row.body?.cut_guard_note === "string" && row.body.cut_guard_note.trim() ? row.body.cut_guard_note.trim() : null;
  const rules = (row.founder_advice?.warnings ?? []).map((w) => w.trim()).filter((w) => w.length > 0);
  const founderOrder = typeof row.decision_class === "string" && isFounderAdOrder({ decision_class: row.decision_class, body: row.body });
  const adviceUnavailable = !founderOrder
    ? null
    : row.founder_advice?.unavailable === true
      ? ADVICE_UNAVAILABLE_LINE
      : row.founder_advice == null && adviceTimedOut
        ? ADVICE_PENDING_LINE
        : null;
  return {
    held,
    evidence: held && hold?.evidence ? hold.evidence : null,
    disagrees: note ? sentence(note) : null,
    notes: rules.length ? sentence(rules.join("; ")) : null,
    adviceUnavailable,
  };
}

export function liveDecisionOutcomeLine(phase: ComposioCardPhase, row: Pick<LiveDecisionRow, "dispatch_error"> & { status?: string }): string | null {
  switch (phase) {
    case "running":
      return "Approved. Running it now.";
    case "done":
      return "Done.";
    case "failed": {
      const err = row.dispatch_error?.trim();
      const head = err ? (err.length > DISPATCH_ERROR_MAX ? `${err.slice(0, DISPATCH_ERROR_MAX - 1)}…` : err) : "It did not go through.";
      return `${head}${FAILED_RETRY_GUIDANCE}`;
    }
    case "rejected":
      return "Rejected. Nothing was changed.";
    case "closed":
      return row.status === "superseded" ? SUPERSEDED_LINE : "Closed. Nothing was changed.";
    default:
      return null;
  }
}

const EARLIER_CARD_MS = 30 * 60_000;

export function waitingSinceLine(emittedAt: string | undefined, shownAt: string | undefined): string | null {
  const filed = emittedAt ? Date.parse(emittedAt) : NaN;
  const shown = shownAt ? Date.parse(shownAt) : NaN;
  if (!Number.isFinite(filed) || !Number.isFinite(shown) || shown - filed < EARLIER_CARD_MS) return null;
  return `Waiting since ${new Date(filed).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function LiveDecisionCard({
  decisionId,
  title,
  viewerRole: viewerRoleProp = null,
  onResolved,
  runStopped = false,
  shownAt,
  surface,
  decisionClass,
  onRow,
  initialRow,
}: {
  decisionId: string;
  initialRow?: LiveDecisionRow | null;
  title: string;
  shownAt?: string;
  onRow?: (row: LiveDecisionRow) => void;
  decisionClass?: string;
  viewerRole?: ViewerRole | null;
  onResolved?: (decisionId: string, resolution: LiveDecisionCardResolution, row?: LiveDecisionRow) => void;
  runStopped?: boolean;
  surface: DecisionSurface;
}) {
  const [row, setRow] = useState<LiveDecisionRow | null>(initialRow ?? null);
  const [needsOwnerAdmin, setNeedsOwnerAdmin] = useState(false);
  const [serverRole, setServerRole] = useState<ViewerRole | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [runAlone, setRunAlone] = useState<string | null>(null);
  const [budgetChoice, setBudgetChoice] = useState<BudgetChoiceView | null>(null);
  const [move, setMove] = useState<MoveView | null>(null);
  const [found, setFound] = useState<FindMoneyResult | null>(null);
  const [findNote, setFindNote] = useState<string | null>(null);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);
  const onRowRef = useRef(onRow);
  onRowRef.current = onRow;
  const readGate = useRef(makeReadGate());
  const load = useCallback(async () => {
    const gen = readGate.current.start();
    const got = await fetchDecision(decisionId);
    if (!readGate.current.accept(gen)) return;
    if (got.ok) {
      setRow(got.decision);
      onRowRef.current?.(got.decision);
      setNeedsOwnerAdmin(got.needs_owner_admin);
      setServerRole(got.viewer_role);
      setBudgetChoice(got.budget_choice);
      setMove(got.move);
      setLoadError(null);
      setNotFound(false);
    } else if (got.notFound) {
      setNotFound(true);
    } else {
      setLoadError(got.error);
    }
  }, [decisionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const viewerRole = serverRole ?? viewerRoleProp;
  const ownCardClass = decisionClass ?? row?.decision_class;
  const hasOwnCard = !!ownCardClass && (ownCardClass === "growth.save_business_controls" || EMAIL_CARD_CLASSES.has(ownCardClass));
  const phase = row && !hasOwnCard ? liveDecisionState(row, viewerRole, needsOwnerAdmin).phase : null;
  useEffect(() => {
    if (phase === "running") {
      const t = setInterval(() => void load(), LIVE_DECISION_POLL_MS);
      return () => clearInterval(t);
    }
    if (phase === "outcome_unknown") {
      const t = setInterval(() => void load(), LIVE_DECISION_POLL_MS);
      const stop = setTimeout(() => clearInterval(t), OUTCOME_UNKNOWN_POLL_WINDOW_MS);
      return () => {
        clearInterval(t);
        clearTimeout(stop);
      };
    }
    return undefined;
  }, [phase, load]);

  const awaitingAdvice = phase === "pending" && !!row && isFounderAdOrder(row) && row.founder_advice == null;
  const [adviceTimedOut, setAdviceTimedOut] = useState(false);
  useEffect(() => {
    if (!awaitingAdvice) return;
    const started = Date.now();
    let slow: ReturnType<typeof setInterval> | null = null;
    const fast = setInterval(() => {
      if (Date.now() - started < ADVICE_WAIT_MS) {
        void load();
        return;
      }
      clearInterval(fast);
      setAdviceTimedOut(true);
      void load();
      slow = setInterval(() => {
        if (Date.now() - started >= ADVICE_GIVE_UP_MS) {
          if (slow) clearInterval(slow);
          void load();
          return;
        }
        void load();
      }, ADVICE_SLOW_POLL_MS);
    }, ADVICE_POLL_MS);
    return () => {
      clearInterval(fast);
      if (slow) clearInterval(slow);
    };
  }, [awaitingAdvice, load]);

  const showsMove = useMoveClaim(move?.key ?? null, decisionId);

  if (ownCardClass === "growth.save_business_controls") {
    return <BusinessControlsApprovalCard decisionId={decisionId} onResolved={(r) => onResolved?.(decisionId, r)} />;
  }
  if (ownCardClass && EMAIL_CARD_CLASSES.has(ownCardClass)) {
    return <EmailCampaignCard rail="decisions" id={decisionId} surface={surface} onApproved={() => onResolved?.(decisionId, "approved")} onRejected={() => onResolved?.(decisionId, "rejected")} />;
  }

  if (move) {
    if (!showsMove) return null;
    const st = row ? liveDecisionState(row, viewerRole, needsOwnerAdmin) : null;
    return <MoveCard anchorId={decisionId} move={move} onChanged={load} notice={moveNotice} approveBlockedReason={st?.approveBlockedReason ?? null} />;
  }

  const act = async (action: "approve" | "reject", opts: { runAlone?: boolean; raise?: RaiseAsk } = {}) => {
    if (!row) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setRunAlone(null);
    try {
      const res =
        action === "approve"
          ? await approveDecision(row.id, liveApproveExtras(row), undefined, { surface, runAlone: opts.runAlone, raise: opts.raise })
          : await rejectDecision(row.id, { surface });
      if (!res) return;
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string; current_scheduled_at?: string | null; status?: string; run_alone?: { message?: string }; budget_choice?: BudgetChoiceView | null };
        } | null;
        if ((j?.error?.code === "budget_choice_required" || j?.error?.code === "budget_raise_changed") && j.error.budget_choice) {
          setBudgetChoice(j.error.budget_choice);
          setNotice(j.error.message ?? null);
          return;
        }
        if (j?.error?.code === "paired_move_waits" && typeof j.error.run_alone?.message === "string") {
          setRunAlone(j.error.run_alone.message);
          return;
        }
        if (j?.error?.code === "schedule_changed") {
          setNotice(scheduleMovedNotice(j.error.current_scheduled_at ?? null));
          await load();
          return;
        }
        if (j?.error?.code === "stale_card") await load();
        if (j?.error?.code === "decision_closed" && j.error.status !== "proposed") {
          await load();
          return;
        }
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      }
      const settled: LiveDecisionRow = { ...row, status: action === "approve" ? "approved" : "rejected" };
      readGate.current.invalidate();
      setRow(settled);
      onResolved?.(row.id, action === "approve" ? "approved" : "rejected", settled);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFindMoney = async () => {
    setBusy(true);
    setFindNote(null);
    try {
      const r = await fetchFindMoney(decisionId);
      if (!r.candidates.length && (r.why === "fits" || r.why === "no_budget")) await load();
      else if (r.candidates.length) setFound(r);
      else if (r.kind === "unreadable") setFindNote(`Zavi can't check your ad budget right now (${r.budget_choice?.kind === "unreadable" ? r.budget_choice.why : r.why ?? "read"}).`);
      else setFindNote(cutsCantWords(r.why));
    } catch (e) {
      setFindNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <LiveDecisionCardView
      decisionId={decisionId}
      title={title}
      row={notFound ? null : row}
      loadError={notFound ? NOT_IN_LIST_LINE : loadError}
      viewerRole={viewerRole}
      needsOwnerAdmin={needsOwnerAdmin}
      busy={busy}
      actionError={notice ?? actionError}
      onApprove={() => void act("approve")}
      onReject={() => void act("reject")}
      budgetChoice={budgetChoice}
      onApproveAndRaise={(raise) => void act("approve", { raise })}
      onFindMoney={() => void onFindMoney()}
      findMoney={found}
      findMoneyNote={findNote}
      onFindMoneyChanged={async () => {
        setFound(null);
        await load();
      }}
      onFindMoneyFailed={setMoveNotice}
      runAloneConfirm={runAlone}
      onRunAlone={() => void act("approve", { runAlone: true })}
      onCancelRunAlone={() => setRunAlone(null)}
      runStopped={runStopped}
      adviceTimedOut={adviceTimedOut}
      shownAt={shownAt}
    />
  );
}

function RunStoppedLine() {
  return <SlipFlag>This run was stopped.</SlipFlag>;
}

function PendingNotes({ row, adviceTimedOut }: { row: LiveDecisionRow; adviceTimedOut: boolean }) {
  const n = liveDecisionNotes(row, adviceTimedOut);
  if (!n.held && !n.disagrees && !n.notes && !n.adviceUnavailable) return null;
  return (
    <>
      {n.held && (
        <SlipFlag>
          <p>{n.held}</p>
          {n.evidence && <p className="mt-0.5 line-clamp-4 text-[#7a6a4a]">{n.evidence}</p>}
        </SlipFlag>
      )}
      {n.disagrees && (
        <SlipFlag testId="autopilot-disagrees">
          <span className="font-bold text-[#8a5a10]">{AUTOPILOT_DISAGREES}</span> {n.disagrees}
        </SlipFlag>
      )}
      {n.notes && (
        <SlipFlag testId="autopilot-notes">
          <span className="font-bold text-[#8a5a10]">{AUTOPILOT_NOTES}</span> {n.notes}
        </SlipFlag>
      )}
      {n.adviceUnavailable && <SlipFlag testId="advice-unavailable">{n.adviceUnavailable}</SlipFlag>}
    </>
  );
}

export function slipStatusWord(stage: SlipStage, appName: string, status: string): string {
  switch (stage) {
    case "waiting":
      return "Needs your yes";
    case "queued":
      return "Approved";
    case "sending":
      return "Sending";
    case "unknown":
      return `Check ${appName}`;
    case "done":
      return "Done";
    case "failed":
      return "Didn't go through";
    case "rejected":
      return "Rejected";
    default:
      return status === "superseded" ? "Closed, out of date" : "Closed";
  }
}

export function slipSteps(stage: SlipStage, m: Pick<SlipModel, "steps" | "platform">, appName: string, approvedAt: string | null | undefined): SlipStep[] {
  const at = approvedAtLabel(approvedAt);
  const sending: SlipStep =
    stage === "queued"
      ? { label: m.steps.sending, sub: "Queued, about to send", state: "now" }
      : stage === "sending"
        ? { label: m.steps.sending, sub: "Working on it", state: "now" }
        : stage === "unknown"
          ? { label: m.steps.sending, sub: `It may have gone through. Check ${appName} before you try again.`, state: "warn" }
          : stage === "failed"
            ? { label: m.steps.sending, sub: "Stopped with an error", state: "fail" }
            : { label: m.steps.sending, sub: "Accepted", state: "done" };
  return [
    { label: "You approved", sub: at, state: "done" },
    sending,
    { label: m.steps.live, sub: stage === "done" ? null : stage === "queued" || stage === "sending" ? "Usually under a minute" : null, state: stage === "done" ? "done" : "todo" },
  ];
}

function SlipWhy({ m }: { m: SlipModel }) {
  const [open, setOpen] = useState(false);
  const more = Boolean(m.why.full || m.why.markdown || (m.why.about && m.why.lead));
  const lead = m.why.lead ?? m.why.about;
  if (!lead && !more && m.chips.length === 0) return null;
  return (
    <SlipSection label="Why" testId="slip-why">
      {lead && (
        <p dir="auto" className="text-[14px] font-semibold leading-snug text-[#2b2416]">
          {lead}
        </p>
      )}
      {m.chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {m.chips.map((c, i) => (
            <span key={`${c.label}-${i}`} className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${c.tone === "good" ? "bg-[#d1fae5] text-[#047857]" : "bg-[#f5efe0] text-[#7a6a4a]"}`}>
              {c.label}
            </span>
          ))}
        </div>
      )}
      {more && (
        <>
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 inline-flex min-h-[32px] items-center text-[12px] font-semibold text-[#7a6a4a] hover:text-[#2b2416]">
            {open ? "Hide the evidence" : "See the evidence"}
          </button>
          {open && (
            <div className="mt-1 space-y-2 rounded-lg bg-[#faf7f0] p-3 text-[12.5px] leading-relaxed text-[#5c5240]">
              {m.why.about && m.why.lead && <p dir="auto">{m.why.about}</p>}
              {m.why.full && (
                <p dir="auto" className="whitespace-pre-wrap">
                  {m.why.full}
                </p>
              )}
              {m.why.markdown && (
                <div className="max-h-96 overflow-auto">
                  <Markdown source={m.why.markdown} disableActionLinks />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </SlipSection>
  );
}

export function LiveDecisionCardView({
  decisionId,
  title,
  row,
  loadError,
  viewerRole,
  needsOwnerAdmin = false,
  busy,
  actionError,
  onApprove,
  onReject,
  now,
  runStopped = false,
  adviceTimedOut = false,
  runAloneConfirm = null,
  onRunAlone,
  onCancelRunAlone,
  shownAt,
  budgetChoice = null,
  onApproveAndRaise,
  onFindMoney,
  findMoney = null,
  findMoneyNote = null,
  onFindMoneyChanged,
  onFindMoneyFailed,
}: {
  decisionId: string;
  title: string;
  shownAt?: string;
  row: LiveDecisionRow | null;
  loadError: string | null;
  viewerRole: ViewerRole | null;
  needsOwnerAdmin?: boolean;
  busy: boolean;
  actionError: string | null;
  onApprove: () => void;
  onReject: () => void;
  now?: number;
  runStopped?: boolean;
  adviceTimedOut?: boolean;
  runAloneConfirm?: string | null;
  onRunAlone?: () => void;
  onCancelRunAlone?: () => void;
  budgetChoice?: BudgetChoiceView | null;
  onApproveAndRaise?: (ask: RaiseAsk) => void;
  onFindMoney?: () => void;
  findMoney?: FindMoneyResult | null;
  findMoneyNote?: string | null;
  onFindMoneyChanged?: () => void | Promise<void>;
  onFindMoneyFailed?: (message: string) => void;
}) {
  if (!row) {
    return (
      <SlipCard label={title} decisionId={decisionId}>
        <p className="px-4 py-4 text-[12px] text-inkMuted sm:px-5">{loadError ?? "Loading the action…"}</p>
      </SlipCard>
    );
  }
  const state = liveDecisionState(row, viewerRole, needsOwnerAdmin, now);
  const outcome = liveDecisionOutcomeLine(state.phase, row);
  const stage = slipStage(state.phase, row.status);
  const m = decisionSlipModel(row, liveDecisionHandler(row), state.appName);
  const waiting = stage === "waiting" ? waitingSinceLine(row.emitted_at, shownAt) : null;
  const choice = stage === "waiting" && !runAloneConfirm && budgetChoice && budgetChoice.kind !== "fits" ? budgetChoice : null;
  const isPost = row.decision_class === "social.publish.v2" && typeof row.body?.channel === "string" && !!row.body?.payload;
  return (
    <SlipCard label={title} decisionId={decisionId}>
      <SlipSlab stage={stage} status={slipStatusWord(stage, state.appName, row.status)} platform={m.platform} mark={m.mark} target={m.target} title={m.title} hero={m.hero} />
      {isPost && (
        <div className="px-4 pt-3.5 sm:px-5">
          <PostPreview
            channel={row.body!.channel as string}
            payload={row.body!.payload as Record<string, unknown>}
            scheduledAt={typeof row.body!.scheduled_at === "string" ? row.body!.scheduled_at : null}
          />
        </div>
      )}
      {stage === "waiting" ? (
        <>
          <SlipWhy m={m} />
          {m.fields.length > 0 && (
            <SlipSection label="Sends" testId="slip-fields">
              <ProposalFields fields={m.fields} />
            </SlipSection>
          )}
          {m.flags.length > 0 && (
            <SlipFlag tone="risk" testId="slip-risks">
              <span className="font-bold">Before you approve:</span>{" "}
              {m.flags.map((f, i) => (
                <span key={f}>
                  {i > 0 && " · "}
                  {f}
                </span>
              ))}
            </SlipFlag>
          )}
          {runStopped && <RunStoppedLine />}
          <PendingNotes row={row} adviceTimedOut={adviceTimedOut} />
          {actionError && <p className="mx-4 mt-3 text-[12px] text-coral sm:mx-5">{actionError}</p>}
          {runAloneConfirm && (
            <SlipFooter>
              <div data-testid="run-alone-confirm" className="rounded-xl border border-[#e8c46a] bg-[#fdf9ee] px-3 py-2.5 text-[13px] leading-snug">
                <p>{runAloneConfirm}</p>
                <div className="mt-2.5 space-y-1.5">
                  <button type="button" disabled={busy} onClick={onRunAlone} className={SLIP_PRIMARY}>
                    {busy ? "Submitting…" : "Run it alone"}
                  </button>
                  <button type="button" disabled={busy} onClick={onCancelRunAlone} className={SLIP_SECONDARY}>
                    Cancel
                  </button>
                </div>
              </div>
            </SlipFooter>
          )}
          {choice &&
            (findMoney ? (
              <SlipFooter>
                <MoveCard
                  embedded
                  anchorId={decisionId}
                  move={findMoney.move}
                  candidates={findMoney.candidates}
                  onChanged={() => onFindMoneyChanged?.()}
                  onFailed={onFindMoneyFailed}
                  onReject={onReject}
                  approveBlockedReason={state.approveBlockedReason}
                />
              </SlipFooter>
            ) : (
              <>
                <BudgetChoicePanel view={choice} busy={busy} onApproveAndRaise={(ask) => onApproveAndRaise?.(ask)} onReject={onReject} onFindMoney={onFindMoney} approveBlockedReason={state.approveBlockedReason} meta={waiting} />
                {findMoneyNote && (
                  <p data-testid="find-money-note" className="mx-4 mb-3 text-[12px] text-ink sm:mx-5">
                    {findMoneyNote}
                  </p>
                )}
              </>
            ))}
          {!runAloneConfirm && !choice && (
            <SlipFooter>
              {state.approveBlockedReason ? (
                <p className="rounded-xl bg-[#f5efe0] px-3 py-2.5 text-[12.5px] text-[#5c5240]">{state.approveBlockedReason}</p>
              ) : (
                <button type="button" disabled={busy} onClick={onApprove} className={SLIP_PRIMARY}>
                  {busy ? "Submitting…" : m.primaryLabel}
                </button>
              )}
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] text-[#a8977a]">{waiting ?? ""}</span>
                <button type="button" disabled={busy} onClick={onReject} className={SLIP_QUIET}>
                  Reject
                </button>
              </div>
            </SlipFooter>
          )}
        </>
      ) : stage === "rejected" || stage === "closed" ? (
        <div className="px-4 pt-3.5 pb-4 sm:px-5">
          {outcome && <p className="text-[13px] font-semibold text-[#44403c]">{outcome}</p>}
          {actionError && <p className="mt-2 text-[12px] text-coral">{actionError}</p>}
        </div>
      ) : (
        <div className="pb-4">
          <SlipTracker steps={slipSteps(stage, m, state.appName, row.approved_at)} />
          {stage === "unknown" && (
            <div className="mx-4 mt-3 rounded-xl border border-[#f5d27a] bg-[#fdf6e3] px-3 py-2.5 text-[13px] font-semibold text-[#92400e] sm:mx-5">
              Outcome unknown, check {state.appName}.
            </div>
          )}
          {stage === "failed" && outcome && (
            <div className="mx-4 mt-3 rounded-xl border border-[#fecdd3] bg-[#fff1f2] px-3 py-2.5 text-[13px] leading-snug text-[#881337] sm:mx-5">{outcome}</div>
          )}
          {(stage === "queued" || stage === "sending" || stage === "done") && outcome && <p className="mx-4 mt-2 text-[12.5px] text-[#7a6a4a] sm:mx-5">{outcome}</p>}
          {stage === "done" && <SlipReceipt title={m.receipt.title} rows={m.receipt.rows} limitsNow={m.limitsNow} />}
          {}
          {row.decision_class === "bulk_outbound.send" && (stage === "queued" || stage === "sending" || stage === "done" || stage === "unknown") && (
            <div className="px-4 sm:px-5">
              <BulkSendProgress decisionId={row.id} />
            </div>
          )}
          {actionError && <p className="mx-4 mt-2 text-[12px] text-coral sm:mx-5">{actionError}</p>}
        </div>
      )}
    </SlipCard>
  );
}
