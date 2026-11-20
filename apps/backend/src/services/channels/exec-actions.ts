
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { ActionType } from "@zavi/shared";
import { cardPresentation, type CardPresentation } from "./card-presentation";
import { CARD_INTENTS, type CardIntent } from "@/agents/lib/channel-recipe-step";
import { SUBJECT_REFS_KEY, cardSubjectRefs } from "@/services/growth/open-advice";
import { nudgeOpsAlertDrain } from "@/services/logging/ops-alert-outbox";
import { verdictFor } from "./exec-failure";
import { logEvent } from "@/services/logging/logEvent";
import { ExpectedToolError } from "@/services/tools/types";
import {
  hasMatchCandidates,
  isDropped,
  isReplace,
  loadMatchPool,
  matchRunCards,
  matcherEnabled,
  summarize,
  type FreshCard,
} from "./card-matcher";
import { execCardTarget, execSkipsMatcher, targetKeyOf } from "./exec-card-identity";
import { alertRematchExhausted } from "./card-rematch";
import { retireStaleBudgetProposals } from "./retire-stale-budget";
import { PERSON_ONLY_EXEC_CLASSES, isPersonOnlyOrigin } from "@/services/growth/person-only";
import { LINKEDIN_CGO_DOOR_CLASSES } from "@/services/tools/linkedin-ads/_change-bodies";

const GENERATED_VIDEO_EXEC_CLASS = "generated_video.render.v1";

import { serverFounderMarks, type ServerFounder } from "@/services/growth/founder-marks";

const FOUNDER_MARKS = ["founder_chat_order", "founder_order_unverified", "move_group"] as const;
export type ExecActionInput = {
  tenantId: string;
  runId: string;
  channelSlug?: string;
  execClass: string;
  execPayload: Record<string, unknown>;
  actionType: ActionType;
  title: string;
  body: Record<string, unknown>;
  serverFounder?: ServerFounder;
};

function execPresentation(input: ExecActionInput, channelSlug: string): CardPresentation {
  const step = (input.body.step ?? {}) as { body?: unknown; target?: { kind?: unknown } | null; intent?: unknown };
  const ec = input.body.exact_change as { rows?: Array<{ item: string; before: string; after: string }> } | null | undefined;
  return cardPresentation({
    channelSlug,
    action_type: input.actionType,
    executable: true,
    deliverableKind: null,
    hasContent: false,
    stepBody: typeof step.body === "string" ? step.body : null,
    link: null,
    rows: ec?.rows ?? null,
    execClass: input.execClass,
    siteBuilder: "unknown",
    targetKind: typeof step.target?.kind === "string" ? step.target.kind : null,
    stepIntent: (CARD_INTENTS as readonly string[]).includes(step.intent as string) ? (step.intent as CardIntent) : null,
  });
}

function withSubjectRefs(input: ExecActionInput): Record<string, unknown> {
  const step = (input.body.step ?? {}) as { body?: unknown; evidence?: unknown };
  const refs = cardSubjectRefs({
    title: input.title,
    stepBody: typeof step.body === "string" ? step.body : null,
    evidence: step.evidence,
    execPayload: input.execPayload,
  });
  return refs.ids.length || refs.names.length ? { ...input.body, [SUBJECT_REFS_KEY]: refs } : input.body;
}

export type ExecActionResult = { id: string; replayed: boolean; kept?: boolean };

export type ExecMatchDeps = {
  loadPool?: typeof loadMatchPool;
  match?: typeof matchRunCards;
  enabled?: () => boolean;
  runChannel?: (tenantId: string, runId: string) => Promise<string | null>;
  alertExhausted?: typeof alertRematchExhausted;
  log?: typeof logEvent;
  runMayAct?: (tenantId: string, runId: string) => Promise<boolean>;
  cgoDoor?: boolean;
};

export type ExecMatch = {
  repeatOf: string | null;
  drop: { decision: "already_done" | "already_rejected"; matchId: string } | null;
  judgedIds: string[] | null;
};

const NO_MATCH: ExecMatch = { repeatOf: null, drop: null, judgedIds: null };

async function readRunChannel(tenantId: string, runId: string): Promise<string | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("agent_runs").select("channel_slug").eq("id", runId).maybeSingle();
    if (error) return null;
    const ch = (data as { channel_slug?: unknown } | null)?.channel_slug;
    return typeof ch === "string" && ch ? ch : null;
  } catch {
    return null;
  }
}

export async function matchExecCard(
  input: ExecActionInput,
  channel: string,
  targetKey: string | null,
  deps: ExecMatchDeps = {},
): Promise<ExecMatch> {
  if (execSkipsMatcher(input.execClass) || !(deps.enabled ?? matcherEnabled)()) return NO_MATCH;
  const tid = asTenantId(input.tenantId);
  const pool = await (deps.loadPool ?? loadMatchPool)(tid, channel, Date.now(), targetKey ? [targetKey] : []);
  if (pool.readFailed === true) return NO_MATCH;
  const step = (input.body.step ?? {}) as { body?: unknown };
  const fresh: FreshCard[] = [
    {
      ref: "n0",
      title: input.title,
      summary: summarize(typeof step.body === "string" ? step.body : input.title),
      action_type: input.actionType,
      target: execCardTarget(input.execClass, input.execPayload),
    },
  ];
  const judgedIds = pool.map((p) => p.id);
  if (!hasMatchCandidates(fresh, pool)) return { repeatOf: null, drop: null, judgedIds };
  const m = await (deps.match ?? matchRunCards)(channel, fresh, pool);
  if (!m) return NO_MATCH;
  const v = m.verdicts[0];
  void (deps.log ?? logEvent)({
    level: "info",
    source: "channel_actions.match",
    code: "channel.exec_card_matched",
    message: `channel=${channel} class=${input.execClass} decision=${v?.decision ?? "new"} pool=${pool.length}`,
    tenant_id: input.tenantId,
    run_id: input.runId,
    meta: { input_tokens: m.input_tokens, output_tokens: m.output_tokens },
  });
  if (v && isDropped(v) && (v.decision === "already_done" || v.decision === "already_rejected") && v.match_id) {
    return { repeatOf: null, drop: { decision: v.decision, matchId: v.match_id }, judgedIds };
  }
  return { repeatOf: v && isReplace(v) ? v.match_id : null, drop: null, judgedIds };
}

export async function recordChannelExecAction(
  input: ExecActionInput,
  rpc: typeof tenantRpc = tenantRpc,
  deps: ExecMatchDeps = {},
): Promise<ExecActionResult> {
  if ("approval_envelope" in input.execPayload || "approval_envelope" in input.body) {
    const { approval_envelope: _p, ...execPayload } = input.execPayload;
    const { approval_envelope: _b, ...body } = input.body;
    void (deps.log ?? logEvent)({
      level: "warn",
      source: "channel_actions.record",
      code: "channel.envelope_field_stripped",
      message: `class=${input.execClass}`,
      tenant_id: input.tenantId,
      run_id: input.runId,
    });
    input = { ...input, execPayload, body };
  }
  {
    const execPayload = serverFounderMarks(input.execClass, input.execPayload, input.serverFounder ?? null) as Record<string, unknown>;
    const body = serverFounderMarks(input.execClass, input.body, null) as Record<string, unknown>;
    if (FOUNDER_MARKS.some((k) => k in input.execPayload && input.execPayload[k] !== execPayload[k]) || body !== input.body) {
      void (deps.log ?? logEvent)({
        level: "warn",
        source: "channel_actions.record",
        code: "channel.founder_mark_rebuilt",
        message: `class=${input.execClass}`,
        tenant_id: input.tenantId,
        run_id: input.runId,
      });
    }
    input = { ...input, execPayload, body };
  }
  {
    const { withoutApprovalClaim, cardBodyWithoutApprovalClaim } = await import("./approval-claim");
    const execPayload = withoutApprovalClaim(input.execPayload);
    const body = cardBodyWithoutApprovalClaim(input.body);
    if (execPayload !== input.execPayload || body !== input.body) input = { ...input, execPayload, body };
  }
  const tid = asTenantId(input.tenantId);
  const card = execPresentation(input, input.execClass.split(".")[0]);
  const targetKey = targetKeyOf(execCardTarget(input.execClass, input.execPayload));
  const channel = input.channelSlug ?? (await (deps.runChannel ?? readRunChannel)(input.tenantId, input.runId));
  const baseAction = {
    exec_class: input.execClass,
    exec_payload: input.execPayload,
    action_type: input.actionType,
    title: input.title,
    body: { ...withSubjectRefs(input), intent: card.intent, owner: card.owner },
    card_kind: card.card_kind,
    primary_label: card.primary_label,
    done_label: card.done_label,
    how_to: card.how_to,
    target_key: targetKey,
  };
  let out: { ok?: boolean; id?: string; code?: string; replayed?: boolean; kept?: boolean; replaced?: number; repeat_of?: string | null } = {};
  for (let attempt = 0; ; attempt++) {
    const unjudged = attempt >= 2;
    const m = unjudged || channel === null ? NO_MATCH : await matchExecCard(input, channel, targetKey, deps);
    if (m.drop) {
      throw new ExpectedToolError(
        m.drop.decision === "already_done" ? "channel_card_already_done" : "channel_card_already_rejected",
        m.drop.decision === "already_done"
          ? `Not filed: the founder already approved the same change (card ${m.drop.matchId}).`
          : `Not filed: the founder already turned down the same change (card ${m.drop.matchId}). Propose it again only with a new fact that changes the answer.`,
      );
    }
    const { data, error } = await rpc(tid, "record_channel_exec_action", {
      p_run_id: input.runId,
      p_action: { ...baseAction, repeat_of: m.repeatOf, judged_ids: m.judgedIds },
    });
    if (error) throw new Error(`record_channel_exec_action failed: ${error.message}`);
    out = (data ?? {}) as typeof out;
    if (out.ok === false && out.code === "rematch") {
      if (unjudged) throw new Error("record_channel_exec_action refused: rematch on an unjudged card");
      void (deps.log ?? logEvent)({
        level: "info",
        source: "channel_actions.match",
        code: "channel.card_rematch",
        message: `channel=${channel ?? "?"} class=${input.execClass} attempt=${attempt + 1}`,
        tenant_id: input.tenantId,
        run_id: input.runId,
      });
      if (attempt === 1) {
        await (deps.alertExhausted ?? alertRematchExhausted)({
          tenantId: input.tenantId,
          runId: input.runId,
          channelSlug: channel ?? "unknown",
          scope: "exec",
          targetKey,
        }, { rpc });
      }
      continue;
    }
    break;
  }
  if (!out.ok || !out.id) {
    const { EmitNoWriteError } = await import("@/services/agents/emit-no-write");
    throw new EmitNoWriteError(`record_channel_exec_action refused: ${out.code ?? "unknown"}`);
  }
  if (out.kept === true) {
    void (deps.log ?? logEvent)({
      level: "info",
      source: "channel_actions.record",
      code: "channel.exec_card_kept",
      message: `class=${input.execClass} kept=${out.id}`,
      tenant_id: input.tenantId,
      run_id: input.runId,
    });
    return { id: out.id, replayed: false, kept: true };
  }
  if (Number(out.replaced ?? 0) > 0) {
    void (deps.log ?? logEvent)({
      level: "info",
      source: "channel_actions.record",
      code: "channel.exec_card_replaced",
      message: `class=${input.execClass} id=${out.id} replaced=${out.replaced} repeat_of=${out.repeat_of ?? "none"}`,
      tenant_id: input.tenantId,
      run_id: input.runId,
    });
  }
  if (isEnvelopeCreateClass(input.execClass)) {
    const { envelopeDoor, EnvelopeSendError } = await import("@/services/approvals/envelope-door");
    try {
      const r = await envelopeDoor(input, out.id);
      void (deps.log ?? logEvent)({
        level: "info",
        source: "channel_actions.envelope",
        code: r.approved ? "channel.envelope_approved" : "channel.envelope_skipped",
        message: `class=${input.execClass} id=${out.id} ${r.approved ? `envelope=${r.envelope_id}` : `reason=${r.reason}`}`,
        tenant_id: input.tenantId,
        run_id: input.runId,
      });
      if (r.approved) return { id: out.id, replayed: out.replayed === true };
      if (r.reason.startsWith("supersede_")) return { id: out.id, replayed: out.replayed === true };
    } catch (e) {
      if (e instanceof EnvelopeSendError) throw e;
      console.warn(`[envelope-door] ${out.id} left for a person: ${(e as Error).message}`);
    }
  }
  if (reachesCgoAdDoor(input.execClass) && deps.cgoDoor !== false) {
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    await cgoApproveChannelAction(input.tenantId, out.id);
  }
  const { isEmailSendClass } = await import("@/services/growth/unattended-email");
  if (isEmailSendClass(input.execClass)) {
    const mayAct = deps.runMayAct ?? (await import("@/services/agents/run-may-act")).runMayActNow;
    if (await mayAct(input.tenantId, input.runId)) {
      const { cgoApproveEmailChannelAction } = await import("@/services/growth/cgo-email");
      await cgoApproveEmailChannelAction(input.tenantId, out.id, { run_id: input.runId, mayAct });
    } else {
      void (deps.log ?? logEvent)({
        level: "info",
        source: "channel_actions.record",
        code: "channel.email_door_skipped_run_stopped",
        message: `class=${input.execClass} id=${out.id}: run stopped, agent killed or unreadable; left for the founder`,
        tenant_id: input.tenantId,
        run_id: input.runId,
      });
    }
  }
  return { id: out.id, replayed: out.replayed === true };
}

const ENVELOPE_CREATE_CLASSES: ReadonlySet<string> = new Set([
  "chatgpt_ads.create_and_launch",
  "tiktok_ads.create_launch",
  "meta_ads.launch_campaign",
  "google_ads.create_campaign",
  "x_ads.create_campaign",
  "linkedin_ads.launch_campaign",
]);
export function isEnvelopeCreateClass(execClass: string): boolean {
  return ENVELOPE_CREATE_CLASSES.has(execClass);
}

export function reachesCgoAdDoor(execClass: string): boolean {
  if (PERSON_ONLY_EXEC_CLASSES.has(execClass)) return false;
  return /^(meta_ads|google_ads|chatgpt_ads)\./.test(execClass) || execClass === "reddit_ads.prepare_campaign" || execClass === "reddit_ads.launch_campaign" || execClass === "reddit_ads.replace_creative" || execClass === "linkedin_ads.launch_campaign" || LINKEDIN_CGO_DOOR_CLASSES.has(execClass);
}

export type ApproveResult =
  | { ok: true; attempt: number; alreadyQueued: boolean; stillQueued?: boolean; replayed: boolean }
  | { ok: false; code: string; detail?: string };

async function checkPairedAction(tenantId: string, actionId: string, payload: unknown): Promise<import("@/services/growth/move-group").PairVerdict> {
  const mg = await import("@/services/growth/move-group");
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select("exec_class")
      .eq("id", actionId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const cls = (data as { exec_class?: string | null } | null)?.exec_class;
    if (!cls) return { kind: "go" };
    return await mg.checkPairedLeg(tenantId, { id: actionId, exec_class: cls, body: payload });
  } catch {
    return { kind: "wait", why: "unreadable", legs: [] };
  }
}

async function readExecPayload(tenantId: string, actionId: string): Promise<unknown> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("exec_payload")
    .eq("id", actionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { exec_payload?: unknown } | null)?.exec_payload ?? null;
}

export async function approveChannelAction(
  tenantId: string,
  args: { actionId: string; eventKey: string; actorUserId: string; source?: "staff" | "cgo" | "email" | null },
  rpc: typeof tenantRpc = tenantRpc,
  readPayload: (tenantId: string, actionId: string) => Promise<unknown> = readExecPayload,
  checkPaired: typeof checkPairedAction = checkPairedAction,
): Promise<ApproveResult> {
  let payload: unknown;
  try {
    payload = await readPayload(tenantId, args.actionId);
  } catch {
    return { ok: false, code: args.source === "cgo" ? "founder_order_unreadable" : "paired_move_unreadable" };
  }
  if (args.source === "cgo") {
    const origin = (payload && typeof payload === "object" ? (payload as { origin?: unknown }).origin : undefined);
    if (isPersonOnlyOrigin(origin)) return { ok: false, code: "founder_order" };
  }
  const { moveGroupOf, pairWaitMessage } = await import("@/services/growth/move-group");
  if (moveGroupOf(payload)) {
    const v = await checkPaired(tenantId, args.actionId, payload);
    if (v.kind === "wait") return { ok: false, code: "paired_move_waits", detail: pairWaitMessage(v.why) };
  }
  const { data, error } = await rpc(asTenantId(tenantId), "approve_channel_action", {
    p_action_id: args.actionId,
    p_event_key: args.eventKey,
    p_actor_user_id: args.actorUserId,
    p_source: args.source ?? null,
  });
  if (error) throw new Error(`approve_channel_action failed: ${error.message}`);
  const out = (data ?? {}) as {
    ok?: boolean;
    code?: string;
    attempt?: number;
    queued?: boolean;
    exec_status?: string;
    replayed?: boolean;
  };
  if (!out.ok) return { ok: false, code: out.code ?? "refused" };
  return {
    ok: true,
    attempt: Number(out.attempt ?? 1),
    alreadyQueued: out.queued === true,
    stillQueued: out.exec_status === "queued",
    replayed: out.replayed === true,
  };
}

export type ClaimedExecAction = {
  claim_id: string;
  tenant_id: string;
  channel_slug: string;
  exec_class: string;
  exec_payload: Record<string, unknown>;
  approved_by: string | null;
  approved_by_source: string | null;
  agent_run_id: string | null;
};

export type ClaimResult =
  | { ok: true; row: ClaimedExecAction }
  | { ok: false; code: "not_found" }
  | {
      ok: false;
      code: "not_queued";
      tenant_id: string;
      exec_status: string | null;
      lease_expired: boolean;
    };

export function toClaimResult(data: unknown): ClaimResult {
  const out = (data ?? {}) as Record<string, unknown>;
  if (out.ok === true) {
    return {
      ok: true,
      row: {
        claim_id: String(out.claim_id ?? ""),
        tenant_id: String(out.tenant_id),
        channel_slug: String(out.channel_slug ?? ""),
        exec_class: String(out.exec_class ?? ""),
        exec_payload: (out.exec_payload ?? {}) as Record<string, unknown>,
        approved_by: typeof out.approved_by === "string" ? out.approved_by : null,
        approved_by_source:
          typeof out.approved_by_source === "string" ? out.approved_by_source : null,
        agent_run_id: typeof out.agent_run_id === "string" ? out.agent_run_id : null,
      },
    };
  }
  if (out.code === "not_queued") {
    return {
      ok: false,
      code: "not_queued",
      tenant_id: String(out.tenant_id ?? ""),
      exec_status: typeof out.exec_status === "string" ? out.exec_status : null,
      lease_expired: out.lease_expired === true,
    };
  }
  return { ok: false, code: "not_found" };
}

export async function settleChannelActionExec(
  tenantId: string,
  args: {
    actionId: string;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string | null;
    claimId?: string | null;
    execClass: string;
  },
  rpc: typeof tenantRpc = tenantRpc,
  nudge: () => void = nudgeOpsAlertDrain,
  retire: typeof retireStaleBudgetProposals = retireStaleBudgetProposals,
): Promise<{ ok: boolean; code?: string; replayed: boolean }> {
  const founderStopped = !args.ok && (args.result as { code?: unknown } | undefined)?.code === "founder_stopped";
  const verdict = args.ok || founderStopped ? null : verdictFor(args.result ?? { error: args.error ?? null }, typeof args.execClass === "string" ? args.execClass : "");
  const { note, ...stamp } = verdict ?? { note: null };
  const { data, error } = await rpc(asTenantId(tenantId), "settle_channel_action_exec", {
    p_action_id: args.actionId,
    p_ok: args.ok,
    p_result: verdict ? { ...(args.result ?? {}), ...stamp } : args.result ?? {},
    p_error: note ?? args.error ?? null,
    p_claim_id: args.claimId ?? null,
  });
  if (error) throw new Error(`settle_channel_action_exec failed: ${error.message}`);
  const out = (data ?? {}) as { ok?: boolean; code?: string; replayed?: boolean };
  const landed = out.ok === true && out.replayed !== true;
  if (landed && verdict?.bucket === "blocked_on_us") nudge();
  if (landed && verdict) await alertFounderOnFailure(tenantId, args.execClass);
  if (out.ok === true && args.ok) await retire(tenantId, { kind: "channel_action", id: args.actionId, execClass: args.execClass });
  return { ok: out.ok === true, code: out.code, replayed: out.replayed === true };
}

async function alertFounderOnFailure(tenantId: string, execClass: string): Promise<void> {
  try {
    const { isExecutableAdClass } = await import("@/services/growth/unattended-policy");
    if (typeof execClass !== "string" || !isExecutableAdClass(execClass)) return;
    const { alertFounderSafely } = await import("@/services/growth/cgo-blockers");
    await alertFounderSafely(tenantId, "failed ad change");
  } catch (e) {
    console.warn(`[exec-actions] founder alert for a failed ${execClass} not sent: ${(e as Error).message}`);
  }
}

export async function reconcileChannelActionExec(
  tenantId: string,
  args: { actionId: string; ok: boolean; result: Record<string, unknown>; error?: string | null; execClass: string },
  rpc: typeof tenantRpc = tenantRpc,
  retire: typeof retireStaleBudgetProposals = retireStaleBudgetProposals,
): Promise<{ ok: boolean; code?: string; replayed: boolean }> {
  const verdict = args.ok ? null : verdictFor(args.result, args.execClass);
  const { note, ...stamp } = verdict ?? { note: null };
  const { data, error } = await rpc(asTenantId(tenantId), "reconcile_channel_action_exec", {
    p_action_id: args.actionId,
    p_ok: args.ok,
    p_result: verdict ? { ...args.result, ...stamp } : args.result,
    p_error: note ?? args.error ?? null,
  });
  if (error) throw new Error(`reconcile_channel_action_exec failed: ${error.message}`);
  const out = (data ?? {}) as { ok?: boolean; code?: string; replayed?: boolean };
  if (out.ok === true && args.ok) await retire(tenantId, { kind: "channel_action", id: args.actionId, execClass: args.execClass });
  return { ok: out.ok === true, code: out.code, replayed: out.replayed === true };
}

export async function setChannelActionVideoMedia(
  tenantId: string,
  args: {
    actionId: string;
    runId: string;
    claimId: string | null;
    ok: boolean;
    media?: Record<string, unknown> | null;
    error?: string | null;
    code?: string | null;
  },
  rpc: typeof tenantRpc = tenantRpc,
  nudge: () => void = nudgeOpsAlertDrain,
): Promise<{ ok: boolean; code?: string; replayed: boolean }> {
  const verdict = args.ok ? null : verdictFor({ error: args.error ?? null, code: args.code ?? null }, GENERATED_VIDEO_EXEC_CLASS);
  const { data, error } = await rpc(asTenantId(tenantId), "set_channel_action_video_media", {
    p_action_id: args.actionId,
    p_run_id: args.runId,
    p_claim_id: args.claimId,
    p_ok: args.ok,
    p_media: args.media ?? null,
    p_error: args.error ?? null,
    p_code: args.code ?? null,
    p_verdict: verdict,
  });
  if (error) throw new Error(`set_channel_action_video_media failed: ${error.message}`);
  const out = (data ?? {}) as { ok?: boolean; code?: string; replayed?: boolean };
  const landed = out.ok === true && out.replayed !== true;
  if (landed && verdict?.bucket === "blocked_on_us") nudge();
  return { ok: out.ok === true, code: out.code, replayed: out.replayed === true };
}
