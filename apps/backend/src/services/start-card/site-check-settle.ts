
import { addRunSideCost, type AddSideCostResult } from "@/services/agents/run-side-costs";
import { settleLateToolCharge, type SettleLateResult } from "@/services/billing/tool-charges";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import { logEvent } from "@/services/logging/logEvent";
import { getCardById, transitionDelivery, updateCard, type StartCardRow } from "./store";
import { SITE_CHECK_COST_SOURCE, siteCheckCostKey, tenantChargeUsd } from "./site-check-funding";
import { composeFounderResult } from "./site-check-result";

export const ABANDONED_WAIT_MS = 5 * 60 * 1000;

export type SettleDeps = {
  getCard: typeof getCardById;
  transition: typeof transitionDelivery;
  addSideCost: typeof addRunSideCost;
  settleLate: typeof settleLateToolCharge;
  runBelongsToTenant: (tenantId: string, runId: string) => Promise<boolean>;
  sideCostBilled: (tenantId: string, runId: string, toolCallId: string) => Promise<boolean>;
  post: (row: StartCardRow, body: string) => Promise<void>;
  markSettled: (cardId: string) => Promise<void>;
  now: () => number;
};

async function runBelongsToTenant(tenantId: string, runId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .select("id")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`site-check settle: run read failed: ${error.message}`);
  return !!data;
}

async function sideCostBilled(tenantId: string, runId: string, toolCallId: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_run_side_costs")
    .select("id")
    .eq("run_id", runId)
    .in("cost_key", [siteCheckCostKey(toolCallId), `late_tool_charge:${toolCallId}`])
    .limit(1);
  if (error) throw new Error(`site-check settle: side cost read failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function markSettled(cardId: string): Promise<void> {
  await updateCard(cardId, { funding_settled_at: new Date().toISOString() });
}

export const defaultSettleDeps: SettleDeps = {
  getCard: getCardById,
  transition: transitionDelivery,
  addSideCost: addRunSideCost,
  settleLate: settleLateToolCharge,
  runBelongsToTenant,
  sideCostBilled,
  post: postSiteCheckResult,
  markSettled,
  now: () => Date.now(),
};

type TenantCard = StartCardRow & { funding_tenant_id: string; requested_by_run_id: string; tool_call_id: string };

export type LoadResult =
  | { state: "skip"; reason: "not_found" | "not_tenant" | "running" | "already_settled" }
  | { state: "ok"; card: TenantCard };

export async function loadTenantCard(cardId: string, deps: SettleDeps = defaultSettleDeps): Promise<LoadResult> {
  const row = await deps.getCard(cardId);
  if (!row) return { state: "skip", reason: "not_found" };
  if (row.funding_kind !== "tenant_credits" || !row.funding_tenant_id || !row.requested_by_run_id || !row.tool_call_id) {
    return { state: "skip", reason: "not_tenant" };
  }
  if (row.status === "running") return { state: "skip", reason: "running" };
  if (row.funding_settled_at) return { state: "skip", reason: "already_settled" };
  if (!(await deps.runBelongsToTenant(row.funding_tenant_id, row.requested_by_run_id))) {
    throw new Error(`site-check settle: card ${cardId} run does not belong to its tenant (C8)`);
  }
  return { state: "ok", card: row as TenantCard };
}

export type AbandonResult = "not_waiting" | "too_soon" | "lost_race" | AddSideCostResult;

export async function resolveAbandonedWait(card: TenantCard, deps: SettleDeps = defaultSettleDeps): Promise<AbandonResult> {
  if (card.delivery_state === "returned") return billReturnedIfMissing(card, deps);
  if (card.delivery_state !== "waiting") return "not_waiting";
  if (deps.now() - new Date(card.created_at).getTime() < ABANDONED_WAIT_MS) return "too_soon";
  if (!(await deps.transition(card.id, "waiting", "returned"))) return "lost_race";
  return billCard(card, deps, "abandoned");
}

async function billReturnedIfMissing(card: TenantCard, deps: SettleDeps): Promise<AbandonResult> {
  if (tenantChargeUsd(card) === 0) return "zero";
  if (await deps.sideCostBilled(card.funding_tenant_id, card.requested_by_run_id, card.tool_call_id)) return "already";
  return billCard(card, deps, "returned_unbilled");
}

async function billCard(card: TenantCard, deps: SettleDeps, why: "abandoned" | "returned_unbilled"): Promise<AddSideCostResult> {
  const r = await deps.addSideCost({
    tenantId: card.funding_tenant_id,
    runId: card.requested_by_run_id,
    usd: tenantChargeUsd(card),
    source: SITE_CHECK_COST_SOURCE,
    key: siteCheckCostKey(card.tool_call_id),
  });
  void logEvent({
    level: r === "run_finished" || r === "no_run" ? "error" : "warn",
    source: "start_card",
    code: `site_check_${why}_${r}`,
    tenant_id: card.funding_tenant_id,
  });
  return r;
}

export async function refundLateCharge(
  card: TenantCard,
  deps: SettleDeps = defaultSettleDeps,
): Promise<SettleLateResult["status"] | "no_charge"> {
  const r = await deps.settleLate({
    tenantId: card.funding_tenant_id,
    runId: card.requested_by_run_id,
    toolCallId: card.tool_call_id,
    actualUsd: tenantChargeUsd(card),
  });
  return r.status === "not_found" ? "no_charge" : r.status;
}

export type DeliverResult = "posted" | "not_pending";

export async function deliverPendingResult(card: TenantCard, deps: SettleDeps = defaultSettleDeps): Promise<DeliverResult> {
  if (card.delivery_state !== "pending") return "not_pending";
  if (!(await deps.transition(card.id, "pending", "delivered"))) return "not_pending";
  try {
    await deps.post(card, composeFounderResult(card));
  } catch (e) {
    await deps.transition(card.id, "delivered", "pending").catch(() => false);
    await logEvent({
      level: "error",
      source: "start_card",
      code: "site_check_deliver_failed",
      message: `${card.delivery_target?.kind ?? "none"}: ${String((e as Error)?.message ?? e).slice(0, 400)}`,
      tenant_id: card.funding_tenant_id,
      run_id: card.requested_by_run_id,
    });
    throw e;
  }
  return "posted";
}

export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function postSiteCheckResult(row: StartCardRow, body: string): Promise<void> {
  const tenantId = row.funding_tenant_id;
  const target = row.delivery_target;
  if (!tenantId || !target || target.kind === "none") {
    void logEvent({ level: "warn", source: "start_card", code: "site_check_no_delivery_target", tenant_id: tenantId ?? undefined });
    return;
  }
  if (target.kind === "slack") {
    const seq = await enqueueSlackOutbox({
      tenant_id: tenantId,
      channel_id: target.channel_id,
      thread_ts: target.thread_ts,
      team_id: target.team_id,
      kind: "site_check_result",
      body: escapeSlackText(body),
      run_id: row.requested_by_run_id ?? null,
      idempotency_key: `site_check_result:${row.id}`,
      depends_on_answer: true,
    });
    if (seq == null) throw new Error("site-check result: slack outbox enqueue failed");
    return;
  }
  const db = tenantClient(asTenantId(tenantId));
  const { data: thread, error: thErr } = await db.from("agent_threads").select("id").eq("id", target.thread_id).maybeSingle();
  if (thErr) throw new Error(`site-check result: thread read failed: ${thErr.message}`);
  if (!thread) {
    void logEvent({ level: "warn", source: "start_card", code: "site_check_thread_missing", tenant_id: tenantId });
    return;
  }
  const { data: already, error: dupErr } = await db
    .from("agent_thread_messages")
    .select("id")
    .eq("thread_id", target.thread_id)
    .eq("meta->>site_check_card", row.public_id)
    .limit(1);
  if (dupErr) throw new Error(`site-check result: duplicate check failed: ${dupErr.message}`);
  if (Array.isArray(already) && already.length > 0) return;
  const { error: insErr } = await db.from("agent_thread_messages").insert({
    thread_id: target.thread_id,
    sender_role: "assistant",
    body,
    agent_run_id: null,
    meta: { site_check_card: row.public_id, site_check_run_id: row.requested_by_run_id },
  });
  if (insErr) throw new Error(`site-check result: chat post failed: ${insErr.message}`);
  await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", target.thread_id);
}

export { markSettled };

export type FlowStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  sleep: (id: string, duration: string) => Promise<unknown>;
};

export const TOOL_WAIT_CHECKS = 10;
export const LATE_REFUND_TRIES = 36;

export type FlowResult =
  | { status: "skip"; reason: string }
  | { status: "refund_pending"; delivered: DeliverResult }
  | { status: "settled"; delivered: DeliverResult; refund: string };

export async function settleTenantCardFlow(
  cardId: string,
  step: FlowStep,
  deps: SettleDeps = defaultSettleDeps,
): Promise<FlowResult> {
  for (let i = 0; i < TOOL_WAIT_CHECKS; i++) {
    const r = await step.run(`abandoned-wait-${i}`, async () => {
      const loaded = await loadTenantCard(cardId, deps);
      if (loaded.state !== "ok") return { skip: loaded.reason as string };
      return { result: (await resolveAbandonedWait(loaded.card, deps)) as string };
    });
    if ("skip" in r) return { status: "skip", reason: r.skip ?? "unknown" };
    if (r.result !== "too_soon") break;
    await step.sleep(`tool-wait-${i}`, "1m");
  }

  const delivered = await step.run("deliver", async () => {
    const loaded = await loadTenantCard(cardId, deps);
    return loaded.state === "ok" ? deliverPendingResult(loaded.card, deps) : ("not_pending" as const);
  });

  let refund = "pending";
  for (let i = 0; i < LATE_REFUND_TRIES; i++) {
    refund = await step.run(`late-refund-${i}`, async () => {
      const loaded = await loadTenantCard(cardId, deps);
      return loaded.state === "ok" ? ((await refundLateCharge(loaded.card, deps)) as string) : "already";
    });
    if (refund !== "pending") break;
    await step.sleep(`late-refund-wait-${i}`, "5m");
  }
  if (refund === "pending") {
    void logEvent({ level: "error", source: "start_card", code: "site_check_refund_still_pending" });
    return { status: "refund_pending", delivered };
  }

  await step.run("mark-settled", () => deps.markSettled(cardId));
  return { status: "settled", delivered, refund };
}
