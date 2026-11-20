import { createHash } from "node:crypto";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { fundingEnabled } from "./wallet";

const HOUR = 3_600_000;
export const PLAN_FUNDING_WINDOW_HOURS = 48;
export const WALLET_SHORT_CODE = "chatgpt_ads_wallet_short";

export function planOrderId(action_id: string, window: number): string {
  const h = createHash("sha256").update(`plan-funding:${action_id}:${window}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function fundingWindow(proposedAtMs: number, nowMs: number): 0 | 1 | null {
  const age = nowMs - proposedAtMs;
  if (!(age >= 0) || age >= PLAN_FUNDING_WINDOW_HOURS * HOUR) return age < 0 ? 0 : null;
  return age >= 24 * HOUR ? 1 : 0;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export type FundingOutcome = { kind: "charged" | "link" | "dropped" | "unavailable"; line: string };

export type PlanFundingDeps = {
  fundingEnabled?: () => boolean;
  claim?: (tenant_id: string, order_id: string, amount_cents: number) => Promise<{ status: string; order_status?: string; replayed?: boolean; payment_intent_id?: string | null }>;
  charge?: (tenant_id: string, order_id: string, amount_cents: number) => Promise<{ ok: boolean; card: string | null }>;
  link?: (tenant_id: string, actor_user_id: string, amount_cents: number, order_id: string) => Promise<string | null>;
};

export async function fundApprovedPlan(
  tenant_id: string,
  a: { action_id: string; actor_user_id: string; shortfall_cents: number; proposed_at_ms: number },
  now = Date.now(),
  deps: PlanFundingDeps = {},
): Promise<FundingOutcome> {
  const enabled = deps.fundingEnabled ?? fundingEnabled;
  if (!enabled()) return { kind: "unavailable", line: "ChatGPT ads funding is unavailable right now, so nothing ran." };
  const win = fundingWindow(a.proposed_at_ms, now);
  if (win === null) return { kind: "dropped", line: "The ChatGPT balance was not added within 48 hours, so this ad was dropped. Nothing was spent." };
  const amount = Math.max(100, Math.ceil(a.shortfall_cents));
  if (amount > 100_000) return { kind: "unavailable", line: `This ad needs ${usd(amount)} more ChatGPT balance, above the $1,000 a day Zavi charges at once. Add balance in the ChatGPT Ads channel.` };
  const order = planOrderId(a.action_id, 0);
  const claim = deps.claim ?? claimShortfall;
  const c = await claim(tenant_id, order, amount);
  if (c.status === "claimed") {
    if (c.order_status === "paid") return { kind: "charged", line: `${usd(amount)} was already added to your ChatGPT balance. The ad starts now.` };
    if (c.replayed && c.order_status === "pending" && c.payment_intent_id) {
      return { kind: "charged", line: `The ${usd(amount)} payment for the ChatGPT balance is on its way; the ad starts when it lands.` };
    }
    if (!(c.replayed && c.order_status === "failed")) {
      const r = await (deps.charge ?? chargeShortfall)(tenant_id, order, amount);
      if (r.ok) return { kind: "charged", line: `I charged ${usd(amount)} to your saved card${r.card ? ` (${r.card})` : ""} for the ChatGPT balance. The ad starts when the payment lands.` };
    }
  }
  const url = await (deps.link ?? checkoutLink)(tenant_id, a.actor_user_id, amount, planOrderId(a.action_id, 10 + win));
  return url
    ? { kind: "link", line: `Add ${usd(amount)} to start: ${url}` }
    : { kind: "unavailable", line: `Add ${usd(amount)} of ChatGPT balance in the ChatGPT Ads channel to start this ad.` };
}

async function claimShortfall(tenant_id: string, order_id: string, amount_cents: number): Promise<{ status: string; order_status?: string; replayed?: boolean; payment_intent_id?: string | null }> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "ads_wallet_claim_shortfall", { p_order_id: order_id, p_amount_cents: amount_cents });
  if (error) throw new Error(`ads_wallet_claim_shortfall failed: ${error.message}`);
  return (data ?? { status: "unknown" }) as { status: string; order_status?: string; replayed?: boolean; payment_intent_id?: string | null };
}

async function chargeShortfall(tenant_id: string, order_id: string, amount_cents: number): Promise<{ ok: boolean; card: string | null }> {
  const { walletRow } = await import("./wallet");
  const { requireAdsStripe } = await import("./stripe-client");
  const wallet = await walletRow(tenant_id);
  if (!wallet.auto_refill_enabled || !wallet.payment_method_id || !wallet.stripe_customer_id) return { ok: false, card: null };
  const stripe = requireAdsStripe();
  let card: string | null = null;
  try {
    const pm = await stripe.paymentMethods.retrieve(wallet.payment_method_id);
    if (pm.card) card = `${pm.card.brand.charAt(0).toUpperCase()}${pm.card.brand.slice(1)} ending ${pm.card.last4}`;
  } catch {
  }
  const db = tenantClient(asTenantId(tenant_id));
  try {
    const pi = await stripe.paymentIntents.create(
      { amount: amount_cents, currency: "usd", customer: wallet.stripe_customer_id, payment_method: wallet.payment_method_id, off_session: true, confirm: true, metadata: { kind: "chatgpt_ads_wallet", order_id }, payment_method_types: ["card"] },
      { idempotencyKey: `ads_shortfall_${order_id}` },
    );
    await db.from("ads_wallet_orders").update({ payment_intent_id: pi.id }).eq("id", order_id).eq("tenant_id", tenant_id);
    return { ok: pi.status === "succeeded" || pi.status === "processing", card };
  } catch (e) {
    const err = e as { type?: string; payment_intent?: { status?: string } };
    if (err?.type === "StripeCardError" && (!err.payment_intent || err.payment_intent.status === "requires_payment_method")) {
      await db.from("ads_wallet_orders").update({ status: "failed" }).eq("id", order_id).eq("tenant_id", tenant_id).eq("status", "pending");
    }
    return { ok: false, card };
  }
}

async function checkoutLink(tenant_id: string, actor_user_id: string, amount_cents: number, order_id: string): Promise<string | null> {
  try {
    const { startFunding } = await import("./wallet");
    const r = await startFunding(tenant_id, actor_user_id, amount_cents, "topup", order_id);
    return r.url ?? null;
  } catch (e) {
    console.warn(`[plan-funding] no Checkout link for ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}

export async function resumeFundedPlans(tenant_id: string, paid_order_id: string, now = Date.now()): Promise<number> {
  let resumed = 0;
  try {
    const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
    if (!(await adsNoFrictionEnabled())) return 0;
    const since = new Date(now - PLAN_FUNDING_WINDOW_HOURS * HOUR).toISOString();
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("channel_actions")
      .select("id, exec_class, exec_payload, exec_status, exec_result, approval_envelope, proposed_at")
      .eq("tenant_id", tenant_id)
      .eq("exec_class", "chatgpt_ads.create_and_launch")
      .eq("exec_status", "failed")
      .not("approval_envelope", "is", null)
      .gte("proposed_at", since)
      .limit(20);
    if (error) throw new Error(error.message);
    const { parseEnvelope, verifyEnvelope, claimApprovalEnvelope } = await import("@/services/approvals/approval-envelope");
    const { approveChannelAction } = await import("@/services/channels/exec-actions");
    for (const row of (data ?? []) as Array<{ id: string; exec_class: string; exec_payload: unknown; exec_result: { code?: unknown } | null; approval_envelope: unknown }>) {
      if (row.exec_result?.code !== WALLET_SHORT_CODE) continue;
      const env = parseEnvelope(row.approval_envelope);
      if (!env) continue;
      const v = await verifyEnvelope(tenant_id, env, row.exec_class, row.exec_payload);
      if (!v.ok) continue;
      const claim = await claimApprovalEnvelope(tenant_id, env.envelope_id, row.id);
      if (!claim.ok) continue;
      const r = await approveChannelAction(tenant_id, { actionId: row.id, eventKey: `resume:${paid_order_id}:${row.id}`, actorUserId: env.actor_user_id });
      if (!r.ok) continue;
      if (!r.replayed || r.stillQueued) {
        const { inngest } = await import("@/../workers/client");
        await inngest.send({ id: `approve:${row.id}:${r.attempt}`, name: "channel-action.approved", data: { action_id: row.id } });
      }
      resumed++;
    }
  } catch (e) {
    console.warn(`[plan-funding] resuming funded plans for ${tenant_id} failed: ${(e as Error).message}`);
  }
  return resumed;
}
