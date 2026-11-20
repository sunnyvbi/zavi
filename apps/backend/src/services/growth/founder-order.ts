
import type { SupabaseClient } from "@supabase/supabase-js";
import { isResumeHop, MAX_RESUME_HOPS, resolveChatTurnChain } from "@/services/agents/run-owner";
import { FOUNDER_REF_UNREADABLE, parseFounderMessageRef } from "@/services/approvals/founder-message";
import {
  carriesCapturedPageContext,
  isFounderChatOrder,
  isUntrustedContextPayload,
} from "@/services/agents/untrusted-context";
import { logEvent } from "@/services/logging/logEvent";
import { serverFounderMarks, type ServerFounder } from "./founder-marks";

export { serverFounderMarks } from "./founder-marks";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function carriesForeignWords(payload: unknown): boolean {
  return isUntrustedContextPayload(payload) || carriesCapturedPageContext(payload);
}

export type FounderOrderClaim = {
  id: string;
  tenant_id: string;
  trigger: string | null | undefined;
  payload: unknown;
  enqueued_by?: string | null;
  agent_slug?: string | null;
};

export type FounderOrderResolution = {
  founder: boolean;
  card_thread_id: string | null;
  card_agent_slug: string | null;
  card_run_id: string | null;
  order_root_id?: string | null;
  unverified?: true;
};

export const NOT_A_FOUNDER_ORDER: FounderOrderResolution = { founder: false, card_thread_id: null, card_agent_slug: null, card_run_id: null };

const FOUNDER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export type FounderOrderDeps = {
  roleOf: (user_id: string, tenant_id: string) => Promise<string | null>;
  founderMessageOf: (run: import("@/services/approvals/founder-message").FounderRunRow) => Promise<import("@/services/approvals/founder-message").FounderMessage | null>;
  slackMemberOf: (tenant_id: string, slack: Record<string, unknown>) => Promise<string | null>;
};

async function defaultDeps(): Promise<FounderOrderDeps> {
  const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
  const fm = await import("@/services/approvals/founder-message");
  return {
    roleOf: loadTenantRoleFor,
    founderMessageOf: (run) => fm.founderMessageOf(run, { strict: true, anyAge: true }),
    slackMemberOf: (tenant_id, slack) => fm.slackApproverOf(tenant_id, slack, true),
  };
}

function isSlackDm(payload: Record<string, unknown>): boolean {
  const s = obj(payload.slack);
  const channel = str(s.channel_id);
  return !!channel && channel.startsWith("D") && !!str(s.user) && !!str(s.team_id);
}

function isChildPayload(p: Record<string, unknown>): boolean {
  return p._delegation_lineage_id !== undefined || p.handoff_child === true || p.slack_handoff_child === true || p.founder_message_ref !== undefined;
}

function candidateOf(claim: FounderOrderClaim, payload: Record<string, unknown>): "chat" | "handoff" | "slack" | null {
  if (claim.trigger === "chat") return "chat";
  if (claim.enqueued_by !== null) return null;
  if (claim.trigger === "handoff") {
    const kind = parseFounderMessageRef(payload.founder_message_ref)?.kind;
    if (kind === "chat" || kind === "slack" || payload[FOUNDER_REF_UNREADABLE] === true) return "handoff";
    return str(payload.resume_of_run_id) ? "handoff" : null;
  }
  if (claim.trigger === "slack" && isSlackDm(payload) && !isChildPayload(payload)) return "slack";
  return null;
}

function unverifiedOrder(order_root_id: string | null = null): FounderOrderResolution {
  return { founder: true, unverified: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id };
}

async function unverifiedRoot(db: Pick<SupabaseClient, "from">, claim: FounderOrderClaim): Promise<string | null> {
  if (claim.enqueued_by !== null) return claim.trigger === "chat" && !str(obj(claim.payload).resume_of_run_id) ? claim.id : null;
  try {
    const origin = await resumeOrigin(db, claim);
    if (!origin) return null;
    return parseFounderMessageRef(origin.payload.founder_message_ref)?.run_id ?? (origin.trigger === "handoff" ? null : origin.id);
  } catch {
    return null;
  }
}

type RunRow = { id: string; agent_slug: string | null; trigger: string | null; enqueued_by: string | null; payload: Record<string, unknown>; enqueued_at: string | null };

async function resumeOrigin(db: Pick<SupabaseClient, "from">, claim: FounderOrderClaim): Promise<RunRow | null> {
  let run: RunRow = { id: claim.id, agent_slug: str(claim.agent_slug), trigger: str(claim.trigger), enqueued_by: claim.enqueued_by ?? null, payload: obj(claim.payload), enqueued_at: null };
  const seen = new Set<string>([claim.id]);
  for (let hop = 0; ; hop++) {
    const prev = run.enqueued_by ? null : str(run.payload.resume_of_run_id);
    if (!prev) return run;
    if (hop >= MAX_RESUME_HOPS || seen.has(prev)) return null;
    seen.add(prev);
    const { data, error } = await db
      .from("agent_runs")
      .select("id, agent_slug, trigger, enqueued_by, payload, enqueued_at")
      .eq("id", prev)
      .eq("tenant_id", claim.tenant_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const r = data as Record<string, unknown> | null;
    const origin: RunRow | null = r
      ? { id: String(r.id), agent_slug: str(r.agent_slug), trigger: str(r.trigger), enqueued_by: str(r.enqueued_by), payload: obj(r.payload), enqueued_at: str(r.enqueued_at) }
      : null;
    if (!isResumeHop(run, origin)) return null;
    run = origin;
  }
}

export async function resolveFounderChatOrder(
  db: Pick<SupabaseClient, "from">,
  claim: FounderOrderClaim,
  injected?: Partial<FounderOrderDeps>,
): Promise<FounderOrderResolution> {
  const payload = obj(claim.payload);
  if (carriesForeignWords(payload) || payload.origin === "staff_console") return NOT_A_FOUNDER_ORDER;
  const kind = candidateOf(claim, payload);
  if (!kind) return NOT_A_FOUNDER_ORDER;
  try {
    const deps = { ...(await defaultDeps()), ...(injected ?? {}) };
    if (kind === "chat") return await chatRunOrder(db, claim, deps);
    const origin = await resumeOrigin(db, claim);
    if (!origin) throw new Error("resume chain does not hold");
    if (kind === "handoff") return await handoffChildOrder(db, claim, origin, deps);
    return await slackRunOrder(claim, origin, deps);
  } catch (e) {
    void logEvent({
      level: "error",
      source: "founder-order",
      code: "founder_order.marker_unverified",
      tenant_id: claim.tenant_id,
      run_id: claim.id,
      message: `founder marker read failed; run treated as an unverified founder order (waits for a tap): ${(e as Error).message}`.slice(0, 500),
      meta: { surface: kind },
    });
    return unverifiedOrder(await unverifiedRoot(db, claim));
  }
}

async function isFounderRole(deps: FounderOrderDeps, user_id: string, tenant_id: string): Promise<boolean> {
  const role = await deps.roleOf(user_id, tenant_id);
  return typeof role === "string" && FOUNDER_ROLES.has(role);
}

async function chatRunOrder(db: Pick<SupabaseClient, "from">, claim: FounderOrderClaim, deps: FounderOrderDeps): Promise<FounderOrderResolution> {
  const chain = await resolveChatTurnChain(db, claim.tenant_id, claim.id);
  if (!chain.ok) {
    const own = obj(claim.payload);
    if (claim.enqueued_by == null && !str(own.resume_of_run_id)) return NOT_A_FOUNDER_ORDER;
    throw new Error(`chat turn chain ${chain.reason}`);
  }
  const root = chain.root_payload;
  if (!chain.root_enqueued_by || str(root.resume_of_run_id) || root.origin === "staff_console") return NOT_A_FOUNDER_ORDER;
  if (chain.payloads.some(carriesForeignWords)) return NOT_A_FOUNDER_ORDER;
  const { data, error } = await db
    .from("agent_thread_messages")
    .select("sender_role, thread_id")
    .eq("id", chain.user_message_id)
    .eq("tenant_id", claim.tenant_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("the turn's message was not found");
  const m = data as { sender_role?: unknown; thread_id?: unknown };
  if (m.thread_id !== chain.thread_id || m.sender_role !== "user") return NOT_A_FOUNDER_ORDER;
  if (!(await isFounderRole(deps, chain.root_enqueued_by, claim.tenant_id))) return NOT_A_FOUNDER_ORDER;
  return { founder: true, card_thread_id: chain.thread_id, card_agent_slug: str(claim.agent_slug), card_run_id: chain.root_run_id, order_root_id: chain.root_run_id };
}

async function slackRunOrder(claim: FounderOrderClaim, origin: RunRow, deps: FounderOrderDeps): Promise<FounderOrderResolution> {
  if (origin.trigger !== "slack" || origin.enqueued_by !== null || !isSlackDm(origin.payload) || isChildPayload(origin.payload)) return NOT_A_FOUNDER_ORDER;
  if (carriesForeignWords(origin.payload)) return NOT_A_FOUNDER_ORDER;
  const member = await deps.slackMemberOf(claim.tenant_id, obj(origin.payload.slack));
  if (!member || !(await isFounderRole(deps, member, claim.tenant_id))) return NOT_A_FOUNDER_ORDER;
  return { founder: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: origin.id };
}

async function handoffChildOrder(
  db: Pick<SupabaseClient, "from">,
  claim: FounderOrderClaim,
  child: RunRow,
  deps: FounderOrderDeps,
): Promise<FounderOrderResolution> {
  if (child.trigger !== "handoff" || child.enqueued_by !== null) return NOT_A_FOUNDER_ORDER;
  const payload = child.payload;
  if (carriesForeignWords(payload)) return NOT_A_FOUNDER_ORDER;
  const ref = parseFounderMessageRef(payload.founder_message_ref);
  if (!ref && payload[FOUNDER_REF_UNREADABLE] === true) throw new Error("founder message ref was unreadable at handoff");
  if (!ref || (ref.kind !== "chat" && ref.kind !== "slack")) return NOT_A_FOUNDER_ORDER;
  const msg = await deps.founderMessageOf({ id: child.id, tenant_id: claim.tenant_id, trigger: "handoff", enqueued_by: null, payload });
  if (!msg || msg.ref.kind !== ref.kind || !msg.author_user_id) return NOT_A_FOUNDER_ORDER;
  if (ref.kind === "slack") return await slackChildOrder(db, claim, msg, deps);
  const opThread = str(payload.operator_thread_id);
  if (!opThread) throw new Error("a chat child carries no operator thread");
  const { data, error } = await db
    .from("agent_runs")
    .select("agent_slug, trigger, enqueued_by, payload")
    .eq("id", msg.ref.run_id)
    .eq("tenant_id", claim.tenant_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const root = data as { agent_slug?: unknown; trigger?: unknown; enqueued_by?: unknown; payload?: unknown } | null;
  if (!root || root.trigger !== "chat" || root.enqueued_by !== msg.author_user_id) return NOT_A_FOUNDER_ORDER;
  const rp = obj(root.payload);
  if (carriesForeignWords(rp) || rp.origin === "staff_console" || str(rp.resume_of_run_id)) return NOT_A_FOUNDER_ORDER;
  if (str(rp.thread_id) !== opThread) return NOT_A_FOUNDER_ORDER;
  if (!(await isFounderRole(deps, msg.author_user_id, claim.tenant_id))) return NOT_A_FOUNDER_ORDER;
  return { founder: true, card_thread_id: opThread, card_agent_slug: str(root.agent_slug), card_run_id: msg.ref.run_id, order_root_id: msg.ref.run_id };
}

async function slackChildOrder(
  db: Pick<SupabaseClient, "from">,
  claim: FounderOrderClaim,
  msg: import("@/services/approvals/founder-message").FounderMessage,
  deps: FounderOrderDeps,
): Promise<FounderOrderResolution> {
  const { data, error } = await db
    .from("agent_runs")
    .select("trigger, enqueued_by, payload")
    .eq("id", msg.ref.run_id)
    .eq("tenant_id", claim.tenant_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const root = data as { trigger?: unknown; enqueued_by?: unknown; payload?: unknown } | null;
  const rp = obj(root?.payload);
  if (!root || root.trigger !== "slack" || root.enqueued_by !== null || !isSlackDm(rp) || isChildPayload(rp) || carriesForeignWords(rp)) return NOT_A_FOUNDER_ORDER;
  if (!msg.author_user_id || !(await isFounderRole(deps, msg.author_user_id, claim.tenant_id))) return NOT_A_FOUNDER_ORDER;
  return { founder: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: msg.ref.run_id };
}

export const REVIEW_SIBLING: Readonly<Record<string, string>> = {
  "meta_ads.update_ad_set_budget": "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget": "meta_ads.update_campaign_budget_review",
  "meta_ads.set_status": "meta_ads.set_status_review",
  "google_ads.update_campaign_budget": "google_ads.update_campaign_budget_review",
  "google_ads.set_status": "google_ads.set_status_review",
};

export const AUTO_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(REVIEW_SIBLING).map(([auto, review]) => [review, auto]),
);

const AD_CLASS = /^(meta_ads|google_ads)\./;

export function isMetaOrGoogleAdClass(cls: string | null | undefined): boolean {
  return typeof cls === "string" && AD_CLASS.test(cls);
}

export type FounderOrderEmitFn = (decision_class: string, body: unknown) => Promise<string>;

export type FounderOrderTrust = Parameters<typeof isFounderChatOrder>[0] & {
  tenant_id: string;
  run_id?: string;
  founder_order_tell?: boolean;
  founder_order_unverified?: boolean;
  founder_order_group?: string;
};

export function serverFounderOf(trust: FounderOrderTrust): ServerFounder {
  if (!isFounderChatOrder(trust)) return null;
  return { group: trust.founder_order_group ?? trust.run_id ?? null, unverified: trust.founder_order_unverified === true };
}

export function founderOrderEmit(
  trust: FounderOrderTrust,
  emit: FounderOrderEmitFn | undefined,
  rail: "decisions" | "channel_actions" = "decisions",
): FounderOrderEmitFn | undefined {
  if (!emit) return emit;
  const founder = serverFounderOf(trust);
  if (!founder) return async (decision_class, body) => emit(decision_class, serverFounderMarks(decision_class, body, null));
  return async (decision_class, body) => {
    if (!AD_CLASS.test(decision_class)) return emit(decision_class, serverFounderMarks(decision_class, body, null));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`founder order: ${decision_class} body is not an object`);
    }
    const cls = rail === "decisions" ? (REVIEW_SIBLING[decision_class] ?? decision_class) : decision_class;
    void logEvent({
      level: "info",
      source: "founder-order",
      code: "founder_order.stamped",
      tenant_id: trust.tenant_id,
      ...(trust.run_id ? { run_id: trust.run_id } : {}),
      meta: {
        decision_class: cls,
        rerouted: cls !== decision_class ? 1 : 0,
        cap_stripped: (body as Record<string, unknown>).authorized_effective_cap !== undefined ? 1 : 0,
        surface: rail,
      },
    });
    const id = await emit(cls, serverFounderMarks(decision_class, body, founder));
    if (rail === "channel_actions" && trust.founder_order_tell === true && typeof id === "string" && id) {
      void import("@/services/approvals/chat-card-delivery").then((m) => m.tellFounderAboutCard(trust.tenant_id, id, "channel_actions")).catch(() => {});
    }
    return id;
  };
}

export function founderTrust(ctx: {
  tenant_id: string;
  run_id?: string;
  run_trigger?: string;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  founder_chat_order?: boolean;
  founder_order_tell?: boolean;
  founder_order_unverified?: boolean;
  founder_order_group?: string;
}): FounderOrderTrust {
  return {
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
    run_trigger: ctx.run_trigger,
    untrusted_context: ctx.untrusted_context,
    captured_page_context: ctx.captured_page_context,
    founder_chat_order: ctx.founder_chat_order,
    founder_order_tell: ctx.founder_order_tell,
    founder_order_unverified: ctx.founder_order_unverified,
    founder_order_group: ctx.founder_order_group,
  };
}

const NOT_A_WARNING: ReadonlySet<string> = new Set([
  "founder_staged_change",
  "founder_requested_change",
  "class_not_on_unattended_list",
  "review_class_never_unattended",
  "no_ad_budget",
  "active_growth_budget_and_autopilot_required",
  "delete_never_unattended",
  "gate_error",
  "body_unreadable",
]);

type AdviceVerdict = { verdict: "allow" | "ask_founder" | "deny"; reasons: string[] };
type AdviceAction = {
  kind: "ad";
  exec_class: string;
  payload: unknown;
  source: { table: "decisions"; id: string; run_id: string | null };
};

export const UNSURE_WHICH_WARNING = "I could not tell which campaign you meant, so check the name on this card";

export async function adviseFounderOrder(
  tenant_id: string,
  decision_id: string,
  decision_class: string,
  body: unknown,
  evaluate: (tenant_id: string, action: AdviceAction) => Promise<AdviceVerdict>,
): Promise<string[]> {
  const { origin: _origin, cut_guard_note: _note, founder_chat_order: _mark, founder_order_unverified: _unv, move_group: _group, run_alone: _alone, match_unsure, verified_name: _vn, ...payload } = obj(body);
  const unsure = match_unsure === "ambiguous_match" ? [UNSURE_WHICH_WARNING] : [];
  const v = await evaluate(tenant_id, {
    kind: "ad",
    exec_class: AUTO_OF[decision_class] ?? decision_class,
    payload,
    source: { table: "decisions", id: decision_id, run_id: null },
  });
  if (v.verdict === "allow") return unsure;
  const { heldReasonWords } = await import("./unattended-policy");
  return [...unsure, ...heldReasonWords(v.reasons.filter((r) => !NOT_A_WARNING.has(r)))].slice(0, 2);
}
