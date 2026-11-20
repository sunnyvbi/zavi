
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { planRefusal } from "./messages";
import { livePlanZone, planEmail, type PlanDeps, type PlanRoute } from "./plan";
import { wallLabel, wallToInstant } from "./time";

export type ApiDeps = {
  rpc: <T>(tenantId: string, name: string, args: Record<string, unknown>) => Promise<T>;
  zone: (tenantId: string) => Promise<string>;
  count: (tenantId: string, cls: string, body: unknown) => Promise<number | null>;
  plan: Partial<PlanDeps>;
};

async function rpc<T>(tenantId: string, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error) throw new Error(`${name} failed`);
  return data as T;
}

const LIVE: ApiDeps = {
  rpc,
  zone: livePlanZone,
  count: async (tenantId, cls, body) => (await import("@/services/email-cards/cards")).liveCardCount(tenantId, cls, body),
  plan: {},
};

export type Refused = { ok: false; code: string; message: string };
const refused = (code: string): Refused => ({ ok: false, code, message: planRefusal(code) });

type RawItem = {
  id: string;
  route: string;
  list_id: string;
  list_name: string;
  planned_at: string;
  timezone: string;
  angle: string;
  why: string | null;
  source: string;
  status: string;
  status_reason: string | null;
  content_version: number;
  schedule_gen: number;
  card: { rail: string; id: string } | null;
  vetoed: boolean;
  scheduled: { variant: number; count: number; by: string; at: string } | null;
  unattended: boolean;
  sent_at: string | null;
  hold: { since: string; unresolved: boolean } | null;
  draft_requested?: boolean;
};

type RawHold = { rail: "channel_actions" | "decisions"; card_id: string; list_key: string; since: string };

export async function readPlan(tenantId: string, userId: string, depsIn: Partial<ApiDeps> = {}) {
  const d = { ...LIVE, ...depsIn };
  const out = await d.rpc<{ ok: boolean; code?: string; role?: string | null; next_plan_at?: string | null; items?: RawItem[]; holds?: RawHold[]; released?: string[] }>(tenantId, "list_email_planned_sends", {
    p_user_id: userId,
  });
  if (!out.ok) return refused(out.code ?? "not_found");
  const read = await d.zone(tenantId).then((z) => ({ z, unread: false }), () => ({ z: "UTC", unread: true }));
  const tz = read.z;
  const autopilotOn = await import("@/services/growth/channel-autorun")
    .then(({ readAutopilotState }) => readAutopilotState(tenantId))
    .then((state) => state.enabled)
    .catch(() => null);
  const { plannedReason } = await import("@/services/email-cards/cards");
  const { draftBlockedFix } = await import("./messages");
  const weeklyBlock = await import("./live")
    .then(({ weeklyBlock }) => weeklyBlock(tenantId, { connectedToolIsEnough: true }))
    .catch(() => undefined);
  const weeklyEligible = weeklyBlock === undefined ? null : weeklyBlock === null;
  return {
    ok: true as const,
    role: out.role ?? null,
    timezone: tz,
    timezone_unread: read.unread,
    next_plan_at: out.next_plan_at ?? null,
    next_plan_label: out.next_plan_at ? wallLabel(out.next_plan_at, tz) : null,
    autopilot_on: autopilotOn,
    weekly_eligible: weeklyEligible,
    weekly_block: weeklyBlock ?? null,
    items: (out.items ?? []).map((i) => ({
      ...i,
      planned_label: wallLabel(i.planned_at, i.timezone),
      reason: plannedReason(i.status_reason, i.route),
      blocked_fix: i.status === "blocked" ? draftBlockedFix(i.status_reason) : null,
    })),
    holds: (out.holds ?? []).map((h) => ({ ...h, since_label: wallLabel(h.since, tz) })),
    released: out.released ?? [],
  };
}

export async function confirmNotSent(
  tenantId: string,
  userId: string,
  rail: "channel_actions" | "decisions",
  cardId: string,
  reason: string,
  depsIn: Partial<ApiDeps> = {},
) {
  const d = { ...LIVE, ...depsIn };
  return simple(
    await d.rpc<Simple>(tenantId, "confirm_email_not_sent", { p_actor_user_id: userId, p_rail: rail, p_card_id: cardId, p_reason: reason.trim() }),
  );
}

export type PlanBody = { route: PlanRoute; list_id: string; date: string; time: string; angle: string; request_id: string };

export async function planByFounder(tenantId: string, userId: string, b: PlanBody, depsIn: Partial<ApiDeps> = {}) {
  const d = { ...LIVE, ...depsIn };
  const out = await planEmail(
    tenantId,
    { route: b.route, list_id: b.list_id, date: b.date, time: b.time, angle: b.angle.trim(), why: null, source: "founder", actor: userId, request_key: `founder:${b.request_id}` },
    d.plan,
  );
  return out.ok ? out : { ...refused(out.code), ...(out.sentence ? { message: out.sentence } : {}) };
}

type Simple = { ok: boolean; code?: string; [k: string]: unknown };
const simple = (out: Simple) => (out.ok ? out : refused(out.code ?? "bad_request"));

export async function movePlanned(
  tenantId: string,
  userId: string,
  id: string,
  b: { date: string; time: string; schedule_gen: number; timezone?: string },
  depsIn: Partial<ApiDeps> = {},
) {
  const d = { ...LIVE, ...depsIn };
  const tz = b.timezone ?? (await d.zone(tenantId));
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return refused("bad_timezone");
  }
  const at = wallToInstant({ date: b.date, time: b.time }, tz);
  if (!at.ok) return refused(at.code);
  const out = await d.rpc<Simple>(tenantId, "move_email_planned_send", { p_actor: userId, p_id: id, p_planned_at: at.at.toISOString(), p_expected_gen: b.schedule_gen, p_tz: tz });
  return out.code === "too_soon" ? refused("move_too_soon") : simple(out);
}

export async function changePlannedAngle(tenantId: string, userId: string, id: string, b: { angle: string; content_version: number }, depsIn: Partial<ApiDeps> = {}) {
  const d = { ...LIVE, ...depsIn };
  return simple(await d.rpc<Simple>(tenantId, "change_email_planned_angle", { p_actor: userId, p_id: id, p_angle: b.angle.trim(), p_expected_version: b.content_version }));
}

export async function skipPlanned(tenantId: string, userId: string, id: string, depsIn: Partial<ApiDeps> = {}) {
  const d = { ...LIVE, ...depsIn };
  return simple(await d.rpc<Simple>(tenantId, "skip_email_planned_send", { p_actor: userId, p_id: id }));
}

export async function draftPlannedNow(tenantId: string, userId: string, id: string, depsIn: Partial<ApiDeps> = {}) {
  const d = { ...LIVE, ...depsIn };
  return simple(await d.rpc<Simple>(tenantId, "draft_email_planned_now", { p_actor: userId, p_id: id }));
}

export async function withdrawPlanned(tenantId: string, userId: string, id: string, depsIn: Partial<ApiDeps> = {}) {
  const d = { ...LIVE, ...depsIn };
  return simple(await d.rpc<Simple>(tenantId, "withdraw_email_planned_send", { p_actor: userId, p_id: id }));
}

export async function schedulePlanned(
  tenantId: string,
  userId: string,
  id: string,
  b: { variant: number; schedule_gen: number; content_version: number; request_id: string },
  depsIn: Partial<ApiDeps> = {},
) {
  const d = { ...LIVE, ...depsIn };
  const state = await d.rpc<{ ok: boolean; code?: string; card?: { class: string; body: unknown } | null }>(tenantId, "email_plan_deadline_state", { p_id: id });
  if (!state.ok) return refused(state.code ?? "not_found");
  if (!state.card) return refused("not_ready");
  let count: number | null;
  try {
    count = await d.count(tenantId, state.card.class, state.card.body);
  } catch (e) {
    if ((e as { code?: unknown })?.code === "tool_key_rejected") return refused("tool_key_rejected");
    throw e;
  }
  if (count === null || count < 1) return refused("count_required");
  return simple(
    await d.rpc<Simple>(tenantId, "schedule_email_planned_send", {
      p_actor: userId,
      p_id: id,
      p_variant: b.variant,
      p_count: count,
      p_expected_gen: b.schedule_gen,
      p_expected_version: b.content_version,
      p_request_key: `schedule:${b.request_id}`,
    }),
  );
}
