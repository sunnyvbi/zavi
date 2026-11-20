import { readReservations } from "./funding-context";
import { refillEligibility } from "./providers";
import type Stripe from "stripe";
import { asTenantId, tenantClient, tenantRpc, resolveAdsWalletOrderTenant, applyAdsWalletPayment } from "@/services/tenant-client";
import { adsStripe, requireAdsStripe } from "./stripe-client";
import { ExpectedToolError } from "@/services/tools/types";

export const fundingEnabled = () => !["false", "0"].includes((process.env.ADS_WALLET_FUNDING_ENABLED ?? process.env.CHATGPT_ADS_FUNDING_ENABLED ?? "").trim().toLowerCase()) && !!process.env.STRIPE_ADS_WEBHOOK_SECRET?.trim() && !!adsStripe();
export const inAppPaymentsEnabled = () => fundingEnabled() && !["false", "0"].includes((process.env.ADS_WALLET_INAPP_PAYMENTS ?? process.env.CHATGPT_ADS_INAPP_PAYMENTS ?? "").trim().toLowerCase());
function configured() { if (!fundingEnabled()) throw new ExpectedToolError("ads_funding_unavailable", "Ads funding is not configured yet. Your balance has not changed."); }
function inAppConfigured() { if (!inAppPaymentsEnabled()) throw new ExpectedToolError("ads_funding_unavailable", "Card payments are not available right now. Your balance has not changed."); }
export type Wallet = { tenant_id: string; balance_cents: number; stripe_customer_id: string | null; payment_method_id: string | null; creator_consent_at: string | null; auto_refill_enabled: boolean; refill_cents: number; threshold_cents: number; pending_refill_id: string | null; setup_request_id: string | null; last_error: string | null };
export type Order = { id: string; tenant_id: string; kind: "topup" | "refill" | "setup"; amount_cents: number; status: string; payment_intent_id: string | null; created_at: string };
async function checked<T>(promise: PromiseLike<{ data: T; error: unknown }>): Promise<T> { const r = await promise; if (r.error) throw new Error("Ads wallet storage is unavailable"); return r.data; }
export async function walletRow(tenantId: string): Promise<Wallet> {
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true }));
  return await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").select("*").eq("tenant_id", tenantId).single()) as Wallet;
}
export async function readWallet(tenantId: string) {
  const w = await walletRow(tenantId);
  const reserved = await readReservations(tenantId);
  if (!Number.isSafeInteger(Number(w.balance_cents))) throw new Error("Ads wallet balance is unreadable");
  return { balance_cents: Number(w.balance_cents), reserved_cents: reserved, available_cents: Number(w.balance_cents) - reserved, currency: "USD", auto_refill_enabled: w.auto_refill_enabled, refill_cents: w.refill_cents, threshold_cents: w.threshold_cents, pending: !!w.pending_refill_id, last_error: w.last_error, funding_enabled: fundingEnabled(), in_app_enabled: inAppPaymentsEnabled() };
}

async function ensureCustomer(tenantId: string, stripe: Stripe): Promise<Wallet> {
  const wallet = await walletRow(tenantId);
  if (wallet.stripe_customer_id) return wallet;
  const customer = await stripe.customers.create({ metadata: { ads_tenant_id: tenantId } }, { idempotencyKey: `ads_customer_${tenantId}` });
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ stripe_customer_id: customer.id }).eq("tenant_id", tenantId).is("stripe_customer_id", null));
  return await walletRow(tenantId);
}

async function openOrder(tenantId: string, kind: "topup" | "setup", amount: number, requestId: string, singleUse = false, allowSettled = false): Promise<Order> {
  const { error: insertError } = await tenantClient(asTenantId(tenantId)).from("ads_wallet_orders")
    .insert({ id: requestId, tenant_id: tenantId, kind, amount_cents: amount });
  if (insertError && insertError.code !== "23505") throw new Error("Ads wallet storage is unavailable");
  if (insertError && singleUse) throw new ExpectedToolError("chatgpt_ads_conflict", "This card setup was already started. Reopen Add balance.");
  const order = await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").select("*").eq("id", requestId).eq("tenant_id", tenantId).single()) as Order;
  if (allowSettled && order && order.kind === kind && order.amount_cents === amount && (order.status === "paid" || order.status === "failed")) return order;
  if (!order || order.kind !== kind || order.amount_cents !== amount || order.status !== "pending" || Date.now() - Date.parse(order.created_at) > 23 * 3600_000) throw new ExpectedToolError("chatgpt_ads_conflict", "This payment request has expired or changed. Reopen Add balance.");
  return order;
}

export type AdsWalletPlatform = "chatgpt" | "linkedin";
const WALLET_CHANNEL: Record<AdsWalletPlatform, { name: string; slug: string }> = {
  chatgpt: { name: "ChatGPT", slug: "chatgpt_ads" },
  linkedin: { name: "LinkedIn", slug: "linkedin_ads" },
};
export async function startFunding(tenantId: string, userId: string, amount: number, mode: "topup" | "setup", requestId: string, enableRefill = false, platform: AdsWalletPlatform = "chatgpt") {
  configured();
  const stripe = requireAdsStripe();
  const wallet = await ensureCustomer(tenantId, stripe);
  await openOrder(tenantId, mode, amount, requestId);
  if (mode === "setup") {
    await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ setup_request_id: requestId, consent_at: new Date().toISOString(), consent_user_id: userId, last_error: null }).eq("tenant_id", tenantId));
  }
  const metadata = { kind: "chatgpt_ads_wallet", order_id: requestId };
  const setupMetadata = { ...metadata, creator_consent: CREATOR_CONSENT_VERSION, enable_refill: enableRefill ? "1" : "0" };
  const base = (process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com").replace(/\/$/, "");
  const { name, slug } = WALLET_CHANNEL[platform];
  const shared = { customer: wallet.stripe_customer_id!, client_reference_id: requestId, metadata, success_url: `${base}/workspace?tab=channels&channel=${slug}&ads_payment=success`, cancel_url: `${base}/workspace?tab=channels&channel=${slug}&ads_payment=cancel`, payment_method_types: ["card"] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[] };
  const session = await stripe.checkout.sessions.create(mode === "topup" ? {
    ...shared, mode: "payment", adaptive_pricing: { enabled: false }, payment_intent_data: { metadata },
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount, product_data: { name: `Zavi ${name} ads balance` } } }],
  } : { ...shared, metadata: setupMetadata, mode: "setup", setup_intent_data: { metadata: setupMetadata }, custom_text: { submit: { message: setupConsentText(amount, enableRefill, platform) } } }, { idempotencyKey: `ads_checkout_${requestId}` });
  return { url: session.url };
}

export const CREATOR_CONSENT_VERSION = "2026-09-29";
export function setupConsentText(amountCents: number, enableRefill: boolean, platform: AdsWalletPlatform = "chatgpt"): string {
  if (!enableRefill) return "Authorize Zavi to charge this card for creator hires Autopilot books within its caps.";
  const { name } = WALLET_CHANNEL[platform];
  return `Authorize Zavi to charge this card for ${name} ads refills and for creator hires Autopilot books within its caps. Refills are $${(amountCents / 100).toFixed(2)} whenever your ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the ${name} Ads channel at any time.`;
}

export async function disableRefill(tenantId: string) {
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ auto_refill_enabled: false, setup_request_id: null, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId));
}
const objectId = (x: string | { id: string } | null) => typeof x === "string" ? x : x?.id;

async function saveSetupResult(order: Order, setup: Stripe.SetupIntent, metadata: Stripe.Metadata | null | undefined): Promise<boolean> {
  const wallet = await walletRow(order.tenant_id);
  if (order.kind !== "setup" || wallet.setup_request_id !== order.id) return false;
  if (setup.status !== "succeeded" || objectId(setup.customer) !== wallet.stripe_customer_id || !objectId(setup.payment_method)) throw new Error("Ads payment method is not ready");
  const creatorConsent = metadata?.creator_consent === CREATOR_CONSENT_VERSION ? new Date().toISOString() : null;
  const wantsRefill = metadata?.enable_refill === undefined || metadata.enable_refill === "1";
  const refill = wantsRefill ? { refill_cents: order.amount_cents, auto_refill_enabled: true } : { auto_refill_enabled: false };
  const rows = await checked(tenantClient(asTenantId(order.tenant_id)).from("ads_wallets").update({ payment_method_id: objectId(setup.payment_method), creator_consent_at: creatorConsent, ...refill, setup_request_id: null, last_error: null }).eq("tenant_id", order.tenant_id).eq("setup_request_id", order.id).select("tenant_id"));
  return Array.isArray(rows) ? rows.length > 0 : !!rows;
}

export function inAppConsentFor(platform: AdsWalletPlatform = "chatgpt") {
  const { name } = WALLET_CHANNEL[platform];
  return {
    version: CREATOR_CONSENT_VERSION,
    save_text: `Save this card to your Zavi ads wallet and authorize Zavi to charge it for ${name} ads balance you add.`,
    refill_text: `Also authorize Zavi to charge this card {amount} whenever your ${name} ads balance falls below $50, up to $1,000 per UTC day. Disable auto-refill in the ${name} Ads channel at any time.`,
    creator_text: "Also authorize Zavi to charge this card for creator hires Autopilot books within its caps.",
  };
}
export const inAppConsent = inAppConsentFor("chatgpt");
export type SavedCard = { id: string; brand: string; last4: string; funding: string; exp_month: number; exp_year: number; city: string | null; state: string | null };
type CardChoice = { amount: number; enableRefill: boolean; allowCreators: boolean };

export async function listCards(tenantId: string, platform: AdsWalletPlatform = "chatgpt") {
  inAppConfigured();
  const wallet = await walletRow(tenantId);
  const base = { tenant_id: tenantId, selected_id: wallet.payment_method_id, creator_consent: !!wallet.creator_consent_at, consent: inAppConsentFor(platform) };
  if (!wallet.stripe_customer_id) return { cards: [] as SavedCard[], ...base };
  const list = await requireAdsStripe().customers.listPaymentMethods(wallet.stripe_customer_id, { type: "card", limit: 100 });
  const cards: SavedCard[] = list.data.filter(pm => pm.card).map(pm => ({
    id: pm.id, brand: pm.card!.brand, last4: pm.card!.last4, funding: pm.card!.funding, exp_month: pm.card!.exp_month, exp_year: pm.card!.exp_year,
    city: pm.billing_details?.address?.city ?? null, state: pm.billing_details?.address?.state ?? null,
  }));
  return { cards, ...base };
}

export async function createSetup(tenantId: string, userId: string, requestId: string, choice: CardChoice) {
  inAppConfigured();
  const stripe = requireAdsStripe();
  const wallet = await ensureCustomer(tenantId, stripe);
  await openOrder(tenantId, "setup", choice.amount, requestId, true);
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ setup_request_id: requestId, consent_at: new Date().toISOString(), consent_user_id: userId, last_error: null }).eq("tenant_id", tenantId));
  const metadata: Record<string, string> = { kind: "chatgpt_ads_wallet", order_id: requestId, enable_refill: choice.enableRefill ? "1" : "0" };
  if (choice.allowCreators) metadata.creator_consent = CREATOR_CONSENT_VERSION;
  const setup = await stripe.setupIntents.create({ customer: wallet.stripe_customer_id!, usage: "off_session", payment_method_types: ["card"], metadata }, { idempotencyKey: `ads_setup_${requestId}` });
  return { client_secret: setup.client_secret, setup_intent_id: setup.id };
}

export async function completeSetup(tenantId: string, setupIntentId: string) {
  configured();
  const stripe = requireAdsStripe();
  const setup = await stripe.setupIntents.retrieve(setupIntentId);
  if (setup.metadata?.kind !== "chatgpt_ads_wallet" || !setup.metadata.order_id) throw new ExpectedToolError("chatgpt_ads_not_found", "This card setup was not found.");
  if (setup.status !== "succeeded") throw new ExpectedToolError("chatgpt_ads_card_not_ready", "The card was not confirmed. Try adding it again.");
  const order = await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").select("*").eq("id", setup.metadata.order_id).eq("tenant_id", tenantId).maybeSingle()) as Order | null;
  const wallet = await walletRow(tenantId);
  if (!order || objectId(setup.customer) !== wallet.stripe_customer_id) throw new ExpectedToolError("chatgpt_ads_not_found", "This card setup was not found.");
  if (await saveSetupResult(order, setup, setup.metadata)) return { applied: true };
  return { applied: (await walletRow(tenantId)).payment_method_id === objectId(setup.payment_method) };
}

export async function selectCard(tenantId: string, userId: string, paymentMethodId: string, choice: CardChoice) {
  inAppConfigured();
  const wallet = await walletRow(tenantId);
  const pm = wallet.stripe_customer_id ? await requireAdsStripe().paymentMethods.retrieve(paymentMethodId).catch(() => null) : null;
  if (!pm || objectId(pm.customer) !== wallet.stripe_customer_id) throw new ExpectedToolError("chatgpt_ads_card_unknown", "That card is not saved on this workspace.");
  const refill = choice.enableRefill ? { refill_cents: choice.amount, auto_refill_enabled: true } : { auto_refill_enabled: false };
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ payment_method_id: pm.id, creator_consent_at: choice.allowCreators ? new Date().toISOString() : null, ...refill, setup_request_id: null, consent_at: new Date().toISOString(), consent_user_id: userId, last_error: null }).eq("tenant_id", tenantId));
  return { selected_id: pm.id };
}

type PayStatus = { order_id: string; status: "pending" | "requires_action" | "paid" | "failed"; client_secret?: string | null };
async function failOrder(tenantId: string, orderId: string) {
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").update({ status: "failed" }).eq("id", orderId).eq("tenant_id", tenantId).eq("status", "pending"));
}
async function mapIntent(tenantId: string, orderId: string, pi: Stripe.PaymentIntent): Promise<PayStatus> {
  if (pi.status === "requires_action") return { order_id: orderId, status: "requires_action", client_secret: pi.client_secret };
  if (pi.status === "requires_payment_method" || pi.status === "canceled") { await failOrder(tenantId, orderId); return { order_id: orderId, status: "failed" }; }
  return { order_id: orderId, status: "pending" };
}

export async function payWithCard(tenantId: string, amount: number, requestId: string, paymentMethodId: string): Promise<PayStatus> {
  inAppConfigured();
  const stripe = requireAdsStripe();
  const wallet = await walletRow(tenantId);
  const existing = await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").select("*").eq("id", requestId).eq("tenant_id", tenantId).maybeSingle()) as Order | null;
  if (existing && existing.kind === "topup" && existing.amount_cents === amount) {
    if (existing.status === "paid" || existing.status === "failed") return { order_id: existing.id, status: existing.status as "paid" | "failed" };
    if (existing.payment_intent_id) return mapIntent(tenantId, existing.id, await stripe.paymentIntents.retrieve(existing.payment_intent_id));
  }
  if (!wallet.stripe_customer_id || !wallet.payment_method_id) throw new ExpectedToolError("chatgpt_ads_card_required", "Add a card before paying.");
  if (wallet.payment_method_id !== paymentMethodId) throw new ExpectedToolError("chatgpt_ads_conflict", "Your saved card changed. Check the card and try again.");
  const others = await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").select("*").eq("tenant_id", tenantId).eq("kind", "topup").eq("status", "pending").neq("id", requestId).not("payment_intent_id", "is", null).gte("created_at", new Date(Date.now() - 23 * 3600_000).toISOString()));
  for (const other of (Array.isArray(others) ? others : []) as Order[]) {
    const st = (await mapIntent(tenantId, other.id, await stripe.paymentIntents.retrieve(other.payment_intent_id!))).status;
    const busy = new ExpectedToolError("chatgpt_ads_conflict", "Another payment is still being confirmed. Wait a minute, then reopen Add balance.");
    if (st === "pending" || (st === "requires_action" && Date.now() - Date.parse(other.created_at) < 3600_000)) throw busy;
    if (st === "requires_action") {
      const canceled = await stripe.paymentIntents.cancel(other.payment_intent_id!).catch(() => null);
      if (canceled?.status !== "canceled") throw busy;
      await failOrder(tenantId, other.id);
    }
  }
  const order = await openOrder(tenantId, "topup", amount, requestId, false, true);
  if (order.status === "paid" || order.status === "failed") return { order_id: order.id, status: order.status as "paid" | "failed" };
  if (order.payment_intent_id) return mapIntent(tenantId, order.id, await stripe.paymentIntents.retrieve(order.payment_intent_id));
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create({ amount, currency: "usd", customer: wallet.stripe_customer_id, payment_method: paymentMethodId, confirm: true, use_stripe_sdk: true, payment_method_types: ["card"], metadata: { kind: "chatgpt_ads_wallet", order_id: order.id } }, { idempotencyKey: `ads_pay_${order.id}` });
  } catch (e) {
    const failed = (e as { payment_intent?: Stripe.PaymentIntent }).payment_intent;
    if (failed?.id) await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").update({ payment_intent_id: failed.id }).eq("id", order.id).eq("tenant_id", tenantId));
    if ((e as { type?: string }).type === "StripeCardError") {
      await failOrder(tenantId, order.id);
      throw new ExpectedToolError("chatgpt_ads_card_declined", `${(e as Error).message || "Your card was declined."} Nothing was charged.`);
    }
    throw e;
  }
  await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").update({ payment_intent_id: pi.id }).eq("id", order.id).eq("tenant_id", tenantId));
  return mapIntent(tenantId, order.id, pi);
}

export async function orderStatus(tenantId: string, orderId: string): Promise<PayStatus> {
  const order = await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").select("*").eq("id", orderId).eq("tenant_id", tenantId).maybeSingle()) as Order | null;
  if (!order || order.kind !== "topup") throw new ExpectedToolError("chatgpt_ads_not_found", "This payment was not found.");
  if (order.status === "paid" || order.status === "failed") return { order_id: order.id, status: order.status as "paid" | "failed" };
  if (!order.payment_intent_id) {
    if (Date.now() - Date.parse(order.created_at) > 23 * 3600_000) { await failOrder(tenantId, order.id); return { order_id: order.id, status: "failed" }; }
    return { order_id: order.id, status: "pending" };
  }
  if (!fundingEnabled()) return { order_id: order.id, status: "pending" };
  const pi = await requireAdsStripe().paymentIntents.retrieve(order.payment_intent_id);
  const mapped = await mapIntent(tenantId, order.id, pi);
  return mapped.status === "requires_action" ? { order_id: order.id, status: "requires_action" } : mapped;
}

export async function applyWalletEvent(event: Stripe.Event) {
  const stripe = requireAdsStripe();
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.kind !== "chatgpt_ads_wallet" || session.mode !== "setup") return;
    const tenantId = await resolveAdsWalletOrderTenant(session.metadata.order_id);
    const order = await checked(tenantClient(tenantId).from("ads_wallet_orders").select("*").eq("id", session.metadata.order_id).single()) as Order;
    const wallet = await walletRow(order.tenant_id);
    if (order.kind !== "setup" || wallet.setup_request_id !== order.id || objectId(session.customer) !== wallet.stripe_customer_id) return;
    const setupId = objectId(session.setup_intent); if (!setupId) throw new Error("Missing ads setup intent");
    await saveSetupResult(order, await stripe.setupIntents.retrieve(setupId), session.metadata);
    return;
  }
  if (event.type === "setup_intent.succeeded") {
    const payload = event.data.object as Stripe.SetupIntent;
    if (payload.metadata?.kind !== "chatgpt_ads_wallet" || !payload.metadata.order_id) return;
    const tenantId = await resolveAdsWalletOrderTenant(payload.metadata.order_id);
    const order = await checked(tenantClient(tenantId).from("ads_wallet_orders").select("*").eq("id", payload.metadata.order_id).single()) as Order;
    const wallet = await walletRow(order.tenant_id);
    if (order.kind !== "setup" || wallet.setup_request_id !== order.id) return;
    const setup = await stripe.setupIntents.retrieve(payload.id);
    await saveSetupResult(order, setup, setup.metadata);
    return;
  }
  let intentId: string | undefined;
  if (event.type === "payment_intent.succeeded") intentId = (event.data.object as Stripe.PaymentIntent).id;
  else if (event.type === "charge.refunded") intentId = objectId((event.data.object as Stripe.Charge).payment_intent);
  else if (["refund.created", "refund.updated", "refund.failed", "charge.refund.updated"].includes(event.type)) intentId = objectId((event.data.object as Stripe.Refund).payment_intent);
  else if (event.type.startsWith("charge.dispute.")) intentId = objectId((event.data.object as Stripe.Dispute).payment_intent);
  if (!intentId) return;
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
  if (intent.metadata.kind !== "chatgpt_ads_wallet") return;
  const tenantId = await resolveAdsWalletOrderTenant(intent.metadata.order_id);
  const order = await checked(tenantClient(tenantId).from("ads_wallet_orders").select("*").eq("id", intent.metadata.order_id).single()) as Order;
  const wallet = await walletRow(order.tenant_id);
  if (order.kind === "setup" || objectId(intent.customer) !== wallet.stripe_customer_id) throw new Error("Ads payment does not match its order");
  const converted = intent.currency !== "usd" || intent.amount !== order.amount_cents;
  if (converted && !(await convertedCheckoutMatches(intent, order))) throw new Error("Ads payment does not match its order");
  if (intent.status !== "succeeded") return;
  const charge = intent.latest_charge as Stripe.Charge | null;
  if (!charge || typeof charge === "string") throw new Error("Ads charge unavailable");
  const refundEvent = event.type.startsWith("refund.") || event.type.startsWith("charge.refund");
  if (charge.amount_refunded > 0 || charge.disputed || refundEvent || event.type.startsWith("charge.dispute.")) await disableRefill(tenantId);
  let refundedCents = 0;
  if (charge.amount_refunded > 0 || refundEvent) {
    let after: string | undefined;
    for (let page = 0; ; page++) {
      const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const r of refunds.data) {
        if (r.status === "failed" || r.status === "canceled") continue;
        if (!["succeeded", "pending", "requires_action"].includes(r.status ?? "") || !Number.isSafeInteger(r.amount) || r.amount < 0 || r.currency !== intent.currency) throw new Error("Ads refund amount could not be verified");
        refundedCents += r.amount;
      }
      if (!refunds.has_more) break;
      const next = refunds.data.at(-1)?.id;
      if (!next || next === after || page >= 9) throw new Error("Ads refunds could not be completely read");
      after = next;
    }
  }
  let disputedCents = 0;
  if (charge.disputed) {
    let after: string | undefined;
    for (let page = 0; ; page++) {
      const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const d of disputes.data) {
        if (d.status === "won" || d.status === "warning_closed") continue;
        if (!Number.isSafeInteger(d.amount) || d.amount < 0 || d.currency !== intent.currency) throw new Error("Ads dispute amount could not be verified");
        disputedCents += d.amount;
      }
      if (!disputes.has_more) break;
      const next = disputes.data.at(-1)?.id;
      if (!next || next === after || page >= 9) throw new Error("Ads disputes could not be completely read");
      after = next;
    }
  }
  const paid = Math.max(0, Math.min(intent.amount_received, intent.amount) - refundedCents - disputedCents);
  const net = converted ? Math.floor(order.amount_cents * paid / intent.amount) : Math.max(0, intent.amount_received - refundedCents - disputedCents);
  await checked(applyAdsWalletPayment(tenantId, { p_order_id: order.id, p_payment_intent_id: intent.id, p_net_cents: net, p_event_created: event.created }));
  if (event.type === "payment_intent.succeeded" && net > 0 && order.kind === "topup")
    await checked(tenantClient(tenantId).from("ads_wallets").update({ last_error: null }).eq("tenant_id", order.tenant_id).in("last_error", [REFILL_DECLINED_MESSAGE, REFILL_UNFINISHED_MESSAGE, REFILL_APPROVAL_MESSAGE]));
  if (event.type === "payment_intent.succeeded" && net > 0) {
    const { resumeFundedPlans } = await import("./plan-funding");
    await resumeFundedPlans(tenantId, order.id);
  }
}

async function convertedCheckoutMatches(intent: Stripe.PaymentIntent, order: Order): Promise<boolean> {
  if (order.kind !== "topup" || !Number.isSafeInteger(intent.amount) || intent.amount <= 0) return false;
  const sessions = await requireAdsStripe().checkout.sessions.list({ payment_intent: intent.id, limit: 10 });
  return sessions.data.some(s => s.mode === "payment" && s.metadata?.kind === "chatgpt_ads_wallet" && s.metadata.order_id === order.id
    && s.currency === intent.currency && s.amount_total === intent.amount
    && s.currency_conversion?.source_currency === "usd" && s.currency_conversion.amount_total === order.amount_cents);
}

export const REFILL_DECLINED_MESSAGE = "Auto-refill was declined by your card. Add balance manually or set up auto-refill again with another card.";
export const REFILL_UNFINISHED_MESSAGE = "Auto-refill could not complete. Add balance manually, or turn auto-refill back on: Zavi first checks the unfinished refill, so your card is never charged twice for it.";
export const REFILL_APPROVAL_MESSAGE = "Your bank asked you to approve the auto-refill payment, so nothing was charged and auto-refill is off. Use Add balance to pay now and approve it with your bank, then set up auto-refill again so your bank can approve future refills.";
export const REFILL_PAUSED_MESSAGE = "Auto-refill is paused because Zavi has switched ads funding off for now. It turns back on by itself when funding is back; your card is not charged in the meantime.";
export const REFILL_PLAN_MESSAGE = "Auto-refill is paused because your plan no longer includes LinkedIn Ads, so your card is not charged. Campaigns already running keep spending only the budget set aside when they launched. Auto-refill turns back on by itself when you move back to Pro.";
export async function ensureRefillEntitlement(tenantId: string): Promise<boolean> {
  const eligibility = await refillEligibility(tenantId);
  if (eligibility === "denied") await disableRefill(tenantId);
  if (eligibility === "paused") await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ last_error: REFILL_PAUSED_MESSAGE }).eq("tenant_id", tenantId).eq("auto_refill_enabled", true));
  if (eligibility === "below_plan") await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ last_error: REFILL_PLAN_MESSAGE }).eq("tenant_id", tenantId).eq("auto_refill_enabled", true));
  if (eligibility === "allowed") await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ last_error: null }).eq("tenant_id", tenantId).in("last_error", [REFILL_PAUSED_MESSAGE, REFILL_PLAN_MESSAGE]));
  return eligibility === "allowed";
}

const REFILL_LOOKUP_GRACE_MS = 10 * 60_000;
async function findRefillIntent(stripe: Stripe, customer: string, order: Order): Promise<Stripe.PaymentIntent | null | undefined> {
  const since = Math.floor(Date.parse(order.created_at) / 1000) - 300;
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await stripe.paymentIntents.list({ customer, created: { gte: since }, limit: 100, ...(after ? { starting_after: after } : {}) });
    const hit = list.data.find(pi => pi.metadata?.kind === "chatgpt_ads_wallet" && pi.metadata.order_id === order.id);
    if (hit) return hit;
    if (!list.has_more) return null;
    const next = list.data.at(-1)?.id;
    if (!next || next === after) return undefined;
    after = next;
  }
  return undefined;
}
async function settlePendingRefill(tenantId: string, wallet: Wallet): Promise<boolean> {
  const orderId = wallet.pending_refill_id!;
  const db = () => tenantClient(asTenantId(tenantId));
  const release = async (fail: boolean) => {
    await checked(db().from("ads_wallets").update({ pending_refill_id: null }).eq("tenant_id", tenantId).eq("pending_refill_id", orderId));
    if (fail) await checked(db().from("ads_wallet_orders").update({ status: "failed" }).eq("id", orderId).eq("tenant_id", tenantId).eq("status", "pending"));
    return true;
  };
  const order = await checked(db().from("ads_wallet_orders").select("*").eq("id", orderId).eq("tenant_id", tenantId).maybeSingle()) as Order | null;
  if (!order || order.kind !== "refill" || order.status !== "pending") return release(false);
  const stripe = requireAdsStripe();
  let pi: Stripe.PaymentIntent | null | undefined;
  if (order.payment_intent_id) pi = await stripe.paymentIntents.retrieve(order.payment_intent_id);
  else {
    if (Date.now() - Date.parse(order.created_at) < REFILL_LOOKUP_GRACE_MS) return false;
    pi = wallet.stripe_customer_id ? await findRefillIntent(stripe, wallet.stripe_customer_id, order) : null;
    if (pi === undefined) return false;
    if (pi === null) return release(true);
    await checked(db().from("ads_wallet_orders").update({ payment_intent_id: pi.id }).eq("id", orderId).eq("tenant_id", tenantId).is("payment_intent_id", null));
  }
  if (pi.status === "requires_action") {
    const canceled = await stripe.paymentIntents.cancel(pi.id).catch(() => null);
    return canceled?.status === "canceled" ? release(true) : false;
  }
  if (pi.status === "requires_payment_method" || pi.status === "canceled") return release(true);
  return false;
}

export async function refillWallet(tenantId: string) {
  if (!fundingEnabled() || !await ensureRefillEntitlement(tenantId)) return;
  const current = await walletRow(tenantId);
  if (current.pending_refill_id && !await settlePendingRefill(tenantId, current)) return;
  const orderId = await checked(tenantRpc(asTenantId(tenantId), "ads_wallet_claim_refill", { p_tenant_id: tenantId })) as string | null;
  if (!orderId) return;
  const wallet = await walletRow(tenantId);
  if (!wallet.auto_refill_enabled || !wallet.payment_method_id || !wallet.stripe_customer_id) return;
  const order = await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").select("*").eq("id", orderId).eq("tenant_id", tenantId).single()) as Order;
  if (order.status !== "pending") return;
  if (Date.now() - Date.parse(order.created_at) > 23 * 3600_000) {
    await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ auto_refill_enabled: false, last_error: "A refill needs payment review. No further automatic charges will be attempted." }).eq("tenant_id", tenantId)); return;
  }
  let piStatus: string | undefined;
  let createdIntentId: string | undefined;
  try {
    if (!await ensureRefillEntitlement(tenantId)) return;
    const stripe = requireAdsStripe();
    const pi = await stripe.paymentIntents.create({ amount: order.amount_cents, currency: "usd", customer: wallet.stripe_customer_id, payment_method: wallet.payment_method_id, off_session: true, confirm: true, metadata: { kind: "chatgpt_ads_wallet", order_id: orderId }, payment_method_types: ["card"] }, { idempotencyKey: `ads_refill_${orderId}` });
    piStatus = pi.status;
    createdIntentId = pi.id;
    await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").update({ payment_intent_id: pi.id }).eq("id", orderId));
    if (pi.status !== "succeeded" && pi.status !== "processing") throw new Error("Payment requires attention");
  } catch (e) {
    const err = e as { type?: string; code?: string; decline_code?: string; payment_intent?: { id?: string; status?: string } };
    const stripeError = typeof err?.type === "string" && err.type.startsWith("Stripe");
    if (piStatus === "succeeded" || piStatus === "processing" || (!stripeError && piStatus === undefined)) throw e;
    const authentication = piStatus === "requires_action" || err?.payment_intent?.status === "requires_action"
      || err?.code === "authentication_required" || err?.decline_code === "authentication_required";
    if (authentication) {
      const openIntent = piStatus === "requires_action" ? createdIntentId : err?.payment_intent?.status === "requires_action" ? err.payment_intent.id : undefined;
      const released = !openIntent || (await requireAdsStripe().paymentIntents.cancel(openIntent).catch(() => null))?.status === "canceled";
      if (!released) {
        await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ auto_refill_enabled: false, last_error: REFILL_APPROVAL_MESSAGE }).eq("tenant_id", tenantId));
        return;
      }
      await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ pending_refill_id: null, auto_refill_enabled: false, last_error: REFILL_APPROVAL_MESSAGE }).eq("tenant_id", tenantId).eq("pending_refill_id", orderId));
      await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").update({ status: "failed" }).eq("id", orderId).eq("tenant_id", tenantId).eq("status", "pending"));
      return;
    }
    const declined = piStatus === "requires_payment_method" || piStatus === "canceled"
      || (err?.type === "StripeCardError" && (!err.payment_intent || err.payment_intent.status === "requires_payment_method"));
    if (declined) {
      await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ pending_refill_id: null, auto_refill_enabled: false, last_error: REFILL_DECLINED_MESSAGE }).eq("tenant_id", tenantId).eq("pending_refill_id", orderId));
      await checked(tenantClient(asTenantId(tenantId)).from("ads_wallet_orders").update({ status: "failed" }).eq("id", orderId).eq("tenant_id", tenantId).eq("status", "pending"));
      return;
    }
    await checked(tenantClient(asTenantId(tenantId)).from("ads_wallets").update({ auto_refill_enabled: false, last_error: REFILL_UNFINISHED_MESSAGE }).eq("tenant_id", tenantId));
  }
}
