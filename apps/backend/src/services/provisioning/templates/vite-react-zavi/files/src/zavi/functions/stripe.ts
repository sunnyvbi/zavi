
import { defineFunction, defineWebhook, FunctionError, type DefinedFunction, type FunctionContext, type FunctionRecord, type WebhookVerifier } from "./index";

export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_HOST = "api.stripe.com";
export const DEFAULT_SECRET_KEY_NAME = "STRIPE_SECRET_KEY";
export const DEFAULT_WEBHOOK_SECRET_NAME = "STRIPE_WEBHOOK_SECRET";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  data: { object: Record<string, unknown> };
};

export type KeyMode = "test" | "live" | "unknown";

export function stripeKeyMode(key: string): KeyMode {
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "unknown";
}

export function assertKeyAllowed(key: string, live: boolean): void {
  const mode = stripeKeyMode(key);
  if (mode === "unknown") {
    throw new FunctionError(503, "stripe_key_invalid", "The saved Stripe key is not a secret key (it should start with sk_test_ or sk_live_). Fix it in Settings > Secrets.");
  }
  if (mode === "live" && !live) {
    throw new FunctionError(503, "payments_test_mode", "This site takes test payments only. Save a test key (sk_test_...) in Settings > Secrets, or ask Zavi to turn on live payments.");
  }
  if (mode === "test" && live) {
    throw new FunctionError(503, "payments_live_mode", "This site takes real payments, so it needs your live Stripe key (sk_live_...). Save it in Settings > Secrets.");
  }
}

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

export async function stripeSignatureHeader(payload: string, secret: string, timestampSec: number): Promise<string> {
  return `t=${timestampSec},v1=${await hmacSha256Hex(secret, `${timestampSec}.${payload}`)}`;
}

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): Promise<StripeEvent> {
  const bad = (why: string) => new FunctionError(401, "invalid_signature", `Stripe signature check failed: ${why}`);
  if (!header) throw bad("no Stripe-Signature header");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === null || v1.length === 0) throw bad("malformed header");
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) throw bad("timestamp outside the tolerance");
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  if (!v1.some((s) => timingSafeEqual(s, expected))) throw bad("signature does not match");
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new FunctionError(400, "validation", "The Stripe event is not JSON.");
  }
  const e = event as Partial<StripeEvent> | null;
  if (!e || typeof e.id !== "string" || typeof e.type !== "string" || typeof e.livemode !== "boolean" || !e.data || typeof e.data.object !== "object" || e.data.object === null) {
    throw new FunctionError(400, "validation", "The Stripe event has no id, type, mode or object.");
  }
  return { id: e.id, type: e.type, livemode: e.livemode, created: Number(e.created ?? 0), data: { object: e.data.object as Record<string, unknown> } };
}

export function stripeSignature(secretName: string = DEFAULT_WEBHOOK_SECRET_NAME): WebhookVerifier<StripeEvent> {
  return async (req, ctx) => {
    const secret = await ctx.secrets.require(secretName);
    return verifyStripeSignature(req.rawBody, req.headers.get("stripe-signature"), secret, { nowSec: Math.floor(ctx.now().getTime() / 1000) });
  };
}

export function formEncode(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") parts.push(formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      const inner = formEncode(v as Record<string, unknown>, key);
      if (inner) parts.push(inner);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export async function stripePost<T = Record<string, unknown>>(
  ctx: FunctionContext,
  path: string,
  params: Record<string, unknown>,
  opts: { idempotencyKey?: string; secretName?: string; live?: boolean } = {},
): Promise<T> {
  return stripeRequest<T>(ctx, "POST", path, params, opts);
}

export async function stripeGet<T = Record<string, unknown>>(ctx: FunctionContext, path: string, opts: { secretName?: string; live?: boolean } = {}): Promise<T> {
  return stripeRequest<T>(ctx, "GET", path, null, opts);
}

async function stripeRequest<T>(
  ctx: FunctionContext,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> | null,
  opts: { idempotencyKey?: string; secretName?: string; live?: boolean },
): Promise<T> {
  const key = await ctx.secrets.require(opts.secretName ?? DEFAULT_SECRET_KEY_NAME);
  assertKeyAllowed(key, opts.live === true);
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await ctx.fetch(`${STRIPE_API}${path}`, params === null ? { method, headers } : { method, headers, body: formEncode(params) });
  } catch (e) {
    ctx.log.error(`stripe request failed: ${(e as Error).message}`);
    throw new FunctionError(502, "stripe_unreachable", "Could not reach Stripe. Try again in a moment.");
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    const err = (body.error ?? {}) as { type?: unknown; code?: unknown; message?: unknown };
    ctx.log.error(`stripe ${path} answered ${res.status}`, { type: String(err.type ?? ""), code: String(err.code ?? "") });
    if (res.status === 401) throw new FunctionError(503, "stripe_key_rejected", "Stripe refused the saved key. Check it in Settings > Secrets.");
    throw new FunctionError(502, "stripe_error", typeof err.message === "string" ? err.message : "Stripe could not complete this.");
  }
  return body as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[a-z]{3}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;
const CLAIM_ID = /^claim_[0-9a-f]{32}$/;
export const STALE_START_MS = 120_000;

export type PaymentConfig = {
  orders: string;
  price: { collection: string; reference: string; amount: string; name?: string };
  quantity?: string;
  currency?: string;
  amountField?: string;
  sessionField?: string;
  startedAtField?: string;
  statusField?: string;
  pendingValue?: string;
  startingValue?: string;
  openValue?: string;
  paidValue?: string;
  events?: string;
  secretName?: string;
  live?: boolean;
};

export type CheckoutConfig = PaymentConfig & { successPath?: string; cancelPath?: string };
export type WebhookConfig = PaymentConfig & { webhookSecretName?: string };

export function paymentFields(c: PaymentConfig) {
  const currency = (c.currency ?? "usd").toLowerCase();
  if (!CURRENCY.test(currency)) throw new Error("currency is a 3-letter ISO code like usd");
  if (!c.orders || !c.price?.collection || !c.price.reference || !c.price.amount) {
    throw new Error("a payment recipe needs orders and price { collection, reference, amount }");
  }
  const f = {
    amount: c.amountField ?? "amount_cents",
    session: c.sessionField ?? "checkout_session_id",
    startedAt: c.startedAtField ?? "checkout_started_at",
    status: c.statusField ?? "status",
    pending: c.pendingValue ?? "pending",
    starting: c.startingValue ?? "checkout_starting",
    open: c.openValue ?? "checkout_open",
    paid: c.paidValue ?? "paid",
    events: c.events ?? "payment_events",
    quantity: c.quantity ?? null,
    currency,
  };
  if (new Set([f.pending, f.starting, f.open, f.paid]).size !== 4) throw new Error("the four payment states must be different");
  const fields = [f.amount, f.session, f.startedAt, f.status, c.price.reference, ...(f.quantity ? [f.quantity] : [])];
  if (new Set(fields).size !== fields.length) throw new Error("payment fields (amount, session, start time, status, item, quantity) must all be different");
  return f;
}

type Fields = ReturnType<typeof paymentFields>;
type Priced = { unit: number; qty: number; total: number; name: string; snapshot: Record<string, unknown> };

export function isTransitionConflict(e: unknown): boolean {
  const x = e as { reason?: unknown; code?: unknown; message?: unknown } | null;
  return !!x && (x.reason === "transition_conflict" || x.code === "transition_conflict" || x.message === "transition_conflict");
}

const SNAPSHOT_META = "zavi_snapshot";

function snapshotKeys(c: PaymentConfig, f: Fields): string[] {
  return f.quantity ? [c.price.reference, f.quantity] : [c.price.reference];
}

function snapshotMeta(snap: Record<string, unknown>, keys: string[]): string {
  return JSON.stringify(keys.map((k) => (snap[k] === undefined ? null : snap[k])));
}

function readSnapshot(raw: unknown, keys: string[]): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== keys.length) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const x = v[i];
    if (x !== null && typeof x !== "string" && typeof x !== "number") return null;
    out[keys[i]] = x;
  }
  return out;
}

export async function priceOrder(ctx: FunctionContext, c: PaymentConfig, f: Fields, order: FunctionRecord<Record<string, unknown>>): Promise<Priced> {
  const refId = order.data[c.price.reference];
  if (typeof refId !== "string" || !UUID.test(refId)) throw new FunctionError(400, "validation", "This order has no item to pay for.");
  const item = await ctx.data.collection<Record<string, unknown>>(c.price.collection).get(refId);
  if (!item) throw new FunctionError(404, "not_found", "The item on this order is no longer available.");
  const unit = item.data[c.price.amount];
  if (typeof unit !== "number" || !Number.isInteger(unit) || unit < 1) throw new FunctionError(409, "invalid_price", "This item has no price yet.");
  const raw = f.quantity ? order.data[f.quantity] : 1;
  const qty = raw === undefined || raw === null ? 1 : raw;
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 100) throw new FunctionError(400, "validation", "Quantity must be between 1 and 100.");
  const label = c.price.name ? item.data[c.price.name] : undefined;
  const snapshot: Record<string, unknown> = { [c.price.reference]: refId };
  if (f.quantity) snapshot[f.quantity] = raw === undefined ? null : raw;
  return { unit, qty, total: unit * qty, snapshot, name: typeof label === "string" && label.trim() ? label.slice(0, 250) : "Order" };
}

function safePath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || /[\s\\?#]/.test(p)) throw new Error(`checkout paths start with / and have no query (got ${p})`);
  return p;
}

const busy = () => new FunctionError(409, "conflict", "This order is being paid in another tab. Try again in a moment.");

function claimToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `claim_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function stripeCheckout(config: CheckoutConfig): DefinedFunction {
  const f = paymentFields(config);
  const success = safePath(config.successPath ?? "/checkout/success");
  const cancel = safePath(config.cancelPath ?? "/checkout/cancel");
  const keyOpts = { secretName: config.secretName, live: config.live };
  return defineFunction(async (input: { orderId?: unknown } | null, ctx) => {
    const orderId = input && typeof input.orderId === "string" ? input.orderId.trim().toLowerCase() : "";
    if (!UUID.test(orderId)) throw new FunctionError(400, "validation", "orderId is required.");
    const orders = ctx.data.collection<Record<string, unknown>>(config.orders);
    const order = await orders.get(orderId);
    if (!order) throw new FunctionError(404, "not_found", "That order was not found.");
    if (order.owner_id !== null && order.owner_id !== ctx.user?.id) {
      throw new FunctionError(403, "not_allowed", "Sign in as the person who placed this order to pay for it.");
    }
    if (order.data[f.status] === f.paid) throw new FunctionError(409, "already_paid", "This order is already paid.");
    const p = await priceOrder(ctx, config, f, order);
    const backToPending = async (held: unknown) => {
      try {
        await orders.transition(orderId, f.pending, { expect: { [f.session]: held } });
      } catch (e) {
        if (isTransitionConflict(e)) throw busy();
        throw e;
      }
    };
    let state = order.data[f.status];

    if (state === f.starting) {
      const started = Date.parse(String(order.data[f.startedAt] ?? ""));
      if (Number.isFinite(started) && ctx.now().getTime() - started < STALE_START_MS) throw busy();
      ctx.log.warn("reclaiming a checkout that never finished starting", { order_id: orderId });
      await backToPending(order.data[f.session]);
      state = f.pending;
    }

    if (state === f.open) {
      const prior = order.data[f.session];
      if (typeof prior !== "string" || !SESSION_ID.test(prior)) throw new FunctionError(409, "invalid_state", "This order's checkout is in an unknown state. Contact the site owner.");
      const old = await stripeGet<{ status?: unknown; payment_status?: unknown; url?: unknown; amount_total?: unknown; currency?: unknown; metadata?: Record<string, unknown> | null }>(
        ctx, `/v1/checkout/sessions/${prior}`, keyOpts,
      );
      if (old.status === "complete") {
        if (old.payment_status === "paid" || old.payment_status === "no_payment_required") {
          throw new FunctionError(409, "already_paid", "This order has been paid. It can take a moment to show.");
        }
        throw new FunctionError(409, "payment_processing", "The payment for this order is still processing. You'll see it here once it clears.");
      }
      const sameOrder = old.metadata?.[SNAPSHOT_META] === snapshotMeta(p.snapshot, snapshotKeys(config, f));
      if (old.status === "open" && sameOrder && old.amount_total === p.total && old.currency === f.currency && order.data[f.amount] === p.total && typeof old.url === "string") {
        return { url: old.url, sessionId: prior };
      }
      if (old.status === "open") await stripePost(ctx, `/v1/checkout/sessions/${prior}/expire`, {}, keyOpts);
      await backToPending(prior);
      state = f.pending;
    }
    if (state !== f.pending) throw new FunctionError(409, "invalid_state", "This order cannot be paid in its current state.");

    const claim = claimToken();
    try {
      await orders.transition(orderId, f.starting, {
        expect: p.snapshot,
        set: { [f.amount]: p.total, [f.session]: claim, [f.startedAt]: ctx.now().toISOString() },
      });
    } catch (e) {
      if (isTransitionConflict(e)) throw busy();
      throw e;
    }
    const release = async (why: string) => {
      try {
        await orders.transition(orderId, f.pending, { expect: { [f.session]: claim } });
      } catch (e) {
        ctx.log.error(`could not release the checkout claim after ${why}`, { order_id: orderId, error: String((e as Error)?.message ?? e) });
      }
    };

    const params = {
      mode: "payment",
      client_reference_id: orderId,
      metadata: { order_id: orderId, zavi_site: ctx.siteId, [SNAPSHOT_META]: snapshotMeta(p.snapshot, snapshotKeys(config, f)) },
      payment_intent_data: { metadata: { order_id: orderId, zavi_site: ctx.siteId } },
      customer_email: ctx.user?.email ?? undefined,
      line_items: [{ quantity: p.qty, price_data: { currency: f.currency, unit_amount: p.unit, product_data: { name: p.name } } }],
      success_url: `${ctx.origin}${success}?order=${orderId}`,
      cancel_url: `${ctx.origin}${cancel}?order=${orderId}`,
    };
    let session: { id?: unknown; url?: unknown };
    try {
      session = await stripePost<{ id?: unknown; url?: unknown }>(ctx, "/v1/checkout/sessions", params, { idempotencyKey: `zavi-checkout-${orderId}-${claim}`, ...keyOpts });
      if (typeof session.url !== "string" || typeof session.id !== "string" || !SESSION_ID.test(session.id)) {
        throw new FunctionError(502, "stripe_error", "Stripe did not return a checkout page.");
      }
    } catch (e) {
      await release("Stripe failed");
      throw e;
    }
    const sessionId = session.id as string;

    try {
      await orders.transition(orderId, f.open, { expect: { [f.session]: claim }, set: { [f.session]: sessionId } });
    } catch (e) {
      try {
        await stripePost(ctx, `/v1/checkout/sessions/${sessionId}/expire`, {}, keyOpts);
      } catch (x) {
        ctx.log.error("a checkout session could not be recorded or expired; check it in Stripe", { order_id: orderId, session_id: sessionId, error: String((x as Error)?.message ?? x) });
      }
      if (isTransitionConflict(e)) throw busy();
      await release("recording the session failed");
      throw e;
    }
    ctx.log.info("checkout session created", { order_id: orderId, session_id: sessionId, amount: p.total, currency: f.currency });
    return { url: session.url as string, sessionId };
  });
}

const PAID_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const FAILED_EVENTS = new Set(["checkout.session.async_payment_failed", "checkout.session.expired"]);

export function stripeWebhook(config: WebhookConfig): DefinedFunction {
  const f = paymentFields(config);
  return defineWebhook<StripeEvent>({
    verify: stripeSignature(config.webhookSecretName ?? DEFAULT_WEBHOOK_SECRET_NAME),
    handle: async (event, ctx) => handleStripePaid(event, ctx, config, f),
  });
}

export type PaidOutcome =
  | "ignored_type"
  | "wrong_mode"
  | "other_site"
  | "not_paid_yet"
  | "no_order"
  | "duplicate_event"
  | "already_paid"
  | "paid_twice"
  | "session_mismatch"
  | "amount_mismatch"
  | "order_changed"
  | "payment_failed"
  | "expired"
  | "marked_paid";

const FINAL = "done";

export async function handleStripePaid(event: StripeEvent, ctx: FunctionContext, c: WebhookConfig, f: Fields = paymentFields(c)): Promise<Response> {
  const done = (outcome: PaidOutcome, extra: Record<string, string | number> = {}) => {
    ctx.log.info(`stripe ${event.type}: ${outcome}`, { event_id: event.id, ...extra });
    return new Response(JSON.stringify({ received: true, outcome }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const failed = FAILED_EVENTS.has(event.type);
  if (!PAID_EVENTS.has(event.type) && !failed) return done("ignored_type");
  if (event.livemode !== (c.live === true)) {
    ctx.log.error(`a ${event.livemode ? "live" : "test"} Stripe event reached a site in ${c.live ? "live" : "test"} mode; ignored`, { event_id: event.id });
    return done("wrong_mode");
  }
  const s = event.data.object;
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  if (meta.zavi_site !== ctx.siteId) return done("other_site");
  if (!failed && s.payment_status !== "paid") return done("not_paid_yet");
  const ref = typeof s.client_reference_id === "string" ? s.client_reference_id.toLowerCase() : "";
  const metaOrder = typeof meta.order_id === "string" ? meta.order_id.toLowerCase() : "";
  if (!UUID.test(ref) || ref !== metaOrder || typeof s.id !== "string" || !SESSION_ID.test(s.id)) return done("no_order");
  const orderId = ref;
  const sessionId = s.id;

  const ledger = ctx.data.collection<Record<string, unknown>>(f.events);
  const key = `stripe-${event.id.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 128).padEnd(16, "0");
  const claim = await ledger.create({ event_id: event.id, type: event.type, order_id: orderId, state: "claimed" }, { idempotencyKey: key });
  if (claim.replayed) {
    const prior = await ledger.get(claim.id);
    if (prior && prior.data.state === FINAL) return done("duplicate_event", { order_id: orderId });
  }
  const finish = async (outcome: PaidOutcome, extra: Record<string, string | number> = {}) => {
    await ledger.update(claim.id, { state: FINAL, outcome });
    return done(outcome, extra);
  };

  const orders = ctx.data.collection<Record<string, unknown>>(c.orders);
  if (failed) {
    const reopened: PaidOutcome = event.type === "checkout.session.expired" ? "expired" : "payment_failed";
    try {
      await orders.transition(orderId, f.pending, { expect: { [f.session]: sessionId } });
      if (reopened === "payment_failed") ctx.log.warn("a delayed payment failed; the order is open for another try", { order_id: orderId, session_id: sessionId });
      return finish(reopened, { order_id: orderId });
    } catch (e) {
      if (!isTransitionConflict(e)) throw e;
      const now = await orders.get(orderId);
      if (now && now.data[f.status] === f.pending && now.data[f.session] === sessionId) return finish(reopened, { order_id: orderId });
      return finish("session_mismatch", { order_id: orderId });
    }
  }

  const paidAmount = typeof s.amount_total === "number" ? s.amount_total : -1;
  const currency = String(s.currency ?? "").toLowerCase();
  const keys = snapshotKeys(c, f);
  const snap = readSnapshot(meta[SNAPSHOT_META], keys);
  if (currency === f.currency && paidAmount > 0 && snap) {
    try {
      await orders.transition(orderId, f.paid, { expect: { ...snap, [f.session]: sessionId, [f.amount]: paidAmount } });
      return finish("marked_paid", { order_id: orderId, amount: paidAmount });
    } catch (e) {
      if (!isTransitionConflict(e)) throw e;
    }
  }

  const order = await orders.get(orderId);
  if (!order) return finish("no_order", { order_id: orderId });
  const current = order.data[f.session] === sessionId;
  if (order.data[f.status] === f.paid) {
    if (current) return finish("already_paid", { order_id: orderId });
    ctx.log.error("this order was paid twice: refund the second payment in Stripe", { event_id: event.id, order_id: orderId, session_id: sessionId });
    return finish("paid_twice", { order_id: orderId });
  }
  if (!current) {
    ctx.log.error("a payment arrived for a checkout this order no longer uses; not marked paid. Refund it in Stripe or check the order.", { event_id: event.id, order_id: orderId, session_id: sessionId });
    return finish("session_mismatch", { order_id: orderId });
  }
  const changed = !snap || keys.some((k) => {
    const cur = order.data[k];
    return JSON.stringify(cur === undefined ? null : cur) !== JSON.stringify(snap[k]);
  });
  if (changed && currency === f.currency && paidAmount === order.data[f.amount]) {
    ctx.log.error("the order's item or quantity changed after checkout; not marked paid. Refund it in Stripe or check the order.", { event_id: event.id, order_id: orderId, session_id: sessionId });
    return finish("order_changed", { order_id: orderId });
  }
  ctx.log.error("paid amount does not match the order; not marked paid. Refund it in Stripe or check the order.", {
    event_id: event.id,
    order_id: orderId,
    expected: typeof order.data[f.amount] === "number" ? (order.data[f.amount] as number) : -1,
    paid: paidAmount,
    currency,
  });
  return finish("amount_mismatch", { order_id: orderId });
}
