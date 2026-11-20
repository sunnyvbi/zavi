
import type { ActionType } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { cgoAdBudget } from "./cgo-ads";
import { freedDailyUsd, makeRoomTo, roomOfDaily } from "./make-room-math";

export type CgoAdChannel = "meta_ads" | "google_ads" | "chatgpt_ads" | "reddit_ads";

export type CgoAdOrderInput = {
  tenant_id: string;
  channel_slug: CgoAdChannel;
  exec_class: string;
  body: Record<string, unknown>;
  reason: string;
  idempotency_key: string;
  now?: Date;
  dwell_key?: string;
  planner?: PlannerNumbers;
};

export type PlannerNumbers = {
  kind: "raise" | "cut" | "copy" | "retarget_raise" | "retarget_create" | "switch_on" | "stop" | "creative" | "make_room_cut";
  required_usd: number;
  capacity_usd: number;
  gap_usd: number;
  room_usd?: number;
  surplus_usd?: number;
  from_usd?: number;
  step?: number;
  cap_usd?: number;
  share_usd?: number;
  floor_usd?: number;
  cpr_usd?: number | null;
  median_cpr_usd?: number | null;
  hold_daily_usd?: number;
  base_usd?: number;
  need_daily_usd?: number;
  short_usd?: number;
  days_left?: number;
  margin?: number;
  test_id?: string;
  test_revision?: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function plannedAmount(p: PlannerNumbers): number | null {
  const from = p.from_usd ?? NaN;
  switch (p.kind) {
    case "raise":
      return r2(from + r2(Math.min(from * (p.step ?? NaN), p.room_usd ?? NaN)));
    case "cut":
      return Math.ceil(Math.round(from * (1 - (p.step ?? NaN)) * 1e6) / 1e4) / 100;
    case "copy":
      return r2(Math.min(p.cap_usd ?? NaN, Math.max(p.floor_usd ?? NaN, p.share_usd ?? NaN)));
    case "retarget_raise":
      return r2(Math.min(p.cap_usd ?? NaN, from * (1 + (p.step ?? NaN))));
    case "retarget_create":
      return p.cap_usd ?? null;
    case "make_room_cut":
      return makeRoomTo({
        from_usd: from,
        hold_daily_usd: p.hold_daily_usd ?? NaN,
        base_usd: p.base_usd ?? NaN,
        need_daily_usd: p.need_daily_usd ?? NaN,
        step: p.step ?? NaN,
        floor_usd: p.floor_usd ?? NaN,
      });
    default:
      return null;
  }
}

const BUDGET_BEARING = /\.(update_ad_set_budget|update_campaign_budget|duplicate_ad_set|duplicate_campaign|create_ad_set)$/;
export const PLANNER_TOLERANCE_USD = 0.01;

export function plannerProblem(exec_class: string, body: Record<string, unknown>, planner: PlannerNumbers | undefined): string | null {
  const amount = body.daily_budget_usd;
  if (!BUDGET_BEARING.test(exec_class) || typeof amount !== "number") return null;
  if (!planner) return "no_planner_numbers";
  const want = plannedAmount(planner);
  if (want === null || !Number.isFinite(want)) return `planner_mismatch: ${planner.kind} gives no amount`;
  if (Math.abs(amount - want) > PLANNER_TOLERANCE_USD) return `planner_mismatch: body ${amount}, planned ${want}`;
  const current = body.expected_current_daily_budget_usd;
  if (typeof current === "number" && planner.from_usd !== undefined && Math.abs(current - planner.from_usd) > PLANNER_TOLERANCE_USD) {
    return `planner_mismatch: current ${current}, planned from ${planner.from_usd}`;
  }
  return makeRoomProblem(body, planner);
}

function makeRoomProblem(body: Record<string, unknown>, p: PlannerNumbers): string | null {
  const marked = body.make_room_test_id !== undefined || body.make_room_test_revision !== undefined || body.make_room_frees_usd !== undefined;
  if (p.kind !== "make_room_cut") return marked ? `planner_mismatch: a make-room body under a ${p.kind} planner` : null;
  if (typeof p.test_id !== "string" || body.make_room_test_id !== p.test_id) return "planner_mismatch: make-room test id";
  if (!Number.isInteger(p.test_revision) || body.make_room_test_revision !== p.test_revision) return "planner_mismatch: make-room test revision";
  const from = p.from_usd ?? NaN;
  const to = plannedAmount(p) ?? NaN;
  const days = p.days_left ?? NaN;
  const margin = p.margin ?? NaN;
  const frees = roomOfDaily(freedDailyUsd({ held_daily_usd: p.hold_daily_usd ?? NaN, base_usd: p.base_usd ?? NaN }, from, to), days, margin);
  if (!(frees > 0)) return "planner_mismatch: make-room cut frees nothing";
  if (typeof body.make_room_frees_usd !== "number" || Math.abs(body.make_room_frees_usd - frees) > PLANNER_TOLERANCE_USD) {
    return `planner_mismatch: make-room frees ${String(body.make_room_frees_usd)}, planned ${frees}`;
  }
  if (!(typeof p.short_usd === "number" && frees <= p.short_usd + Math.max(1, days) * Math.max(1, margin) * 0.01 + PLANNER_TOLERANCE_USD)) {
    return `planner_mismatch: make-room frees ${frees}, more than the ${p.short_usd} the test was short`;
  }
  return null;
}

export function plannerEvidence(p: PlannerNumbers): string[] {
  const usd = (n: number) => `$${r2(n).toFixed(2)}`;
  const lines = [
    p.surplus_usd !== undefined
      ? `Needed live ${usd(p.required_usd)}/day; live ${usd(p.capacity_usd)}/day; ${usd(p.surplus_usd)}/day above what is needed (only that may be cut).`
      : `Needed live ${usd(p.required_usd)}/day; live ${usd(p.capacity_usd)}/day; gap ${usd(p.gap_usd)}/day${p.room_usd !== undefined ? ` (${usd(p.room_usd)} still open)` : ""}.`,
  ];
  const want = plannedAmount(p);
  const stepShown = p.kind === "make_room_cut" && want !== null && p.from_usd ? (p.from_usd - want) / p.from_usd : p.step;
  if (want !== null && p.from_usd !== undefined) lines.push(`${usd(p.from_usd)} to ${usd(want)} a day${stepShown !== undefined ? ` (${Math.round(stepShown * 100)}% step)` : ""}.`);
  else if (want !== null) lines.push(`${usd(want)} a day.`);
  if (p.kind === "make_room_cut" && typeof p.short_usd === "number" && want !== null && p.from_usd !== undefined) {
    const frees = roomOfDaily(freedDailyUsd({ held_daily_usd: p.hold_daily_usd ?? 0, base_usd: p.base_usd ?? 0 }, p.from_usd, want), p.days_left ?? 1, p.margin ?? 1);
    lines.push(`A first channel test is waiting for ${usd(p.short_usd)} of this month's ad budget; this cut frees about ${usd(frees)} (at most a ${Math.round((p.step ?? 0) * 100)}% step).`);
  }
  if (typeof p.cpr_usd === "number") lines.push(`Cost per result ${usd(p.cpr_usd)}${typeof p.median_cpr_usd === "number" ? ` against a median of ${usd(p.median_cpr_usd)}` : ""}.`);
  return lines;
}

export type CgoAdOrderResult = { ok: true; action_id: string; replayed?: boolean } | { ok: false; why: string };

export const CGO_ORDER_KEY = "cgo_order_key";
export const CGO_ORDER_ORIGIN = "cgo_order_origin";
export const CGO_ORDER_DWELL = "cgo_dwell_key";
export const CGO_ORDER_PLANNER = "cgo_planner";
export const CGO_ORDER_RUN_STAGE = "cgo_ad_orders";

export function utcHourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function orderActionType(exec_class: string, body: Record<string, unknown>): ActionType {
  if (/\.set_status/.test(exec_class)) {
    return body.status === "PAUSED" ? "pause_ad" : "update_ad";
  }
  if (exec_class === "meta_ads.create_custom_audience") return "setup";
  if (/\.(create_|prepare_|replace_creative|duplicate_|add_keywords)/.test(exec_class)) return "create_ad";
  return "update_ad";
}

const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505";

export async function ensureCgoOrderRun(tenant_id: string, channel: CgoAdChannel | "tiktok_ads", now: Date = new Date()): Promise<string> {
  const db = tenantClient(asTenantId(tenant_id));
  const key = `${tenant_id}:${CGO_ORDER_RUN_STAGE}:${channel}:${utcHourKey(now)}`;
  const find = async (): Promise<string | null> => {
    const { data, error } = await db.from("agent_runs").select("id").eq("cron_dedupe_key", key).limit(1);
    if (error) throw new Error(`cgo-ad-orders: anchor run read failed: ${error.message}`);
    const id = (data as Array<{ id?: string }> | null)?.[0]?.id;
    return typeof id === "string" && id ? id : null;
  };
  const found = await find();
  if (found) return found;
  const at = now.toISOString();
  const { data, error } = await db
    .from("agent_runs")
    .insert({
      agent_slug: channel,
      channel_slug: channel,
      agent_definition_hash: CGO_ORDER_RUN_STAGE,
      trigger: "cron",
      status: "success",
      enqueued_at: at,
      started_at: at,
      finished_at: at,
      parse_ok: true,
      cost_tokens: 0,
      cost_usd: 0,
      tool_calls: [],
      cron_dedupe_key: key,
      output_text: "Autopilot ad budget: changes ordered by Zavi's spend controller (no model run).",
      payload: { stage: CGO_ORDER_RUN_STAGE },
    })
    .select("id");
  if (error) {
    if (isUniqueViolation(error)) {
      const again = await find();
      if (again) return again;
    }
    throw new Error(`cgo-ad-orders: anchor run insert failed: ${error.message}`);
  }
  const id = (data as Array<{ id?: string }> | null)?.[0]?.id;
  if (typeof id !== "string" || !id) throw new Error("cgo-ad-orders: anchor run insert returned no id");
  return id;
}

type OrderRow = { id: string; status: string; exec_status: string | null; approved_by_source: string | null };

async function readOrderByKey(tenant_id: string, key: string): Promise<OrderRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, status, exec_status, approved_by_source")
    .eq(`body->>${CGO_ORDER_KEY}`, key)
    .order("proposed_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`cgo-ad-orders: order read failed: ${error.message}`);
  return ((data ?? []) as OrderRow[])[0] ?? null;
}

async function readOrderById(tenant_id: string, id: string): Promise<OrderRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, status, exec_status, approved_by_source")
    .eq("id", id)
    .limit(1);
  if (error) throw new Error(`cgo-ad-orders: order read failed: ${error.message}`);
  return ((data ?? []) as OrderRow[])[0] ?? null;
}

const queuedByCgo = (r: OrderRow | null) => !!r && r.exec_status === "queued" && r.approved_by_source === "cgo";
const ranByCgo = (r: OrderRow | null) => !!r && r.approved_by_source === "cgo" && r.exec_status !== null && r.exec_status !== "failed";

export async function orderCard(input: CgoAdOrderInput): Promise<{ title: string; card: Record<string, unknown> }> {
  let built: { title: string; card: Record<string, unknown> } | null = null;
  try {
    if (input.channel_slug === "meta_ads") {
      const { buildMetaExecCardBody } = await import("@/services/tools/meta-ads/write/_exec-action");
      built = buildMetaExecCardBody(input.exec_class, input.body);
    } else if (input.channel_slug === "google_ads") {
      const { buildExecCardBody } = await import("@/services/tools/google-ads/write/_exec-action");
      built = buildExecCardBody(input.exec_class, input.body);
    }
  } catch {
    built = null;
  }
  const reason = input.reason.trim().slice(0, 500);
  const generic = !built || built.title.startsWith("Apply ");
  const name = typeof input.body.name === "string" ? input.body.name.trim() : "";
  const verb = (input.exec_class.split(".")[1] ?? input.exec_class).replace(/_/g, " ");
  const title = (generic ? `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)}${name ? `: ${name}` : ""}` : built!.title).slice(0, 300);
  const base = built?.card ?? {};
  const baseStep = (base.step as Record<string, unknown> | undefined) ?? {};
  const sentence = typeof base.change_sentence === "string" ? base.change_sentence : "";
  const prose = [reason, sentence].filter((s) => !!s).join("\n\n") || title;
  return {
    title,
    card: {
      ...base,
      step: { evidence: [], ...baseStep, ...(input.planner ? { evidence: plannerEvidence(input.planner) } : {}), title, body: prose, blocking: false, effort: "minutes" },
      exact_change: (base.exact_change as unknown) ?? null,
      link: null,
      [CGO_ORDER_KEY]: input.idempotency_key,
      [CGO_ORDER_ORIGIN]: "ad_spend_controller",
      ...(input.dwell_key ? { [CGO_ORDER_DWELL]: input.dwell_key } : {}),
      ...(input.planner ? { [CGO_ORDER_PLANNER]: input.planner } : {}),
    },
  };
}

export async function submitCgoAdAction(order: CgoAdOrderInput): Promise<CgoAdOrderResult> {
  const now = order.now ?? new Date();
  const { tenant_id, channel_slug, exec_class } = order;
  const key = order.idempotency_key.trim();
  if (!key) return { ok: false, why: "no_idempotency_key" };
  if (!exec_class.startsWith(`${channel_slug}.`)) return { ok: false, why: "class_not_of_channel" };
  let input = order;
  if (exec_class === "meta_ads.create_ad_set") {
    try {
      const { resolveCreateAdSetBid } = await import("@/services/tools/meta-ads/write/_ad-set-bid");
      type Draft = Parameters<typeof resolveCreateAdSetBid>[1];
      input = { ...order, body: (await resolveCreateAdSetBid(tenant_id, order.body as unknown as Draft)) as unknown as Record<string, unknown> };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "read_failed";
      return { ok: false, why: `bid:${code}:${String((e as Error).message ?? e).slice(0, 160)}` };
    }
  }
  const planned = plannerProblem(exec_class, input.body, input.planner);
  if (planned) return { ok: false, why: planned };
  const { orderBodyProblem } = await import("./cgo-order-validate");
  const problem = await orderBodyProblem(exec_class, input.body);
  if (problem) return { ok: false, why: `invalid_body:${problem.slice(0, 200)}` };
  try {
    if (!(await cgoAdBudget(tenant_id, now))) return { ok: false, why: "not_running_ads" };

    const prior = await readOrderByKey(tenant_id, key);
    if (prior) {
      if (queuedByCgo(prior)) {
        const { cgoApproveChannelAction } = await import("./cgo-ads");
        await cgoApproveChannelAction(tenant_id, prior.id);
      }
      return queuedByCgo(prior) || ranByCgo(prior)
        ? { ok: true, action_id: prior.id, replayed: true }
        : { ok: false, why: `prior_order_${prior.exec_status ?? prior.status}` };
    }

    const run_id = await ensureCgoOrderRun(tenant_id, channel_slug, now);

    const { authorizeUnattended } = await import("./unattended-policy");
    const { title, card } = await orderCard(input);
    const v = await authorizeUnattended(
      tenant_id,
      { kind: "ad", exec_class, payload: input.body, source: { table: "channel_actions", id: key, run_id }, title },
      { now, where: "cgo_order" },
    );
    if (v.verdict !== "allow") {
      const { tellQuietHold } = await import("./ad-holds");
      if (v.verdict === "ask_founder" && !(await tellQuietHold(tenant_id, exec_class, input.body, v.reasons, now))) {
        const { askFounderAboutHeld } = await import("./unattended-policy");
        await askFounderAboutHeld(
          tenant_id,
          { kind: "ad", exec_class, payload: input.body, source: { table: "channel_actions", id: key, run_id }, title },
          v,
          false,
        );
      }
      return { ok: false, why: `held:${v.reasons.slice(0, 4).join(",")}` };
    }

    const { recordChannelExecAction } = await import("@/services/channels/exec-actions");
    let recorded: { id: string; kept?: boolean };
    try {
      recorded = await recordChannelExecAction(
        {
          tenantId: tenant_id,
          runId: run_id,
          channelSlug: channel_slug,
          execClass: exec_class,
          execPayload: input.body,
          actionType: orderActionType(exec_class, input.body),
          title,
          body: card,
        },
        undefined,
        { enabled: () => false },
      );
    } catch (e) {
      const row = await readOrderByKey(tenant_id, key).catch(() => null);
      if (row && queuedByCgo(row)) {
        try {
          const { cgoApproveChannelAction } = await import("./cgo-ads");
          await cgoApproveChannelAction(tenant_id, row.id);
          return { ok: true, action_id: row.id };
        } catch {
          return { ok: false, why: "approval_event_not_sent" };
        }
      }
      return { ok: false, why: `record_failed:${(e as Error).message.slice(0, 120)}` };
    }
    if (recorded.kept) return { ok: false, why: "founder_card_kept" };
    const row = await readOrderById(tenant_id, recorded.id);
    if (!queuedByCgo(row) && !ranByCgo(row)) return { ok: false, why: "not_approved" };
    return { ok: true, action_id: recorded.id };
  } catch (e) {
    console.warn(`[cgo-ad-orders] ${exec_class} for ${tenant_id} not ordered: ${(e as Error).message}`);
    return { ok: false, why: `error:${(e as Error).message.slice(0, 120)}` };
  }
}
