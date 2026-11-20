
import Stripe from "stripe";
import { expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { makeStripeBillingWebhook } from "@/routes/webhooks/stripe-billing";
import { billingCheckout } from "@/routes/billing/checkout";
import type { PaidTier } from "@/services/billing/tiers";
import type { BillingTerm } from "@/services/billing/plans";
import { world, type ApplyArgs, type StripeEvent } from "./_world";

export const WEBHOOK_SECRET = "whsec_test_journeys";

export function knownGap(name: string, fn: () => Promise<void>): void {
  if (process.env.BILLING_JOURNEYS_SHOW_GAPS === "1") it(name, fn);
  else it.fails(name, fn);
}

export const T1 = "11111111-aaaa-4aaa-8aaa-000000000001";
export const T2 = "22222222-bbbb-4bbb-8bbb-000000000002";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type MockRes = {
  statusCode: number;
  body: Json;
  headers: Record<string, string>;
  status(c: number): MockRes;
  json(b: unknown): MockRes;
  set(k: string, v: string): MockRes;
};

export function mockRes(): MockRes {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
  };
}

type Handler = (req: Request, res: Response) => Promise<void>;

export async function callRoute(handler: Handler, opts: { token: string | null; body?: unknown }): Promise<MockRes> {
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const req = {
    body: opts.body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  const res = mockRes();
  await handler(req as unknown as Request, res as unknown as Response);
  return res;
}

const signer = new Stripe("sk_test_journeys_signer_only");

export function signedRequest(
  event: StripeEvent | Record<string, unknown>,
  opts: { secret?: string; tamper?: (raw: string) => string; timestamp?: number; omitSignature?: boolean } = {},
) {
  const payload = JSON.stringify(event);
  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? WEBHOOK_SECRET,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });
  const body = Buffer.from(opts.tamper ? opts.tamper(payload) : payload, "utf8");
  const headers: Record<string, string> = opts.omitSignature ? {} : { "stripe-signature": signature };
  return {
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

export async function deliver(
  handler: Handler,
  event: StripeEvent,
  opts: Parameters<typeof signedRequest>[1] = {},
): Promise<MockRes> {
  const res = mockRes();
  await handler(signedRequest(event, opts) as unknown as Request, res as unknown as Response);
  return res;
}

type WebhookDeps = NonNullable<Parameters<typeof makeStripeBillingWebhook>[0]>;

export function journeyWebhook(over: Partial<WebhookDeps> = {}) {
  const db = () => world.db;
  const deps = {
    webhookSecret: () => WEBHOOK_SECRET,
    eventProcessed: vi.fn(async (id: string) => db().processed.has(id)),
    markProcessed: vi.fn(async (id: string, type: string) => {
      db().processed.set(id, type);
    }),
    resolveTenantByCustomer: vi.fn(async (customerId: string) => db().tenantByCustomer(customerId)),
    tenantExists: vi.fn(async (tenantId: string) => db().tenants.has(tenantId)),
    applyState: vi.fn(async (a: ApplyArgs) => db().applyState(a)),
    setTier: vi.fn(async (t: string, tier: PaidTier | null | "keep", ec: number) => db().setTier(t, tier, ec)),
    setMonthlyCredits: vi.fn(async (t: string, c: number | null, usd: number | null, ec: number) =>
      db().setMonthlyCredits(t, c, usd, ec),
    ),
    clearTierForSubscription: vi.fn(async (t: string, sub: string) => db().clearTierForSubscription(t, sub)),
    readRevocation: vi.fn(async (t: string) => db().readRevocation(t)),
    clearRevocation: vi.fn(async (t: string) => db().clearRevocation(t)),
    requestPreviewRerun: vi.fn(async () => undefined),
    revokeCredits: vi.fn(async (t: string, ec: number, sub: string) => db().revokeCredits(t, ec, sub)),
    applyCreditTopup: vi.fn(async (t: string, credits: number, pi: string, evt: string) =>
      db().applyCreditTopup(t, credits, pi, evt),
    ),
    revokeCreditTopup: vi.fn(async (pi: string, evt: string, hint: string | null) =>
      db().revokeCreditTopup(pi, evt, hint),
    ),
    readIncludedUsed: vi.fn(async () => null),
    notifyPaymentFailed: vi.fn(async () => "sent"),
    affiliateEvent: vi.fn(async () => "ignored"),
  };
  const handler = makeStripeBillingWebhook({ ...deps, ...over });
  return { handler, deps };
}

export function expectNoWrites(deps: ReturnType<typeof journeyWebhook>["deps"]): void {
  for (const k of [
    "applyState", "setTier", "setMonthlyCredits", "clearTierForSubscription", "revokeCredits",
    "applyCreditTopup", "revokeCreditTopup", "markProcessed",
  ] as const) {
    expect(deps[k], `${k} should not have been called`).not.toHaveBeenCalled();
  }
}

export async function subscribe(
  tenantId: string,
  tier: PaidTier,
  term: BillingTerm = "monthly",
  opts: { apiShape?: "acacia" | "basil" } = {},
) {
  const token = world.signIn(tenantId);
  const res = await callRoute(billingCheckout, { token, body: { tier, term } });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  const session = world.stripe.lastSession();
  const paid = world.sim.completeSubscriptionCheckout(session.id, { apiShape: opts.apiShape });
  const { handler } = journeyWebhook();
  for (const ev of [paid.events.sessionCompleted, paid.events.subscriptionCreated]) {
    const r = await deliver(handler, ev);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
  }
  return { token, session, ...paid };
}
