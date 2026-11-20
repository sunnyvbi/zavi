import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { fulfilCreatorCheckout, type FulfilDeps } from "../checkout-fulfil";
import { resumeOrderCheckout, type ResumeDeps } from "../checkout-resume";
import { applyCreatorStripeEvent, type CreatorWebhookDeps } from "../webhook-events";
import type { CreatorOrderCheckoutRow } from "../booking-db";
import type { CreatorHoldState } from "../orders-money";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";

type PiStatus = "requires_payment_method" | "requires_capture" | "canceled" | "succeeded";

function world(initial: { stripe_payment_intent_id: string | null; ledger?: Record<string, string> }) {
  const row: CreatorOrderCheckoutRow & { status: string } = {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "checkout_pending",
    booked_by_user_id: "u1",
    business_total_cents: 16_500,
    currency: "usd",
    livemode: false,
    stripe_checkout_session_id: "cs_A",
    stripe_payment_intent_id: initial.stripe_payment_intent_id,
    hold_expires_at: null,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
  };
  const pis: Record<string, PiStatus> = { pi_A: "requires_payment_method" };
  const sessions: Record<string, { status: string; payment_intent: string | null }> = {
    cs_A: { status: "open", payment_intent: "pi_A" },
  };
  const ledger = new Map<string, string>(Object.entries(initial.ledger ?? {}));
  const transitions: string[] = [];

  const readHold = async (id: string): Promise<CreatorHoldState> => {
    const status = pis[id];
    return {
      payment_intent_id: id,
      status,
      amount_cents: 16_500,
      charge_id: status === "requires_capture" ? `ch_${id}` : null,
      hold_expires_at: status === "requires_capture" ? "2026-10-23T00:00:00.000Z" : null,
      held: status === "requires_capture",
      captured: status === "succeeded",
      released: status === "canceled",
      refunded_cents: 0,
      authorized_at: null,
    } as CreatorHoldState;
  };

  const fulfilDeps: FulfilDeps = {
    stripe: () =>
      ({
        checkout: { sessions: { retrieve: async (id: string) => ({ id, ...sessions[id] }) } },
      }) as never,
    loadOrder: async (tid, oid) => (tid === TENANT && oid === ORDER ? { ...row } : null),
    attachPaymentIntent: async (a) => {
      row.stripe_payment_intent_id = a.payment_intent_id;
      row.hold_expires_at = a.hold_expires_at;
    },
    replacePaymentIntent: async (a) => {
      if (row.status !== "checkout_pending" || row.stripe_payment_intent_id !== a.from_payment_intent_id) return false;
      row.stripe_payment_intent_id = a.to_payment_intent_id;
      return true;
    },
    readHold,
    recordHold: (async (a: { payment_intent_id: string }) => {
      const key = `cr-hold-${ORDER}`;
      if (!ledger.has(key)) ledger.set(key, a.payment_intent_id);
      return readHold(a.payment_intent_id);
    }) as never,
    transition: (async (a: { trigger: string }) => {
      transitions.push(a.trigger);
      if (row.status !== "checkout_pending") return { ok: false, code: "illegal_transition", message: "moved" };
      row.status = "awaiting_acceptance";
      return { ok: true, from: "checkout_pending", to: "awaiting_acceptance" };
    }) as never,
    briefHired: async () => undefined,
    claimBrief: async () => "claimed" as const,
    releaseBrief: async () => undefined,
    briefOwner: async () => null,
    declineLate: async () => undefined,
    log: (async () => {}) as never,
  };

  const ref = () => ({
    id: row.id,
    tenant_id: row.tenant_id,
    human_member_id: CREATOR,
    livemode: false,
    source: row.source,
    status: row.status,
    closed_reason: null,
    payout_status: "not_due",
    payout_ready_at: null,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    stripe_transfer_id: null,
  });

  const webhookDeps = {
    resolveOrderById: async (id: string) => (id === ORDER ? ref() : null),
    resolveOrderByPaymentIntent: async (pi: string) => (row.stripe_payment_intent_id === pi ? ref() : null),
    resolveOrderByTransfer: async () => null,
    attachPaymentIntent: async (a: { payment_intent_id: string; hold_expires_at: string | null }) => {
      if (row.stripe_payment_intent_id !== null) return false;
      row.stripe_payment_intent_id = a.payment_intent_id;
      return true;
    },
    fulfil: (args: { tenant_id: string; order_id: string }) => fulfilCreatorCheckout(args, fulfilDeps),
    cancelHold: async () => {
      if (row.status === "checkout_pending" && !row.stripe_payment_intent_id) {
        return { ok: true, payment_intent_id: null, already_released: true };
      }
      const pi = row.stripe_payment_intent_id!;
      const key = `cr-cancel-${ORDER}`;
      if (!ledger.has(key)) ledger.set(key, pi);
      return { ok: true, payment_intent_id: pi, already_released: pis[pi] === "canceled" };
    },
    releaseOrphanHold: async () => "not_held",
    log: async () => {},
  } as unknown as CreatorWebhookDeps;

  const resumeDeps: ResumeDeps = {
    loadJob: (async () => ({ ...row, brief_id: null, application_id: null })) as never,
    loadCreator: (async () => ({ country_code: "US" })) as never,
    resume: (async () => ({
      checkout_session_id: "cs_B",
      url: "https://checkout.test/cs_B",
      amount_cents: 16_500,
      reused_session: false,
    })) as never,
    attach: (async (a: { checkout_session_id: string }) => {
      row.stripe_checkout_session_id = a.checkout_session_id;
    }) as never,
    offerExpired: async () => false,
  };

  const piEvent = (type: string, id: string, extra: Record<string, unknown> = {}) =>
    ({
      id: `evt_${type}_${id}`,
      type,
      livemode: false,
      data: { object: { id, amount: 16_500, metadata: { zavi_creator_order_id: ORDER }, ...extra } },
    }) as unknown as Stripe.Event;

  return { row, pis, sessions, ledger, transitions, fulfilDeps, webhookDeps, resumeDeps, piEvent };
}

describe("declined card, resumed checkout, first session expires, business pays the second", () => {
  async function play(w: ReturnType<typeof world>) {
    const resumed = await resumeOrderCheckout({ tenant_id: TENANT, order_id: ORDER }, w.resumeDeps);
    expect(resumed.checkout_url).toBe("https://checkout.test/cs_B");
    expect(w.row.stripe_checkout_session_id).toBe("cs_B");
    w.sessions.cs_B = { status: "open", payment_intent: null };

    w.pis.pi_A = "canceled";
    w.sessions.cs_A = { status: "expired", payment_intent: "pi_A" };
    await applyCreatorStripeEvent(
      w.piEvent("payment_intent.canceled", "pi_A", { cancellation_reason: "abandoned" }),
      w.webhookDeps,
    );

    w.pis.pi_B = "requires_capture";
    w.sessions.cs_B = { status: "complete", payment_intent: "pi_B" };
    await applyCreatorStripeEvent(w.piEvent("payment_intent.amount_capturable_updated", "pi_B"), w.webhookDeps);
  }

  it("the job starts on the second session's hold and the dead PaymentIntent leaves no ledger row", async () => {
    const w = world({ stripe_payment_intent_id: null });
    await play(w);
    expect(w.row.status).toBe("awaiting_acceptance");
    expect(w.row.stripe_payment_intent_id).toBe("pi_B");
    expect(w.ledger.get(`cr-hold-${ORDER}`)).toBe("pi_B");
    expect(w.ledger.has(`cr-cancel-${ORDER}`)).toBe(false);
    expect(w.transitions).toEqual(["checkout_completed"]);
  });

  it("an order that already carries the dead PaymentIntent (bound before this fix) still starts on the paid one", async () => {
    const w = world({ stripe_payment_intent_id: "pi_A" });
    await play(w);
    expect(w.row.status).toBe("awaiting_acceptance");
    expect(w.row.stripe_payment_intent_id).toBe("pi_B");
    expect(w.ledger.get(`cr-hold-${ORDER}`)).toBe("pi_B");
  });

  it("the browser poll alone, with the webhook for the paid session never arriving, also starts the job", async () => {
    const w = world({ stripe_payment_intent_id: "pi_A" });
    w.pis.pi_A = "canceled";
    w.row.stripe_checkout_session_id = "cs_B";
    w.pis.pi_B = "requires_capture";
    w.sessions.cs_B = { status: "complete", payment_intent: "pi_B" };
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, w.fulfilDeps);
    expect(r).toMatchObject({ state: "fulfilled", payment_intent_id: "pi_B", status: "awaiting_acceptance" });
    const again = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, w.fulfilDeps);
    expect(again).toMatchObject({ state: "already_done" });
    expect(w.transitions).toEqual(["checkout_completed"]);
  });
});
