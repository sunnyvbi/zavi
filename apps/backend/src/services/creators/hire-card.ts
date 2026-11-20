import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { latestCreatorCaps } from "@/services/decisions/creator-hire-budget";
import { logEvent } from "@/services/logging/logEvent";
import { applyCreatorOrderTransition, realCreatorOrderDeps, type CreatorOrderDeps } from "./order-transitions";
import { loadOrderForCheckout } from "./booking-db";
import { realSettleUnpaidCheckoutDeps, settleUnpaidCheckout, type SettleUnpaidCheckoutDeps } from "./checkout-expiry";
import { CREATOR_HIRE_CLASS } from "./hire-approve";

export type HireCardRefusal = "no_caps" | "over_hire_cap";

export const HIRE_CARD_CHANNELS: ReadonlySet<string> = new Set(["ugc"]);

export type FileCreatorHireCardArgs = {
  tenant_id: string;
  run_id: string;
  order_id: string;
  creator_name: string;
  package_title: string;
  business_total_cents: number;
  price_cents: number;
  fee_cents: number;
  source?: "booking" | "offer";
};

export type FileCreatorHireCardResult =
  | { ok: true; card_id: string }
  | { ok: false; refusal: HireCardRefusal; message: string };

export type HireCardDeps = {
  caps: typeof latestCreatorCaps;
  runChannel: (tenant_id: string, run_id: string) => Promise<string | null>;
  record: (input: Parameters<typeof recordChannelExecAction>[0]) => Promise<{ id: string }>;
};

async function readRunChannel(tenant_id: string, run_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("channel_slug")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`agent_runs read failed: ${error.message}`);
  const slug = (data as { channel_slug?: unknown } | null)?.channel_slug;
  return typeof slug === "string" && slug ? slug : null;
}

const DEFAULT_CARD_DEPS: HireCardDeps = {
  caps: latestCreatorCaps,
  runChannel: readRunChannel,
  record: (input) => recordChannelExecAction(input),
};

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function creatorHireCost(
  a: Pick<FileCreatorHireCardArgs, "business_total_cents" | "price_cents" | "fee_cents" | "source">,
): string {
  const when = a.source === "offer" ? "charged to your saved card when you approve" : "held on your saved card when you approve";
  return `${usd(a.business_total_cents)} (${usd(a.price_cents)} + ${usd(a.fee_cents)} Zavi fee), ${when}`;
}

export function buildCreatorHireCard(a: FileCreatorHireCardArgs): { title: string; body: Record<string, unknown> } {
  const title = `Hire ${a.creator_name}: ${a.package_title}`.slice(0, 300);
  const cost = creatorHireCost(a);
  return {
    title,
    body: {
      step: {
        title,
        body:
          a.source === "offer"
            ? `${a.creator_name} accepted the offer for "${a.package_title}". Approve to hire them: it costs ${cost}, and the job starts as soon as the payment goes through.`
            : `Approve to hire ${a.creator_name} for "${a.package_title}". It costs ${cost}. The creator then has time to accept; if they pass, the hold is released and nothing is charged.`,
        blocking: false,
        effort: "minutes",
        evidence: [],
      },
      exact_change: {
        rows: [
          { item: "Creator", before: "Not hired", after: `${a.creator_name}, ${a.package_title}` },
          { item: "Cost", before: "Nothing yet", after: cost },
        ],
      },
      cost,
      cost_cents: a.business_total_cents,
      order_id: a.order_id,
      link: null,
    },
  };
}

export async function fileCreatorHireCard(
  args: FileCreatorHireCardArgs,
  deps: Partial<HireCardDeps> = {},
): Promise<FileCreatorHireCardResult> {
  const d = { ...DEFAULT_CARD_DEPS, ...deps };
  const caps = await d.caps(args.tenant_id);
  if (!caps) {
    return {
      ok: false,
      refusal: "no_caps",
      message: "There are no creator caps yet, so no hire can be proposed. Nothing was filed or charged.",
    };
  }
  if (!Number.isFinite(args.business_total_cents) || args.business_total_cents <= 0) {
    throw new ExpectedToolError("creator_hire_bad_amount", "This hire has no valid price, so no card was filed. Nothing was charged.");
  }
  if (args.business_total_cents / 100 > caps.per_hire_usd) {
    return {
      ok: false,
      refusal: "over_hire_cap",
      message: `This hire costs ${usd(args.business_total_cents)}, more than the per-hire cap of ${usd(Math.round(caps.per_hire_usd * 100))}. No card was filed and nothing was charged.`,
    };
  }
  const channel = await d.runChannel(args.tenant_id, args.run_id);
  if (!channel || !HIRE_CARD_CHANNELS.has(channel)) {
    throw new ExpectedToolError(
      "creator_hire_wrong_run",
      "Creator hire cards can only be filed from a UGC Videos channel run. Nothing was filed or charged.",
    );
  }
  const { title, body } = buildCreatorHireCard(args);
  const out = await d.record({
    tenantId: args.tenant_id,
    runId: args.run_id,
    channelSlug: channel,
    execClass: CREATOR_HIRE_CLASS,
    execPayload: { order_id: args.order_id, caps_id: caps.id },
    actionType: "other",
    title,
    body,
  });
  return { ok: true, card_id: out.id };
}

export type DeclineDeps = {
  transition: typeof applyCreatorOrderTransition;
  orderDeps: CreatorOrderDeps;
  retire: typeof retireCreatorHireCards;
  log: typeof logEvent;
  loadOrder: typeof loadOrderForCheckout;
  settleDeps?: SettleUnpaidCheckoutDeps;
};

const DEFAULT_DECLINE_DEPS: DeclineDeps = {
  transition: applyCreatorOrderTransition,
  orderDeps: realCreatorOrderDeps,
  loadOrder: (tenant_id, order_id) => loadOrderForCheckout(tenant_id, order_id),
  retire: (a) => retireCreatorHireCards(a),
  log: logEvent,
};

export async function declineCreatorHire(
  args: { tenant_id: string; order_id: string; reason: string },
  deps: Partial<DeclineDeps> = {},
): Promise<void> {
  const d = { ...DEFAULT_DECLINE_DEPS, ...deps };
  const pending = await d.loadOrder(args.tenant_id, args.order_id);
  if (pending && pending.status === "checkout_pending") {
    const settled = await settleUnpaidCheckout({ ...pending, status: "checkout_pending" }, d.settleDeps ?? realSettleUnpaidCheckoutDeps, { expireOpen: true });
    if (settled.action === "settled") {
      await d.retire({ tenant_id: args.tenant_id, order_id: args.order_id }).catch(() => 0);
      await d
        .log({
          level: "warn",
          source: "creator.hire",
          code: "creator_hire_decline_paid",
          message: `order ${args.order_id} was not cancelled: a payment already moved it (${settled.state}): ${args.reason}`.slice(0, 500),
          tenant_id: args.tenant_id,
          meta: { creator_order_id: args.order_id },
        })
        .catch(() => {});
      return;
    }
    if (settled.action !== "close") {
      throw new Error(`creator hire decline: order ${args.order_id} could not be closed yet (${settled.reason})`);
    }
  }
  const result = await d.transition(
    { tenant_id: args.tenant_id, order_id: args.order_id, trigger: "checkout_abandoned", actor: "system" },
    d.orderDeps,
  );
  if (!result.ok && result.code !== "illegal_transition" && result.code !== "order_not_found") {
    throw new Error(`creator hire decline: order ${args.order_id} did not close (${result.code})`);
  }
  const client = tenantClient(asTenantId(args.tenant_id));
  const { data: order, error: orderErr } = await client
    .from("creator_orders")
    .select("id, offer_id, status, closed_reason")
    .eq("id", args.order_id)
    .maybeSingle();
  if (orderErr) throw new Error(`creator_orders read failed: ${orderErr.message}`);
  const row = order as { offer_id?: unknown; status?: unknown; closed_reason?: unknown } | null;
  const closed = result.ok || (row?.status === "cancelled" && row?.closed_reason === "checkout_abandoned");
  if (!closed) {
    await d.retire({ tenant_id: args.tenant_id, order_id: args.order_id }).catch(() => 0);
    await d
      .log({
        level: "info",
        source: "creator.hire",
        code: "creator_hire_decline_skipped",
        message: `order ${args.order_id} was not cancelled: it is ${typeof row?.status === "string" ? row.status : "missing"}, so the hire card only closed: ${args.reason}`.slice(0, 500),
        tenant_id: args.tenant_id,
        meta: { creator_order_id: args.order_id },
      })
      .catch(() => {});
    return;
  }
  const offer_id = row?.offer_id;
  let withdrawn = 0;
  if (typeof offer_id === "string" && offer_id) {
    const now = new Date().toISOString();
    const { data, error } = await client
      .from("creator_offers")
      .update({ status: "withdrawn", updated_at: now })
      .eq("id", offer_id)
      .eq("status", "accepted")
      .not("agent_run_id", "is", null)
      .select("id");
    if (error) throw new Error(`creator_offers withdraw failed: ${error.message}`);
    withdrawn = Array.isArray(data) ? data.length : 0;
  }
  await d.retire({ tenant_id: args.tenant_id, order_id: args.order_id }).catch(() => 0);
  await d
    .log({
      level: "info",
      source: "creator.hire",
      code: "creator_hire_declined",
      message: `order ${args.order_id} declined${result.ok ? "" : ` (already ${result.code})`}${withdrawn ? ", offer withdrawn" : ""}: ${args.reason}`.slice(0, 500),
      tenant_id: args.tenant_id,
      meta: { creator_order_id: args.order_id },
    })
    .catch(() => {});
}

export async function retireCreatorHireCards(args: { tenant_id: string; order_id: string }): Promise<number> {
  const client = tenantClient(asTenantId(args.tenant_id));
  const { data, error } = await client
    .from("channel_actions")
    .select("id, exec_payload")
    .eq("exec_class", CREATOR_HIRE_CLASS)
    .eq("status", "pending");
  if (error) throw new Error(`channel_actions read failed: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string; exec_payload?: { order_id?: unknown } | null }>)
    .filter((r) => r.exec_payload?.order_id === args.order_id)
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  const { data: updated, error: upErr } = await client
    .from("channel_actions")
    .update({ status: "stale", status_at: new Date().toISOString(), note: "This hire closed before it was approved." })
    .in("id", ids)
    .eq("status", "pending")
    .select("id");
  if (upErr) throw new Error(`channel_actions retire failed: ${upErr.message}`);
  return Array.isArray(updated) ? updated.length : 0;
}
