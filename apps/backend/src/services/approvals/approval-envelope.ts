import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { adConstraint } from "@zavi/shared";
import { CHATGPT_CREATE } from "@/services/connectors/chatgpt-ads/growth-actions";
import { TIKTOK_CREATE_LAUNCH_CLASS } from "@/services/connectors/tiktok-ads/held-schema";
import { dailyBudgetDays, type AdPlan } from "@/services/growth/ad-plan-shape";
import { founderMessageOf, type FounderMessage } from "@/services/approvals/founder-message";

export type EnvelopeSurface = "chat" | "email" | "slack" | "web_button" | "cgo_yes";

export type ApprovalEnvelope = {
  v: 1;
  envelope_id: string;
  tenant_id: string;
  actor_user_id: string;
  actor_role: "owner" | "admin";
  surface: EnvelopeSurface;
  channel: string;
  max_total_usd: number;
  max_daily_usd: number | null;
  starts_on: string;
  ends_on: string;
  source_question_id?: string;
};

export type Approver = { user_id: string; role: "owner" | "admin"; surface: EnvelopeSurface };

export function buildEnvelope(a: { envelope_id: string; tenant_id: string; approver: Approver; plan: AdPlan; source_question_id?: string; surface?: EnvelopeSurface }): ApprovalEnvelope {
  return {
    v: 1,
    envelope_id: a.envelope_id,
    tenant_id: a.tenant_id,
    actor_user_id: a.approver.user_id,
    actor_role: a.approver.role,
    surface: a.surface ?? a.approver.surface,
    channel: a.plan.channel_slug,
    max_total_usd: a.plan.total_usd,
    max_daily_usd: a.plan.budget_type === "lifetime" ? null : a.plan.daily_usd,
    starts_on: a.plan.start,
    ends_on: a.plan.end,
    ...(a.source_question_id ? { source_question_id: a.source_question_id } : {}),
  };
}

type Rpc = typeof tenantRpc;

export async function setApprovalEnvelope(
  tenant_id: string,
  table: "channel_actions" | "decisions",
  row_id: string,
  env: ApprovalEnvelope,
  rpc: Rpc = tenantRpc,
): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await rpc(asTenantId(tenant_id), "set_approval_envelope", { p_table: table, p_row_id: row_id, p_envelope: env });
  if (error) throw new Error(`set_approval_envelope failed: ${error.message}`);
  const out = (data ?? {}) as { ok?: boolean; code?: string };
  return { ok: out.ok === true, ...(out.code ? { code: out.code } : {}) };
}

export async function readApprovalEnvelope(tenant_id: string, table: "channel_actions" | "decisions", row_id: string): Promise<ApprovalEnvelope | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from(table).select("approval_envelope").eq("id", row_id).eq("tenant_id", tenant_id).maybeSingle();
  if (error) throw new Error(`${table} envelope read failed: ${error.message}`);
  return parseEnvelope((data as { approval_envelope?: unknown } | null)?.approval_envelope);
}

export function parseEnvelope(v: unknown): ApprovalEnvelope | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const day = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (e.v !== 1 || typeof e.envelope_id !== "string" || typeof e.tenant_id !== "string" || typeof e.actor_user_id !== "string") return null;
  if (e.actor_role !== "owner" && e.actor_role !== "admin") return null;
  if (typeof e.channel !== "string" || typeof e.max_total_usd !== "number" || !(e.max_total_usd > 0)) return null;
  if (e.max_daily_usd !== null && (typeof e.max_daily_usd !== "number" || !(e.max_daily_usd > 0))) return null;
  if (!day(e.starts_on) || !day(e.ends_on) || (e.ends_on as string) <= (e.starts_on as string)) return null;
  return e as unknown as ApprovalEnvelope;
}

export async function claimApprovalEnvelope(
  tenant_id: string,
  envelope_id: string,
  action_id: string,
  opts: { takeoverFrom?: string } = {},
  rpc: Rpc = tenantRpc,
): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await rpc(asTenantId(tenant_id), "claim_approval_envelope", {
    p_envelope_id: envelope_id,
    p_action_id: action_id,
    ...(opts.takeoverFrom ? { p_takeover_from: opts.takeoverFrom } : {}),
  });
  if (error) throw new Error(`claim_approval_envelope failed: ${error.message}`);
  const out = (data ?? {}) as { ok?: boolean; code?: string };
  return { ok: out.ok === true, ...(out.code ? { code: out.code } : {}) };
}

export { ENVELOPE_CREATE_CLASSES } from "@/services/approvals/envelope-classes";

export type CreateShape = {
  channel: string;
  lifetime_usd: number | null;
  daily_usd: number | null;
  factor: number;
  start_s: number;
  end_s: number;
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function createOf(execClass: string, payload: unknown, nowMs: number = Date.now()): CreateShape | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (execClass === CHATGPT_CREATE) {
    if (p.currency !== undefined && p.currency !== "USD") return null;
    const c = ((p.bundle as Record<string, unknown> | undefined)?.campaign ?? null) as Record<string, unknown> | null;
    if (!c || !finite(c.start_time) || !finite(c.end_time)) return null;
    const life = finite(c.lifetime_budget_micros) ? c.lifetime_budget_micros / 1e6 : null;
    const daily = finite(c.daily_budget_micros) ? c.daily_budget_micros / 1e6 : null;
    if ((life == null) === (daily == null)) return null;
    return { channel: "chatgpt_ads", lifetime_usd: life, daily_usd: daily, factor: adConstraint("chatgpt_ads")!.hold_factor, start_s: c.start_time, end_s: c.end_time };
  }
  if (execClass === TIKTOK_CREATE_LAUNCH_CLASS) {
    if (!finite(p.daily_budget_usd) || typeof p.start_time !== "string" || typeof p.end_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.end_date)) return null;
    const start = Date.parse(p.start_time);
    if (!Number.isFinite(start)) return null;
    return { channel: "tiktok_ads", lifetime_usd: null, daily_usd: p.daily_budget_usd, factor: adConstraint("tiktok_ads")!.hold_factor, start_s: Math.floor(start / 1000), end_s: Date.parse(`${p.end_date}T00:00:00Z`) / 1000 };
  }
  if (execClass === "meta_ads.launch_campaign") {
    const c = p.campaign as Record<string, unknown> | undefined;
    const s = p.ad_set as Record<string, unknown> | undefined;
    if (p.currency !== "USD" || !c || !s || !finite(c.daily_budget_usd) || typeof s.end_time !== "string") return null;
    const end = Date.parse(s.end_time);
    if (!Number.isFinite(end)) return null;
    return { channel: "meta_ads", lifetime_usd: null, daily_usd: c.daily_budget_usd, factor: adConstraint("meta_ads")!.hold_factor, start_s: Math.floor(nowMs / 1000), end_s: Math.floor(end / 1000) };
  }
  return createOfMore(execClass, p, nowMs);
}

const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

function createOfMore(execClass: string, p: Record<string, unknown>, nowMs: number): CreateShape | null {
  const now = Math.floor(nowMs / 1000);
  if (execClass === "google_ads.create_campaign") {
    if (!finite(p.daily_budget_usd) || typeof p.end_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.end_date)) return null;
    if (!Array.isArray(p.location_ids) || p.location_ids.length === 0) return null;
    return { channel: "google_ads", lifetime_usd: null, daily_usd: p.daily_budget_usd, factor: adConstraint("google_ads")!.hold_factor, start_s: now, end_s: dayStart(p.end_date) };
  }
  if (execClass === "x_ads.create_campaign") {
    if (p.currency !== "USD" || p.launch !== "ACTIVE" || !finite(p.daily_budget) || typeof p.end_time !== "string") return null;
    const end = Date.parse(p.end_time);
    const start = typeof p.start_time === "string" ? Math.max(Date.parse(p.start_time), nowMs) : nowMs;
    if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
    const total = finite(p.total_budget) ? p.total_budget : null;
    return { channel: "x_ads", lifetime_usd: total, daily_usd: total != null ? null : p.daily_budget, factor: adConstraint("x_ads")!.hold_factor, start_s: Math.floor(start / 1000), end_s: Math.floor(end / 1000) };
  }
  if (execClass === "linkedin_ads.launch_campaign") {
    if (p.currency !== "USD" || !finite(p.total_budget_usd) || !finite(p.end_time)) return null;
    return { channel: "linkedin_ads", lifetime_usd: p.total_budget_usd, daily_usd: null, factor: 1, start_s: now, end_s: Math.floor(p.end_time / 1000) };
  }
  return null;
}

export function createMaxSpendUsd(c: CreateShape): number {
  if (c.lifetime_usd != null) return c.lifetime_usd;
  return c.factor * (c.daily_usd ?? Infinity) * dailyBudgetDays(c.start_s, c.end_s);
}

export function createMatchesAsk(ask: { channel_slug: string; total_usd: number }, create: CreateShape | null): boolean {
  return !!create && create.channel === ask.channel_slug && createMaxSpendUsd(create) <= ask.total_usd + 1e-9;
}

export function envelopeLatestEnd(env: ApprovalEnvelope, start_s: number): number {
  const span = dayStart(env.ends_on) - dayStart(env.starts_on);
  return Math.max(dayStart(env.ends_on), Math.min(start_s, dayStart(env.starts_on) + 90_000) + span);
}

export function retimeEnvelopeFlight(execClass: string, payload: unknown, env: ApprovalEnvelope, nowMs: number): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, any>;
  const now = Math.floor(nowMs / 1000);
  const span = dayStart(env.ends_on) - dayStart(env.starts_on);
  const later = (oldEnd: number, start: number, flight: number) => {
    const end = Math.min(start + flight, envelopeLatestEnd(env, start));
    return end > oldEnd ? end : null;
  };
  let next: Record<string, any> | null = null;
  if (execClass === CHATGPT_CREATE) {
    const c = p.bundle?.campaign;
    if (!c || !finite(c.start_time) || !finite(c.end_time) || !finite(c.lifetime_budget_micros)) return payload;
    const start = Math.max(c.start_time, now + 60);
    const end = later(c.end_time, start, c.end_time - c.start_time);
    if (end != null) next = { ...p, bundle: { ...p.bundle, campaign: { ...c, start_time: start, end_time: end } } };
  } else if (execClass === "x_ads.create_campaign") {
    if (!finite(p.total_budget)) return payload;
    const e = typeof p.end_time === "string" ? Date.parse(p.end_time) : NaN;
    const s = typeof p.start_time === "string" ? Math.max(Date.parse(p.start_time), nowMs) : nowMs;
    const end = Number.isFinite(e) && Number.isFinite(s) ? later(Math.floor(e / 1000), Math.floor(s / 1000), span) : null;
    if (end != null) next = { ...p, end_time: new Date(end * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  } else if (execClass === "linkedin_ads.launch_campaign") {
    const end = finite(p.end_time) ? later(Math.floor(p.end_time / 1000), now, span) : null;
    if (end != null) next = { ...p, end_time: end * 1000 };
  }
  if (!next || !createFitsEnvelope(env, createOf(execClass, next, nowMs))) return payload;
  return next;
}

export function createFitsEnvelope(env: ApprovalEnvelope, create: CreateShape | null): boolean {
  if (!create || create.channel !== env.channel) return false;
  if (!(create.end_s > create.start_s)) return false;
  if (create.start_s < dayStart(env.starts_on) - 3600 || create.end_s > envelopeLatestEnd(env, create.start_s)) return false;
  const eps = 1e-9;
  if (create.lifetime_usd != null) {
    return create.daily_usd == null && create.lifetime_usd > 0 && create.lifetime_usd <= env.max_total_usd + eps;
  }
  if (create.daily_usd == null || !(create.daily_usd > 0) || env.max_daily_usd == null) return false;
  const flightDays = dailyBudgetDays(create.start_s, create.end_s);
  return create.daily_usd <= env.max_daily_usd + eps && create.factor * create.daily_usd * flightDays <= env.max_total_usd + eps;
}

export async function verifyEnvelope(
  tenant_id: string,
  env: ApprovalEnvelope,
  execClass: string,
  execPayload: unknown,
  loadRole: typeof loadTenantRoleFor = loadTenantRoleFor,
): Promise<{ ok: true } | { ok: false; reason: "wrong_tenant" | "not_owner_admin" | "role_unavailable" | "does_not_fit" }> {
  if (env.tenant_id !== tenant_id) return { ok: false, reason: "wrong_tenant" };
  let role: string | null;
  try {
    role = await loadRole(env.actor_user_id, tenant_id);
  } catch {
    return { ok: false, reason: "role_unavailable" };
  }
  if (role !== "owner" && role !== "admin") return { ok: false, reason: "not_owner_admin" };
  if (!createFitsEnvelope(env, createOf(execClass, execPayload))) return { ok: false, reason: "does_not_fit" };
  return { ok: true };
}

export type RunRow = { id?: string; trigger: string | null; enqueued_by: string | null; payload: unknown; agent_slug?: string; tenant_id?: string; enqueued_at?: string | null };

export async function resolveApprover(
  tenant_id: string,
  run: RunRow,
  deps: { loadRole?: typeof loadTenantRoleFor; message?: (run: RunRow) => Promise<FounderMessage | null> } = {},
): Promise<Approver | null> {
  const loadRole = deps.loadRole ?? loadTenantRoleFor;
  const msg = await (deps.message ?? founderMessageOf)({ ...run, tenant_id }).catch(() => null);
  const user = msg?.author_user_id ?? null;
  if (!msg || !user) return null;
  let role: string | null;
  try {
    role = await loadRole(user, tenant_id);
  } catch {
    return null;
  }
  return role === "owner" || role === "admin" ? { user_id: user, role, surface: msg.ref.kind } : null;
}

export async function founderOwnText(run: RunRow): Promise<string | null> {
  return (await founderMessageOf(run).catch(() => null))?.text ?? null;
}

export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

export async function readFounderAsk(
  tenant_id: string,
  run_id: string,
  now = new Date(),
): Promise<
  | null
  | { approver: Approver | null; envelope_id: string; shape: import("@/services/growth/direct-ad-ask").DirectAskShape; ask: import("@/services/growth/direct-ad-ask").DirectAdAsk }
> {
  const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
  if (!(await adsNoFrictionEnabled())) return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("agent_runs").select("id, trigger, enqueued_by, payload, agent_slug, enqueued_at").eq("id", run_id).eq("tenant_id", tenant_id).maybeSingle();
  if (error || !data) return null;
  const run = { ...(data as RunRow), id: run_id, tenant_id };
  const msg = await founderMessageOf(run, { now: now.getTime() }).catch(() => null);
  if (!msg) return null;
  const { parseDirectAdAsk, shapeDirectAsk } = await import("@/services/growth/direct-ad-ask");
  const ask = parseDirectAdAsk(msg.text);
  if (!ask) return null;
  const approver = await resolveApprover(tenant_id, run, { message: async () => msg });
  return { approver, ask, envelope_id: `ask:${msg.ref.run_id}`, shape: shapeDirectAsk(ask, utcToday(now)) };
}

export async function founderAskFor(ctx: { tenant_id: string; run_id?: string }, channel: string): Promise<{ plan: AdPlan | null; line: string; source: "ask" | "decision"; asked_daily_usd?: number | null; refuse?: boolean } | null> {
  if (!ctx.run_id) return null;
  const fa = await readFounderAsk(ctx.tenant_id, ctx.run_id).catch(() => null);
  if (!fa) {
    const env = await runSourceEnvelope(ctx.tenant_id, ctx.run_id).catch(() => null);
    return env && env.channel === channel ? { plan: planFromEnvelope(env), line: "", source: "decision" } : null;
  }
  if (fa.ask.channel_slug !== channel) return null;
  if (!fa.approver) return { plan: null, line: "An owner or admin needs to approve this.", source: "ask" };
  return fa.shape.kind === "plan"
    ? { plan: fa.shape.plan, line: fa.shape.line, source: "ask", asked_daily_usd: fa.ask.daily_usd }
    : { plan: null, line: fa.shape.line, source: "ask", refuse: true };
}

export type FounderOrderWords = {
  text: string;
  plan: AdPlan | null;
  asked_daily_usd: number | null;
  line: string | null;
  refuse: string | null;
};

export async function founderOrderWordsFor(ctx: { tenant_id: string; run_id?: string }, channel: string, now = new Date()): Promise<FounderOrderWords | null> {
  if (!ctx.run_id) return null;
  const { data, error } = await tenantClient(asTenantId(ctx.tenant_id)).from("agent_runs").select("id, trigger, enqueued_by, payload, agent_slug, enqueued_at").eq("id", ctx.run_id).eq("tenant_id", ctx.tenant_id).maybeSingle();
  if (error || !data) return null;
  const msg = await founderMessageOf({ ...(data as RunRow), id: ctx.run_id, tenant_id: ctx.tenant_id }, { now: now.getTime() }).catch(() => null);
  if (!msg) return null;
  const { parseDirectAdAsk, shapeDirectAsk } = await import("@/services/growth/direct-ad-ask");
  const ask = parseDirectAdAsk(msg.text, { adWordOptional: true });
  if (!ask || ask.channel_slug !== channel) return { text: msg.text, plan: null, asked_daily_usd: null, line: null, refuse: null };
  const shape = shapeDirectAsk(ask, utcToday(now));
  return shape.kind === "plan"
    ? { text: msg.text, plan: shape.plan, asked_daily_usd: ask.daily_usd, line: "This launch is a card waiting for your approval.", refuse: null }
    : { text: msg.text, plan: null, asked_daily_usd: null, line: null, refuse: shape.line };
}

export async function runSourceEnvelope(tenant_id: string, run_id: string): Promise<ApprovalEnvelope | null> {
  const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
  if (!(await adsNoFrictionEnabled())) return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("agent_runs").select("source_decision_id").eq("id", run_id).eq("tenant_id", tenant_id).maybeSingle();
  const id = (data as { source_decision_id?: string | null } | null)?.source_decision_id;
  if (error || !id) return null;
  return readApprovalEnvelope(tenant_id, "decisions", id);
}

export function planFromEnvelope(env: ApprovalEnvelope): AdPlan {
  const days = Math.max(1, Math.round((Date.parse(`${env.ends_on}T00:00:00Z`) - Date.parse(`${env.starts_on}T00:00:00Z`)) / 86_400_000));
  return {
    channel_slug: env.channel,
    budget_type: env.max_daily_usd == null ? "lifetime" : "daily",
    total_usd: env.max_total_usd,
    daily_usd: env.max_daily_usd,
    start: env.starts_on,
    end: env.ends_on,
    days,
    switched_from: null,
  };
}
