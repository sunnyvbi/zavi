import {
  buildEnvelope,
  createMatchesAsk,
  createOf,
  claimApprovalEnvelope,
  readApprovalEnvelope,
  readFounderAsk,
  setApprovalEnvelope,
  verifyEnvelope,
  type ApprovalEnvelope,
} from "./approval-envelope";

import { ENVELOPE_CREATE_CLASSES } from "./envelope-classes";
import { isPartialRiskExecCode } from "@zavi/shared";

export class EnvelopeSendError extends Error {}

export type EnvelopeDoorResult =
  | { approved: true; actor_user_id: string; envelope_id: string }
  | { approved: false; reason: string };

export type EnvelopeDoorDeps = {
  readFounderAsk?: typeof readFounderAsk;
  readEnvelope?: typeof readApprovalEnvelope;
  setEnvelope?: typeof setApprovalEnvelope;
  claim?: typeof claimApprovalEnvelope;
  verify?: typeof verifyEnvelope;
  sourceDecisionEnvelope?: (tenant_id: string, run_id: string) => Promise<ApprovalEnvelope | null>;
  approve?: (tenant_id: string, args: { actionId: string; eventKey: string; actorUserId: string }) => Promise<{ ok: boolean; attempt?: number; replayed?: boolean; stillQueued?: boolean; code?: string }>;
  send?: (ev: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
  enabled?: () => Promise<boolean>;
  supersede?: (tenant_id: string, new_action_id: string) => Promise<{ ok: boolean; code?: string; superseded?: string[] }>;
  linkedinEverRan?: (tenant_id: string, binding_id: string) => Promise<boolean>;
};

async function supersedeByDirectAsk(tenant_id: string, new_action_id: string): Promise<{ ok: boolean; code?: string; superseded?: string[] }> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "supersede_channel_actions_by_direct_ask", { p_new_id: new_action_id });
  if (error) throw new Error(`supersede_channel_actions_by_direct_ask failed: ${error.message}`);
  const out = (data ?? {}) as { ok?: boolean; code?: string; superseded?: string[] };
  return { ok: out.ok === true, ...(out.code ? { code: out.code } : {}), superseded: Array.isArray(out.superseded) ? out.superseded : [] };
}

async function sourceDecisionEnvelopeOf(tenant_id: string, run_id: string): Promise<ApprovalEnvelope | null> {
  const { runSourceEnvelope } = await import("./approval-envelope");
  return runSourceEnvelope(tenant_id, run_id);
}

export async function envelopeDoor(
  input: { tenantId: string; runId: string; execClass: string; execPayload: Record<string, unknown> },
  action_id: string,
  deps: EnvelopeDoorDeps = {},
): Promise<EnvelopeDoorResult> {
  const enabled = deps.enabled ?? (async () => (await import("@/services/growth/ads-no-friction-flag")).adsNoFrictionEnabled());
  if (!(await enabled())) return { approved: false, reason: "switch_off" };
  const readEnv = deps.readEnvelope ?? readApprovalEnvelope;
  const setEnv = deps.setEnvelope ?? setApprovalEnvelope;

  if (input.execClass === "linkedin_ads.launch_campaign") {
    const everRan = deps.linkedinEverRan ?? (async (tenant_id: string, binding: string) => (await import("@/services/ads-wallet/linkedin-launch")).linkedinCampaignEverRan(tenant_id, binding));
    const binding = input.execPayload.campaign_binding_id;
    if (typeof binding !== "string" || (await everRan(input.tenantId, binding).catch(() => true))) return { approved: false, reason: "relaunch_needs_card" };
  }
  let env = await readEnv(input.tenantId, "channel_actions", action_id);
  const stored = !!env;
  if (!env) {
    const fa = await (deps.readFounderAsk ?? readFounderAsk)(input.tenantId, input.runId);
    if (fa?.approver && fa.shape.kind === "plan") {
      if (!createMatchesAsk(fa.ask, createOf(input.execClass, input.execPayload))) return { approved: false, reason: "create_not_the_ask" };
      env = buildEnvelope({ envelope_id: fa.envelope_id, tenant_id: input.tenantId, approver: fa.approver, plan: fa.shape.plan });
    } else if (!fa) {
      env = await (deps.sourceDecisionEnvelope ?? sourceDecisionEnvelopeOf)(input.tenantId, input.runId);
    }
    if (!env) return { approved: false, reason: fa && !fa.approver ? "not_owner_admin" : "no_envelope" };
  }
  const verdict = await (deps.verify ?? verifyEnvelope)(input.tenantId, env, input.execClass, input.execPayload);
  if (!verdict.ok) return { approved: false, reason: verdict.reason };
  const claim = await (deps.claim ?? claimApprovalEnvelope)(input.tenantId, env.envelope_id, action_id);
  if (!claim.ok) return { approved: false, reason: `claim_${claim.code ?? "refused"}` };
  if (!stored) {
    const set = await setEnv(input.tenantId, "channel_actions", action_id, env);
    if (!set.ok) return { approved: false, reason: `set_${set.code ?? "refused"}` };
  }

  if (env.envelope_id.startsWith("ask:")) {
    try {
      const sup = await (deps.supersede ?? supersedeByDirectAsk)(input.tenantId, action_id);
      if (!sup.ok) return { approved: false, reason: `supersede_${sup.code ?? "refused"}` };
    } catch {
      return { approved: false, reason: "supersede_failed" };
    }
  }

  const approve =
    deps.approve ??
    (async (tenant_id: string, args: { actionId: string; eventKey: string; actorUserId: string }) =>
      (await import("@/services/channels/exec-actions")).approveChannelAction(tenant_id, { ...args, source: null }));
  const r = await approve(input.tenantId, { actionId: action_id, eventKey: `env:${action_id}`, actorUserId: env.actor_user_id });
  if (!r.ok) return { approved: false, reason: `approve_${r.code ?? "refused"}` };
  if (!r.replayed || r.stillQueued) {
    const send = deps.send ?? (async (ev) => (await import("@/../workers/client")).inngest.send(ev as never));
    try {
      await send({ id: `approve:${action_id}:${r.attempt ?? 1}`, name: "channel-action.approved", data: { action_id } });
    } catch (e) {
      throw new EnvelopeSendError(`envelope approval of ${action_id} committed but its event was not sent: ${(e as Error).message}`);
    }
  }
  return { approved: true, actor_user_id: env.actor_user_id, envelope_id: env.envelope_id };
}

export async function founderEnvelopeCovers(d: { id: string; tenant_id: string; approved_by?: string | null; approved_by_source?: string | null }, channel: string): Promise<boolean> {
  try {
    const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
    if (!(await adsNoFrictionEnabled())) return false;
    if (!d.approved_by || d.approved_by_source != null) return false;
    const { readApprovalEnvelope } = await import("@/services/approvals/approval-envelope");
    const env = await readApprovalEnvelope(d.tenant_id, "decisions", d.id);
    if (!env || env.tenant_id !== d.tenant_id || env.channel !== channel || env.actor_user_id !== d.approved_by) return false;
    const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
    const role = await loadTenantRoleFor(env.actor_user_id, d.tenant_id);
    return role === "owner" || role === "admin";
  } catch {
    return false;
  }
}

export async function envelopeLaunchSwitchedOff(
  row: { tenant_id: string; exec_class: string },
  action_id: string,
  deps: { readEnvelope?: typeof readApprovalEnvelope; enabled?: () => Promise<boolean> } = {},
): Promise<boolean> {
  if (!ENVELOPE_CREATE_CLASSES.has(row.exec_class)) return false;
  let env: ApprovalEnvelope | null;
  try {
    env = await (deps.readEnvelope ?? readApprovalEnvelope)(row.tenant_id, "channel_actions", action_id);
  } catch {
    return true;
  }
  if (!env) return false;
  const enabled = deps.enabled ?? (async () => (await import("@/services/growth/ads-no-friction-flag")).adsNoFrictionEnabled());
  return !(await enabled());
}

export type FounderEnvelopeVerdict = "none" | "valid" | "invalid";

export async function founderEnvelopeVerdict(
  d: { id: string; tenant_id: string; decision_class: string; body: unknown; approved_by?: string | null; approved_by_source?: string | null; exec_source?: string },
  channel: string,
  deps: { readEnvelope?: typeof readApprovalEnvelope; enabled?: () => Promise<boolean>; verify?: typeof verifyEnvelope } = {},
): Promise<FounderEnvelopeVerdict> {
  if (d.exec_source !== "channel_actions" || !d.approved_by || d.approved_by_source != null) return "none";
  let env: ApprovalEnvelope | null;
  try {
    env = await (deps.readEnvelope ?? readApprovalEnvelope)(d.tenant_id, "channel_actions", d.id);
  } catch {
    return "invalid";
  }
  if (!env || env.actor_user_id !== d.approved_by) return "none";
  try {
    if (env.tenant_id !== d.tenant_id || env.channel !== channel) return "invalid";
    const enabled = deps.enabled ?? (async () => (await import("@/services/growth/ads-no-friction-flag")).adsNoFrictionEnabled());
    if (!(await enabled())) return "invalid";
    const v = await (deps.verify ?? verifyEnvelope)(d.tenant_id, env, d.decision_class, d.body);
    return v.ok ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

export async function founderEnvelopeApprovedAction(
  d: Parameters<typeof founderEnvelopeVerdict>[0],
  channel: string,
  deps: Parameters<typeof founderEnvelopeVerdict>[2] = {},
): Promise<boolean> {
  return (await founderEnvelopeVerdict(d, channel, deps)) === "valid";
}

export type DirectAskOutcome = { closed: Array<{ id: string; title: string }>; inFlight: boolean; approved?: boolean | null; olderOpen?: boolean; uncertain?: { id: string; title: string } | null };

function mayBePartlyOn(r: { status: string; exec_status: string | null; exec_result?: Record<string, unknown> | null }): boolean {
  if ((r.status !== "pending" && r.status !== "snoozed") || r.exec_status !== "failed") return false;
  const x = r.exec_result ?? {};
  return isPartialRiskExecCode(typeof x.code === "string" ? x.code : null) || x.bucket === "partial_risk" || "interrupted" in x || "lease_expired" in x;
}

export async function directAskOutcome(tenant_id: string, action_id: string): Promise<DirectAskOutcome> {
  const none: DirectAskOutcome = { closed: [], inFlight: false };
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const db = tenantClient(asTenantId(tenant_id));
    type Row = { id: string; channel_slug: string; exec_class: string | null; exec_status: string | null; status: string; title: string; exec_result: Record<string, unknown> | null };
    const cols = "id, channel_slug, exec_class, exec_status, status, title, exec_result";
    const { data: fresh } = await db.from("channel_actions").select(cols).eq("id", action_id).maybeSingle();
    const n = fresh as Row | null;
    if (!n?.exec_class) return none;
    const { data: evs } = await db.from("channel_action_events").select("action_id").eq("event_key", `direct_ask:${action_id}`);
    const closedIds = new Set(((evs ?? []) as Array<{ action_id: string }>).map((e) => e.action_id));
    const { data } = await db.from("channel_actions").select(cols).eq("channel_slug", n.channel_slug);
    const rows = ((data ?? []) as Row[]).filter((r) => r.id !== n.id && ENVELOPE_CREATE_CLASSES.has((r.exec_class ?? "").replace(/_review$/, "")));
    const inFlight = n.exec_status == null
      && rows.some((r) => r.exec_status === "queued" || r.exec_status === "dispatching" || (r.exec_status === "executed" && (r.status === "pending" || r.status === "snoozed")));
    const olderOpen = rows.some((r) => (r.status === "pending" || r.status === "snoozed") && r.exec_status == null);
    const u = mayBePartlyOn(n) ? n : rows.find(mayBePartlyOn) ?? null;
    const uncertain = u ? { id: u.id, title: u.title } : null;
    return { closed: rows.filter((r) => closedIds.has(r.id)).map((r) => ({ id: r.id, title: r.title })), inFlight, approved: uncertain ? false : n.exec_status != null, olderOpen, uncertain };
  } catch {
    return none;
  }
}

export function directAskOutcomeLine(o: DirectAskOutcome, channelName: string): string | null {
  if (o.uncertain) return `An earlier ${channelName} launch ('${o.uncertain.title}') may have partly gone through, so I did not start another one. Check it in ${channelName} Ads, then dismiss its card and ask again.`;
  if (o.inFlight) return `Your earlier ${channelName} ad is already launching, so I did not start a second one. This one is a card for you to approve only if you want both.`;
  if (o.approved === false) {
    return o.olderOpen
      ? `I couldn't close the older ${channelName} card, so this one is waiting for your approval.`
      : `This ${channelName} ad is a card waiting for your approval.`;
  }
  if (o.closed.length === 0) return null;
  const n = o.closed.length;
  return `I also closed ${n === 1 ? "1 older" : `${n} older`} ${channelName} launch card${n === 1 ? "" : "s"}: ${o.closed.map((c) => `'${c.title}'`).join(", ")}.`;
}

export async function directAskSay(tenant_id: string, action_id: unknown, line: string | undefined, channelName: string): Promise<string | undefined> {
  if (typeof action_id !== "string") return line;
  const extra = directAskOutcomeLine(await directAskOutcome(tenant_id, action_id), channelName);
  if (!extra) return line;
  return extra.startsWith("I also closed") ? [line, extra].filter(Boolean).join(" ") : extra;
}
