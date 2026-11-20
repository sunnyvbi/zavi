
import { vi } from "vitest";
import {
  PAID_TIERS,
  TIER_PRICE_USD,
  tierCreditsFromBlob,
  type PaidTier,
  type Tier,
} from "@/services/billing/tiers";
import { sixMonthUsd, type BillingTerm } from "@/services/billing/plans";

export const TERMS: readonly BillingTerm[] = ["monthly", "6mo"];

export const PRICE_IDS: Record<PaidTier, Record<BillingTerm, string>> = {
  starter: { monthly: "price_jny_starter_m", "6mo": "price_jny_starter_6mo" },
  growth: { monthly: "price_jny_growth_m", "6mo": "price_jny_growth_6mo" },
  pro: { monthly: "price_jny_pro_m", "6mo": "price_jny_pro_6mo" },
};

export const PRICE_ENV: Record<PaidTier, Record<BillingTerm, string>> = {
  starter: { monthly: "STRIPE_PRICE_STARTER_MONTHLY", "6mo": "STRIPE_PRICE_STARTER_6MO" },
  growth: { monthly: "STRIPE_PRICE_GROWTH_MONTHLY", "6mo": "STRIPE_PRICE_GROWTH_6MO" },
  pro: { monthly: "STRIPE_PRICE_PRO_MONTHLY", "6mo": "STRIPE_PRICE_PRO_6MO" },
};

const MANAGED_ENV = [
  "STRIPE_PLATFORM_SECRET_KEY",
  ...PAID_TIERS.flatMap((t) => TERMS.map((term) => PRICE_ENV[t][term])),
  "STRIPE_PRICE_CREDITS_UNIT",
  "STRIPE_CREDIT_UNIT_AMOUNT_CENTS",
  "STRIPE_PRICE_SOLO_MONTHLY",
  "STRIPE_PRICE_SOLO_ANNUAL",
  "STRIPE_PRICE_TEAM_MONTHLY",
  "STRIPE_PRICE_TEAM_ANNUAL",
  "STRIPE_PRICE_FULL_MONTHLY",
  "STRIPE_PRICE_FULL_ANNUAL",
  "STRIPE_BILLING_WEBHOOK_SECRET",
  "PRAXIS_PUBLIC_BASE",
];

export function installBillingEnv(): () => void {
  const saved = new Map<string, string | undefined>(MANAGED_ENV.map((k) => [k, process.env[k]]));
  for (const k of MANAGED_ENV) delete process.env[k];
  process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_journeys_platform";
  for (const t of PAID_TIERS) for (const term of TERMS) process.env[PRICE_ENV[t][term]] = PRICE_IDS[t][term];
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export type SubRow = {
  tenant_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_event_created: number;
  grandfathered: boolean;
  tier: PaidTier | null;
  tier_event_created: number;
  monthly_credits: number | null;
  monthly_usd: number | null;
  monthly_credits_event: number;
  credits_revoked_at: string | null;
};

export type ApplyArgs = {
  tenant_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  event_created: number;
};

type DbResult = { error: { message: string } | null };

const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function blankRow(tenantId: string): SubRow {
  return {
    tenant_id: tenantId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan: "free",
    status: "active",
    current_period_end: null,
    cancel_at_period_end: false,
    stripe_event_created: 0,
    grandfathered: false,
    tier: null,
    tier_event_created: 0,
    monthly_credits: null,
    monthly_usd: null,
    monthly_credits_event: 0,
    credits_revoked_at: null,
  };
}

function pick(row: SubRow, columns: string): Record<string, unknown> {
  if (columns.trim() === "*") return { ...row };
  const out: Record<string, unknown> = {};
  for (const c of columns.split(",").map((s) => s.trim())) out[c] = (row as Record<string, unknown>)[c];
  return out;
}

export class FakeBillingDb {
  readonly tenants = new Set<string>();
  readonly subs = new Map<string, SubRow>();
  readonly processed = new Map<string, string>();
  readonly topupGrants = new Map<string, { tenant_id: string; credits: number; event_id: string }>();
  readonly topupRevokes = new Map<string, { tenant_id: string; amount: number; event_id: string }>();
  readonly purchased = new Map<string, number>();
  config: Record<string, unknown> = {
    tier_credits: { starter: 8_000, growth: 48_000, pro: 96_000 },
    free_daily_credits: 1_000,
  };
  configReadError: string | null = null;
  subReadError: string | null = null;
  memberRole: string | null = "owner";
  readonly reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

  row(tenantId: string): SubRow | undefined {
    return this.subs.get(tenantId);
  }

  seedSub(tenantId: string, patch: Partial<SubRow>): void {
    this.tenants.add(tenantId);
    this.subs.set(tenantId, { ...blankRow(tenantId), ...patch });
  }

  readOne(table: string, columns: string, filters: Array<[string, unknown]>) {
    this.reads.push({ table, filters });
    if (table === "tenant_subscriptions") {
      if (this.subReadError) return { data: null, error: { message: this.subReadError } };
      const [col, v] = filters[0] ?? ["", undefined];
      const row =
        col === "tenant_id"
          ? this.subs.get(String(v))
          : col === "stripe_customer_id"
            ? [...this.subs.values()].find((r) => r.stripe_customer_id === v)
            : undefined;
      return { data: row ? pick(row, columns) : null, error: null };
    }
    if (table === "system_config") {
      if (this.configReadError) return { data: null, error: { message: this.configReadError } };
      return { data: { blob: JSON.parse(JSON.stringify(this.config)) as Record<string, unknown> }, error: null };
    }
    if (table === "tenant_users") {
      return { data: this.memberRole ? { role: this.memberRole } : null, error: null };
    }
    throw new Error(`fake supabase: unexpected read of '${table}'`);
  }

  tenantByCustomer(customerId: string): string | null {
    for (const r of this.subs.values()) if (r.stripe_customer_id === customerId) return r.tenant_id;
    return null;
  }

  applyState(a: ApplyArgs): DbResult {
    const row = this.subs.get(a.tenant_id);
    if (!row) {
      this.subs.set(a.tenant_id, {
        ...blankRow(a.tenant_id),
        stripe_customer_id: a.customer_id,
        stripe_subscription_id: a.subscription_id,
        plan: a.plan,
        status: a.status,
        current_period_end: a.current_period_end,
        cancel_at_period_end: a.cancel_at_period_end ?? false,
        stripe_event_created: a.event_created,
      });
    } else if (!row.grandfathered && a.event_created > row.stripe_event_created) {
      row.stripe_customer_id = a.customer_id ?? row.stripe_customer_id;
      row.stripe_subscription_id = a.subscription_id;
      row.plan = a.plan;
      row.status = a.status;
      row.current_period_end = a.current_period_end;
      row.cancel_at_period_end = a.cancel_at_period_end;
      row.stripe_event_created = a.event_created;
    }
    return { error: null };
  }

  setTier(tenantId: string, tier: PaidTier | null | "keep", eventCreated: number): DbResult {
    const row = this.subs.get(tenantId);
    if (!row) return { error: null };
    if (row.stripe_event_created !== eventCreated) return { error: null };
    if (!(row.tier_event_created < eventCreated)) return { error: null };
    if (row.grandfathered) return { error: null };
    if (tier !== null && tier !== "keep" && row.credits_revoked_at !== null) return { error: null };
    row.tier_event_created = eventCreated;
    if (tier !== "keep") row.tier = tier;
    return { error: null };
  }

  readRevocation(tenantId: string): { revoked: boolean; subscriptionId: string | null } {
    const row = this.subs.get(tenantId);
    return { revoked: !!row?.credits_revoked_at, subscriptionId: row?.stripe_subscription_id ?? null };
  }

  clearRevocation(tenantId: string): DbResult {
    const row = this.subs.get(tenantId);
    if (row && row.credits_revoked_at !== null) {
      row.credits_revoked_at = null;
      row.monthly_credits_event = Math.max(row.monthly_credits_event, Math.floor(Date.now() / 1000));
    }
    return { error: null };
  }

  clearTierForSubscription(tenantId: string, subscriptionId: string): DbResult {
    const row = this.subs.get(tenantId);
    if (row && row.stripe_subscription_id === subscriptionId && !row.grandfathered) row.tier = null;
    return { error: null };
  }

  setMonthlyCredits(tenantId: string, credits: number | null, usd: number | null, eventCreated: number): DbResult {
    const row = this.subs.get(tenantId);
    if (row && eventCreated > row.monthly_credits_event && row.credits_revoked_at === null) {
      row.monthly_credits = credits;
      row.monthly_usd = credits === null ? null : usd;
      row.monthly_credits_event = eventCreated;
    }
    return { error: null };
  }

  revokeCredits(tenantId: string, eventCreated: number, subscriptionId: string): DbResult & { applied: boolean } {
    const row = this.subs.get(tenantId);
    if (
      row &&
      !row.grandfathered &&
      subscriptionId &&
      row.stripe_subscription_id === subscriptionId &&
      eventCreated >= row.monthly_credits_event
    ) {
      row.monthly_credits = 0;
      row.monthly_usd = null;
      row.credits_revoked_at = new Date(eventCreated * 1000).toISOString();
      row.monthly_credits_event = eventCreated;
      return { error: null, applied: true };
    }
    return { error: null, applied: false };
  }

  applyCreditTopup(tenantId: string, credits: number, pi: string, eventId: string): DbResult {
    if (!(credits > 0)) return { error: { message: "apply_credit_topup: positive credits required" } };
    if (this.topupRevokes.has(pi)) return { error: null };
    if (this.topupGrants.has(pi)) return { error: null };
    this.topupGrants.set(pi, { tenant_id: tenantId, credits, event_id: eventId });
    this.purchased.set(tenantId, (this.purchased.get(tenantId) ?? 0) + credits);
    return { error: null };
  }

  revokeCreditTopup(pi: string, eventId: string, tenantHint: string | null): DbResult & { outcome: string } {
    const grant = this.topupGrants.get(pi);
    if (grant) {
      if (this.topupRevokes.has(pi)) return { error: null, outcome: "noop" };
      this.purchased.set(grant.tenant_id, (this.purchased.get(grant.tenant_id) ?? 0) - grant.credits);
      this.topupRevokes.set(pi, { tenant_id: grant.tenant_id, amount: grant.credits, event_id: eventId });
      return { error: null, outcome: "revoked" };
    }
    if (tenantHint === null) return { error: null, outcome: "not_a_topup" };
    if (this.topupRevokes.has(pi)) return { error: null, outcome: "noop" };
    this.topupRevokes.set(pi, { tenant_id: tenantHint, amount: 0, event_id: eventId });
    return { error: null, outcome: "tombstoned" };
  }

  effectiveTier(tenantId: string): Tier {
    const s = this.subs.get(tenantId);
    return s && LIVE_STATUSES.has(s.status) && s.tier ? s.tier : "free";
  }

  monthlyAllowance(tenantId: string): number {
    const daily = Number(this.config.free_daily_credits ?? 1_000);
    const s = this.subs.get(tenantId);
    if (!s) return daily;
    if (s.grandfathered) return 250_000;
    if (s.credits_revoked_at !== null) return s.monthly_credits ?? 0;
    if (s.status === "canceled") return daily;
    if (s.status === "incomplete") return daily;
    if (s.tier && LIVE_STATUSES.has(s.status)) return tierCreditsFromBlob(this.config)[s.tier];
    if (s.monthly_credits !== null) return s.monthly_credits;
    if (s.plan === "solo") return 20_000;
    if (s.plan === "team") return 80_000;
    if (s.plan === "full") return 300_000;
    if (s.plan === "enterprise") return 20_000_000;
    return daily;
  }
}

export function fakeServiceClient(db: FakeBillingDb) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let columns = "*";
      const chain = {
        select(cols: string) {
          columns = cols;
          return chain;
        },
        eq(col: string, v: unknown) {
          filters.push([col, v]);
          return chain;
        },
        async maybeSingle() {
          return db.readOne(table, columns, filters);
        },
      };
      return chain;
    },
    rpc(name: string): never {
      throw new Error(`fake supabase: rpc '${name}' must be injected as a webhook dep`);
    },
  };
}

export type SessionParams = {
  mode: "subscription" | "payment";
  line_items: Array<{
    price?: string;
    quantity: number;
    price_data?: { currency: string; unit_amount: number; product_data: { name: string } };
  }>;
  customer?: string;
  client_reference_id?: string;
  metadata?: Record<string, string>;
  subscription_data?: { metadata?: Record<string, string> };
  payment_intent_data?: { metadata?: Record<string, string> };
  payment_method_types?: string[];
  allow_promotion_codes?: boolean;
  success_url?: string;
  cancel_url?: string;
};
type RequestOpts = { idempotencyKey?: string } | undefined;

export type PriceLike = {
  id: string;
  object: "price";
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: "recurring";
  recurring: { interval: string; interval_count: number } | null;
};

export type ChargeLike = {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  currency: string;
  customer: string | null;
  payment_intent: string | null;
  invoice: string | null;
  paid: boolean;
};

class StripeApiError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function notFound(kind: string, id: string): never {
  throw new StripeApiError(`No such ${kind}: '${id}'`, "StripeInvalidRequestError", 404);
}

export class FakeStripe {
  readonly prices = new Map<string, PriceLike>();
  readonly charges = new Map<string, ChargeLike>();
  readonly paymentIntents = new Map<string, { id: string; object: "payment_intent"; metadata: Record<string, string>; amount: number; customer: string | null }>();
  readonly invoices = new Map<string, { id: string; object: "invoice"; customer: string; subscription: string | null; status: string; amount_paid: number; charge: string | null }>();
  private readonly sessions = new Map<string, { params: SessionParams; opts: RequestOpts; url: string }>();
  private readonly idem = new Map<string, { fingerprint: string; result: { id: string; url: string } }>();
  private n = 0;

  constructor() {
    for (const t of PAID_TIERS) {
      for (const term of TERMS) {
        const id = PRICE_IDS[t][term];
        this.prices.set(id, {
          id,
          object: "price",
          active: true,
          currency: "usd",
          unit_amount: (term === "6mo" ? sixMonthUsd(t) : TIER_PRICE_USD[t]) * 100,
          type: "recurring",
          recurring: { interval: "month", interval_count: term === "6mo" ? 6 : 1 },
        });
      }
    }
  }

  readonly api = {
    checkout: {
      sessions: {
        create: vi.fn(async (params: SessionParams, opts?: RequestOpts) => this.createSession(params, opts)),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async (_params: Record<string, unknown>) => {
          const id = `bps_jny${++this.n}`;
          return { id, url: `https://billing.stripe.test/p/session/${id}` };
        }),
      },
    },
    prices: {
      retrieve: vi.fn(async (id: string) => {
        const p = this.prices.get(id);
        return p ? { ...p, recurring: p.recurring ? { ...p.recurring } : null } : notFound("price", id);
      }),
    },
    charges: {
      retrieve: vi.fn(async (id: string) => {
        const c = this.charges.get(id);
        return c ? { ...c } : notFound("charge", id);
      }),
    },
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => {
        const p = this.paymentIntents.get(id);
        return p ? { ...p, metadata: { ...p.metadata } } : notFound("payment_intent", id);
      }),
    },
    invoices: {
      retrieve: vi.fn(async (id: string) => {
        const i = this.invoices.get(id);
        return i ? { ...i } : notFound("invoice", id);
      }),
    },
  };

  private createSession(params: SessionParams, opts: RequestOpts): { id: string; url: string } {
    const key = opts?.idempotencyKey;
    const fingerprint = JSON.stringify(params);
    if (key) {
      const hit = this.idem.get(key);
      if (hit) {
        if (hit.fingerprint !== fingerprint) {
          throw new StripeApiError(
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
            "StripeIdempotencyError",
            400,
          );
        }
        return hit.result;
      }
    }
    const id = `cs_test_jny${++this.n}`;
    const url = `https://checkout.stripe.test/c/pay/${id}`;
    this.sessions.set(id, { params: JSON.parse(fingerprint) as SessionParams, opts, url });
    const result = { id, url };
    if (key) this.idem.set(key, { fingerprint, result });
    return result;
  }

  session(id: string): { id: string; params: SessionParams; opts: RequestOpts; url: string } {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`fake stripe: no session ${id}`);
    return { id, ...s };
  }

  lastSession(): { id: string; params: SessionParams; opts: RequestOpts; url: string } {
    const ids = [...this.sessions.keys()];
    if (ids.length === 0) throw new Error("fake stripe: no Checkout session was created");
    return this.session(ids[ids.length - 1]);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  setPrice(id: string, patch: Partial<PriceLike>): void {
    const p = this.prices.get(id);
    if (!p) throw new Error(`fake stripe: no price ${id}`);
    this.prices.set(id, { ...p, ...patch });
  }

  nextId(prefix: string): string {
    return `${prefix}_jny${++this.n}`;
  }
}

export type StripeEvent = {
  id: string;
  object: "event";
  api_version: string;
  created: number;
  livemode: false;
  pending_webhooks: number;
  request: { id: null; idempotency_key: null };
  type: string;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
};

export type SimSub = {
  id: string;
  customer: string;
  priceId: string;
  quantity: number;
  status: string;
  metadata: Record<string, string>;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  apiShape: "acacia" | "basil";
  invoices: string[];
  charges: string[];
};

const DAY = 86_400;
const MONTH = 30 * DAY;

export class StripeSim {
  clock = 1_790_000_000;
  readonly subs = new Map<string, SimSub>();

  constructor(private readonly stripe: FakeStripe) {}

  tick(seconds = 7): number {
    this.clock += seconds;
    return this.clock;
  }

  event(type: string, object: Record<string, unknown>, created: number = this.tick(), previous?: Record<string, unknown>): StripeEvent {
    return {
      id: this.stripe.nextId("evt"),
      object: "event",
      api_version: "2025-02-24.acacia",
      created,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object: JSON.parse(JSON.stringify(object)) as Record<string, unknown>, ...(previous ? { previous_attributes: previous } : {}) },
    };
  }

  sub(id: string): SimSub {
    const s = this.subs.get(id);
    if (!s) throw new Error(`sim: no subscription ${id}`);
    return s;
  }

  private price(id: string): PriceLike {
    const p = this.stripe.prices.get(id);
    if (!p) throw new Error(`sim: no price ${id}`);
    return p;
  }

  subscriptionObject(sub: SimSub): Record<string, unknown> {
    const price = this.price(sub.priceId);
    const item = {
      id: `si_${sub.id}`,
      object: "subscription_item",
      quantity: sub.quantity,
      price: { ...price },
      current_period_start: sub.periodStart,
      current_period_end: sub.periodEnd,
    };
    return {
      id: sub.id,
      object: "subscription",
      customer: sub.customer,
      status: sub.status,
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      metadata: { ...sub.metadata },
      items: { object: "list", data: [item] },
      latest_invoice: sub.invoices[sub.invoices.length - 1] ?? null,
      ...(sub.apiShape === "acacia" ? { current_period_start: sub.periodStart, current_period_end: sub.periodEnd } : {}),
    };
  }

  private issueInvoice(sub: SimSub, paid: boolean): { invoiceId: string; chargeId: string; piId: string } {
    const price = this.price(sub.priceId);
    const amount = (price.unit_amount ?? 0) * sub.quantity;
    const invoiceId = this.stripe.nextId("in");
    const chargeId = this.stripe.nextId("ch");
    const piId = this.stripe.nextId("pi");
    this.stripe.paymentIntents.set(piId, { id: piId, object: "payment_intent", metadata: {}, amount, customer: sub.customer });
    this.stripe.charges.set(chargeId, {
      id: chargeId, object: "charge", amount, amount_refunded: 0, refunded: false, currency: "usd",
      customer: sub.customer, payment_intent: piId, invoice: invoiceId, paid,
    });
    this.stripe.invoices.set(invoiceId, {
      id: invoiceId, object: "invoice", customer: sub.customer, subscription: sub.id,
      status: paid ? "paid" : "open", amount_paid: paid ? amount : 0, charge: chargeId,
    });
    sub.invoices.push(invoiceId);
    sub.charges.push(chargeId);
    return { invoiceId, chargeId, piId };
  }

  completeSubscriptionCheckout(
    sessionId: string,
    opts: { status?: string; apiShape?: "acacia" | "basil"; created?: number } = {},
  ) {
    const s = this.stripe.session(sessionId);
    if (s.params.mode !== "subscription") throw new Error("sim: not a subscription session");
    const line = s.params.line_items[0];
    const priceId = line.price as string;
    const price = this.price(priceId);
    const created = opts.created ?? this.tick();
    const customer = s.params.customer ?? this.stripe.nextId("cus");
    const sub: SimSub = {
      id: this.stripe.nextId("sub"),
      customer,
      priceId,
      quantity: line.quantity,
      status: opts.status ?? "active",
      metadata: { ...(s.params.subscription_data?.metadata ?? {}) },
      periodStart: created,
      periodEnd: created + MONTH * (price.recurring?.interval_count ?? 1),
      cancelAtPeriodEnd: false,
      apiShape: opts.apiShape ?? "acacia",
      invoices: [],
      charges: [],
    };
    this.subs.set(sub.id, sub);
    const inv = this.issueInvoice(sub, sub.status === "active");
    const amount = (price.unit_amount ?? 0) * line.quantity;
    return {
      sub,
      customer,
      priceId,
      invoiceId: inv.invoiceId,
      chargeId: inv.chargeId,
      events: {
        subscriptionCreated: this.event("customer.subscription.created", this.subscriptionObject(sub), created),
        sessionCompleted: this.event(
          "checkout.session.completed",
          {
            id: sessionId,
            object: "checkout.session",
            mode: "subscription",
            status: "complete",
            payment_status: sub.status === "active" ? "paid" : "unpaid",
            customer,
            subscription: sub.id,
            client_reference_id: s.params.client_reference_id ?? null,
            metadata: { ...(s.params.metadata ?? {}) },
            amount_subtotal: amount,
            amount_total: amount,
            currency: "usd",
            payment_intent: null,
            invoice: inv.invoiceId,
          },
          created,
        ),
      },
    };
  }

  updateSubscription(
    subId: string,
    patch: { priceId?: string; status?: string; cancelAtPeriodEnd?: boolean },
    created: number = this.tick(),
  ): StripeEvent {
    const sub = this.sub(subId);
    const previous: Record<string, unknown> = {};
    if (patch.priceId && patch.priceId !== sub.priceId) {
      previous.items = { data: [{ price: { id: sub.priceId } }] };
      const oldCount = this.price(sub.priceId).recurring?.interval_count ?? 1;
      const newCount = this.price(patch.priceId).recurring?.interval_count ?? 1;
      sub.priceId = patch.priceId;
      if (newCount !== oldCount) {
        sub.periodStart = created;
        sub.periodEnd = created + MONTH * newCount;
        this.issueInvoice(sub, true);
      }
    }
    if (patch.status !== undefined && patch.status !== sub.status) {
      previous.status = sub.status;
      sub.status = patch.status;
    }
    if (patch.cancelAtPeriodEnd !== undefined) {
      previous.cancel_at_period_end = sub.cancelAtPeriodEnd;
      sub.cancelAtPeriodEnd = patch.cancelAtPeriodEnd;
    }
    return this.event("customer.subscription.updated", this.subscriptionObject(sub), created, previous);
  }

  renew(subId: string, created: number = this.tick()): StripeEvent {
    const sub = this.sub(subId);
    const len = sub.periodEnd - sub.periodStart;
    const previous = { current_period_start: sub.periodStart, current_period_end: sub.periodEnd };
    sub.periodStart = sub.periodEnd;
    sub.periodEnd = sub.periodStart + len;
    this.issueInvoice(sub, true);
    return this.event("customer.subscription.updated", this.subscriptionObject(sub), created, previous);
  }

  deleteSubscription(subId: string, created: number = this.tick()): StripeEvent {
    const sub = this.sub(subId);
    sub.status = "canceled";
    return this.event("customer.subscription.deleted", this.subscriptionObject(sub), created);
  }

  invoicePaymentFailed(subId: string, created: number = this.tick()): StripeEvent {
    const sub = this.sub(subId);
    const { invoiceId } = this.issueInvoice(sub, false);
    const inv = this.stripe.invoices.get(invoiceId);
    return this.event(
      "invoice.payment_failed",
      { ...inv, attempt_count: 1, billing_reason: "subscription_cycle", next_payment_attempt: created + 3 * DAY },
      created,
    );
  }

  completeTopupCheckout(
    sessionId: string,
    opts: { amountTotal?: number; paymentStatus?: string; currency?: string } = {},
  ) {
    const s = this.stripe.session(sessionId);
    if (s.params.mode !== "payment") throw new Error("sim: not a payment session");
    const line = s.params.line_items[0];
    const amount = (line.price_data?.unit_amount ?? 0) * line.quantity;
    const piId = this.stripe.nextId("pi");
    const chargeId = this.stripe.nextId("ch");
    const customer = s.params.customer ?? null;
    this.stripe.paymentIntents.set(piId, {
      id: piId, object: "payment_intent", amount, customer,
      metadata: { ...(s.params.payment_intent_data?.metadata ?? {}) },
    });
    this.stripe.charges.set(chargeId, {
      id: chargeId, object: "charge", amount, amount_refunded: 0, refunded: false, currency: "usd",
      customer, payment_intent: piId, invoice: null, paid: true,
    });
    const event = this.event("checkout.session.completed", {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: opts.paymentStatus ?? "paid",
      customer,
      client_reference_id: s.params.client_reference_id ?? null,
      metadata: { ...(s.params.metadata ?? {}) },
      amount_subtotal: amount,
      amount_total: opts.amountTotal ?? amount,
      currency: opts.currency ?? "usd",
      payment_intent: piId,
      subscription: null,
    });
    return { piId, chargeId, event };
  }

  oneOffCharge(customer: string, amount = 5_000): string {
    const piId = this.stripe.nextId("pi");
    const chargeId = this.stripe.nextId("ch");
    this.stripe.paymentIntents.set(piId, { id: piId, object: "payment_intent", metadata: {}, amount, customer });
    this.stripe.charges.set(chargeId, {
      id: chargeId, object: "charge", amount, amount_refunded: 0, refunded: false, currency: "usd",
      customer, payment_intent: piId, invoice: null, paid: true,
    });
    return chargeId;
  }

  refund(chargeId: string, amount?: number, created: number = this.tick()): StripeEvent {
    const ch = this.stripe.charges.get(chargeId);
    if (!ch) throw new Error(`sim: no charge ${chargeId}`);
    ch.amount_refunded += amount ?? ch.amount - ch.amount_refunded;
    ch.refunded = ch.amount_refunded >= ch.amount;
    return this.event("charge.refunded", { ...ch }, created);
  }

  dispute(chargeId: string, type: "charge.dispute.created" | "charge.dispute.funds_withdrawn", created: number = this.tick()): StripeEvent {
    const ch = this.stripe.charges.get(chargeId);
    if (!ch) throw new Error(`sim: no charge ${chargeId}`);
    return this.event(
      type,
      {
        id: `dp_${chargeId}`,
        object: "dispute",
        charge: chargeId,
        payment_intent: ch.payment_intent,
        amount: ch.amount,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
      },
      created,
    );
  }
}

export type LogEntry = {
  level: string;
  source?: string;
  code: string;
  message?: string;
  tenant_id?: string | null;
  meta?: Record<string, unknown>;
};

type AuthReq = { headers?: Record<string, string | undefined> };
type AuthRes = { status(c: number): { json(b: unknown): unknown } };

export const world = {
  db: new FakeBillingDb(),
  stripe: new FakeStripe(),
  sim: undefined as unknown as StripeSim,
  logs: [] as LogEntry[],
  sessions: new Map<string, { user_id: string; tenant_id: string }>(),

  signIn(tenantId: string): string {
    this.db.tenants.add(tenantId);
    const token = `tok_${tenantId.slice(0, 8)}_${this.sessions.size + 1}`;
    this.sessions.set(token, { user_id: `user_${tenantId.slice(0, 8)}`, tenant_id: tenantId });
    return token;
  },

  async requireAuth(req: AuthReq, res: AuthRes) {
    const h = req.headers?.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const s = world.sessions.get(token);
    if (!s) {
      res.status(401).json({ error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } });
      return null;
    }
    return { user_id: s.user_id, tenant_id: s.tenant_id, access_token: token };
  },
};

export function resetWorld(): void {
  world.db = new FakeBillingDb();
  world.stripe = new FakeStripe();
  world.sim = new StripeSim(world.stripe);
  world.logs = [];
  world.sessions = new Map();
}
resetWorld();
