
import { describe, expect, it, vi } from "vitest";
import { fulfilCreatorCheckout, type FulfilDeps } from "../checkout-fulfil";
import type { CreatorOrderCheckoutRow } from "../booking-db";
import type { CreatorHoldState } from "../orders-money";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const PI = "pi_test_1";
const SESSION = "cs_test_1";

function checkoutRow(over: Partial<CreatorOrderCheckoutRow> = {}): CreatorOrderCheckoutRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "checkout_pending",
    booked_by_user_id: "u1",
    business_total_cents: 16_500,
    currency: "usd",
    livemode: false,
    stripe_checkout_session_id: SESSION,
    stripe_payment_intent_id: null,
    hold_expires_at: null,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
    ...over,
  };
}

function heldState(over: Partial<CreatorHoldState> = {}): CreatorHoldState {
  return {
    payment_intent_id: PI,
    status: "requires_capture",
    amount_cents: 16_500,
    charge_id: "ch_1",
    hold_expires_at: "2026-09-18T00:00:00.000Z",
    held: true,
    captured: false,
    released: false,
    ...over,
  };
}

type H = {
  deps: FulfilDeps;
  recorded: { cause: string; payment_intent_id: string; actor_user_id?: string | null }[];
  triggers: { trigger: string; actor?: string; actor_user_id?: string | null }[];
  attached: { payment_intent_id: string; hold_expires_at: string | null }[];
  sessionReads: number;
  logs: { code?: string }[];
  briefsClosed: { brief_id: string; hired_application_id: string }[];
};

function harness(opts: {
  row?: CreatorOrderCheckoutRow;
  hold?: CreatorHoldState;
  session?: { status: string; payment_status: string; payment_intent: string | null };
  transition?: (t: string) => Promise<unknown>;
}): H {
  const recorded: H["recorded"] = [];
  const triggers: H["triggers"] = [];
  const attached: H["attached"] = [];
  const logs: H["logs"] = [];
  const briefsClosed: H["briefsClosed"] = [];
  let sessionReads = 0;
  let row = opts.row ?? checkoutRow();

  const deps: FulfilDeps = {
    stripe: () =>
      ({
        checkout: {
          sessions: {
            retrieve: async () => {
              sessionReads += 1;
              return (
                opts.session ?? {
                  status: "complete",
                  payment_status: "unpaid",
                  payment_intent: PI,
                }
              );
            },
          },
        },
      }) as never,
    loadOrder: async (tid) => (tid === row.tenant_id ? row : null),
    attachPaymentIntent: async (a) => {
      attached.push({
        payment_intent_id: a.payment_intent_id,
        hold_expires_at: a.hold_expires_at,
      });
      row = { ...row, stripe_payment_intent_id: a.payment_intent_id };
    },
    readHold: async () => opts.hold ?? heldState(),
    recordHold: async (a) => {
      recorded.push({ cause: a.cause, payment_intent_id: a.payment_intent_id, ...(a.actor_user_id ? { actor_user_id: a.actor_user_id } : {}) });
      return opts.hold ?? heldState();
    },
    transition: (async (a: { trigger: string; actor?: string; actor_user_id?: string | null }) => {
      triggers.push({ trigger: a.trigger, actor: a.actor, actor_user_id: a.actor_user_id });
      if (opts.transition) return opts.transition(a.trigger);
      const to =
        a.trigger === "hire_applicant" || a.trigger === "offer_started"
          ? "in_progress"
          : "awaiting_acceptance";
      row = { ...row, status: to };
      return { ok: true, to, from: "checkout_pending" };
    }) as never,
    briefHired: async (a) => {
      briefsClosed.push({ brief_id: a.brief_id, hired_application_id: a.hired_application_id });
    },
    claimBrief: async () => "claimed" as const,
    releaseBrief: async () => undefined,
    briefOwner: async () => null,
    declineLate: async () => undefined,
    log: (async (e: { code?: string }) => {
      logs.push(e);
    }) as never,
  };
  return { deps, recorded, triggers, attached, logs, briefsClosed, get sessionReads() {
    return sessionReads;
  } } as H;
}

describe("fulfilment is gated on requires_capture, never on Checkout", () => {
  it("fulfils a booking when the PaymentIntent is held, even though Checkout says unpaid", async () => {
    const h = harness({
      session: { status: "complete", payment_status: "unpaid", payment_intent: PI },
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);

    expect(r.state).toBe("fulfilled");
    expect(h.recorded).toEqual([{ cause: "booking", payment_intent_id: PI }]);
    expect(h.triggers.map((t) => t.trigger)).toEqual(["checkout_completed"]);
    expect(r.state === "fulfilled" && r.status).toBe("awaiting_acceptance");
  });

  it("does NOT fulfil when Checkout says PAID but the PaymentIntent is not held", async () => {
    const h = harness({
      session: { status: "complete", payment_status: "paid", payment_intent: PI },
      hold: heldState({ status: "requires_payment_method", held: false, captured: false }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);

    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "not_held" });
    expect(h.recorded).toEqual([]);
    expect(h.triggers).toEqual([]);
    expect(h.attached).toEqual([]);
  });

  it("waits, without error, while there is no PaymentIntent yet", async () => {
    const h = harness({
      session: { status: "open", payment_status: "unpaid", payment_intent: null },
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "no_payment_intent" });
    expect(h.recorded).toEqual([]);
  });

  it("waits while no Checkout Session has been attached at all", async () => {
    const h = harness({ row: checkoutRow({ stripe_checkout_session_id: null }) });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "no_checkout" });
  });

  it("fulfils a saved-card hire: no Checkout Session, only the attached PaymentIntent", async () => {
    const h = harness({
      row: checkoutRow({ source: "offer", stripe_checkout_session_id: null, stripe_payment_intent_id: PI }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("fulfilled");
    expect(h.sessionReads).toBe(0);
    expect(h.recorded).toEqual([{ cause: "hire", payment_intent_id: PI }]);
    expect(h.triggers.map((t) => t.trigger)).toEqual(["offer_started"]);
  });

  it("a hire a founder approved records them as the hold's actor (autopilot tracking T1)", async () => {
    const h = harness({
      row: checkoutRow({ source: "offer", stripe_checkout_session_id: null, stripe_payment_intent_id: PI }),
    });
    const approver = "55555555-5555-5555-5555-555555555555";
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER, hold_actor_user_id: approver }, h.deps);
    expect(r.state).toBe("fulfilled");
    expect(h.recorded).toEqual([{ cause: "hire", payment_intent_id: PI, actor_user_id: approver }]);
  });

  it("parks a PaymentIntent that was already captured, instead of guessing", async () => {
    const h = harness({
      hold: heldState({ status: "succeeded", held: false, captured: true }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("needs_staff");
    expect(h.recorded).toEqual([]);
    expect(h.logs.some((l) => l.code === "checkout_captured_before_fulfil")).toBe(true);
  });

  it("records the hold's expiry so T1's lapsed-hold check has a date", async () => {
    const h = harness({});
    await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(h.attached).toEqual([
      { payment_intent_id: PI, hold_expires_at: "2026-09-18T00:00:00.000Z" },
    ]);
  });
});

describe("the two doors take different triggers", () => {
  it("a hire pulls hire_applicant, which is the trigger that captures (Q34)", async () => {
    const h = harness({ row: checkoutRow({ source: "applicant" }) });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);

    expect(h.recorded).toEqual([{ cause: "hire", payment_intent_id: PI }]);
    expect(h.triggers).toEqual([
      { trigger: "hire_applicant", actor: "business", actor_user_id: "u1" },
    ]);
    expect(r.state === "fulfilled" && r.status).toBe("in_progress");
  });

  it("a custom offer starts the job at once (offer_started), with no second 72h accept", async () => {
    const h = harness({ row: checkoutRow({ source: "offer" }) });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(h.recorded).toEqual([{ cause: "hire", payment_intent_id: PI }]);
    expect(h.triggers).toEqual([
      { trigger: "offer_started", actor: "system", actor_user_id: "u1" },
    ]);
    expect(r.state === "fulfilled" && r.status).toBe("in_progress");
    expect(h.briefsClosed).toEqual([]);
  });

  it("an offer paid after its 72 hours ran out is released, never captured", async () => {
    const h = harness({
      row: checkoutRow({ source: "offer", offer_id: "of1" }),
      hold: heldState({ authorized_at: "2026-09-15T19:00:00.000Z" }),
    });
    h.deps.offerExpiresAt = async () => "2026-09-15T18:41:35.186Z";
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(h.triggers).toEqual([{ trigger: "checkout_abandoned", actor: "system", actor_user_id: null }]);
    expect(r.state).toBe("cancelled");
    expect(r.state === "cancelled" && r.message).toMatch(/nothing was charged/);
  });

  it("an offer paid in time starts, however late fulfilment runs", async () => {
    const h = harness({
      row: checkoutRow({ source: "offer", offer_id: "of1" }),
      hold: heldState({ authorized_at: "2026-09-15T18:41:34.000Z" }),
    });
    h.deps.offerExpiresAt = async () => "2026-09-15T18:41:35.186Z";
    await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(h.triggers.map((t) => t.trigger)).toEqual(["offer_started"]);
  });

  it("an unreadable offer expiry, or a hold with no authorisation time, leaves the hold alone", async () => {
    const h = harness({ row: checkoutRow({ source: "offer", offer_id: "of1" }), hold: heldState({ authorized_at: "2026-09-15T18:00:00.000Z" }) });
    h.deps.offerExpiresAt = async () => {
      throw new Error("read failed");
    };
    expect((await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps)).state).toBe("pending");
    const h2 = harness({ row: checkoutRow({ source: "offer", offer_id: "of1" }), hold: heldState({ authorized_at: null }) });
    h2.deps.offerExpiresAt = async () => "2026-09-15T18:41:35.186Z";
    expect((await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h2.deps)).state).toBe("pending");
    expect([...h.triggers, ...h2.triggers]).toEqual([]);
  });

  it("a booking still waits for the creator (checkout_completed), never offer_started", async () => {
    const h = harness({ row: checkoutRow({ source: "booking" }) });
    await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(h.triggers.map((t) => t.trigger)).toEqual(["checkout_completed"]);
  });

  it("a charged hire closes the brief and sends everyone else the no", async () => {
    const h = harness({
      row: checkoutRow({ source: "applicant", brief_id: "brief-1", application_id: "app-1" }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("fulfilled");
    expect(h.briefsClosed).toEqual([{ brief_id: "brief-1", hired_application_id: "app-1" }]);
  });

  it("D6: a hire whose capture FAILED leaves the brief open and the other applicants untouched", async () => {
    const h = harness({
      row: checkoutRow({ source: "applicant", brief_id: "brief-1", application_id: "app-1" }),
      transition: async () => ({ ok: true, to: "cancelled", from: "checkout_pending" }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("cancelled");
    expect(h.briefsClosed).toEqual([]);
  });

  it("a failure closing the brief never undoes a paid hire", async () => {
    const h = harness({
      row: checkoutRow({ source: "applicant", brief_id: "brief-1", application_id: "app-1" }),
    });
    const r = await fulfilCreatorCheckout(
      { tenant_id: TENANT, order_id: ORDER },
      { ...h.deps, briefHired: async () => { throw new Error("db down"); } },
    );
    expect(r.state).toBe("fulfilled");
    expect(h.logs.some((l) => l.code === "brief_close_after_hire_failed")).toBe(true);
  });

  it("a retry after a failed brief close closes it this time (the first capture already landed)", async () => {
    const h = harness({
      row: checkoutRow({ source: "applicant", brief_id: "brief-1", application_id: "app-1" }),
    });
    const first = await fulfilCreatorCheckout(
      { tenant_id: TENANT, order_id: ORDER },
      { ...h.deps, briefHired: async () => { throw new Error("db down"); } },
    );
    expect(first.state).toBe("fulfilled");
    expect(h.briefsClosed).toEqual([]);
    const retry = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(retry.state).toBe("already_done");
    expect(h.briefsClosed).toEqual([{ brief_id: "brief-1", hired_application_id: "app-1" }]);
    expect(h.triggers).toHaveLength(1);
  });

  it("the losing racer of a charged hire also finishes the brief close", async () => {
    let row = checkoutRow({ source: "applicant", brief_id: "brief-1", application_id: "app-1" });
    const h = harness({ row, transition: async () => ({ ok: false, code: "conflict", message: "moved" }) });
    const r = await fulfilCreatorCheckout(
      { tenant_id: TENANT, order_id: ORDER },
      {
        ...h.deps,
        loadOrder: (async () => {
          const cur = row;
          row = { ...row, status: "in_progress" };
          return cur;
        }) as typeof h.deps.loadOrder,
      },
    );
    expect(r).toMatchObject({ state: "already_done", status: "in_progress" });
    expect(h.briefsClosed).toEqual([{ brief_id: "brief-1", hired_application_id: "app-1" }]);
  });

  it("an already-done booking, offer, or cancelled hire never touches a brief", async () => {
    for (const row of [
      checkoutRow({ status: "in_progress", source: "offer" }),
      checkoutRow({ status: "awaiting_acceptance" }),
      checkoutRow({ status: "cancelled", source: "applicant", brief_id: "brief-1", application_id: "app-1" }),
    ]) {
      const h = harness({ row });
      const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
      expect(r.state).toBe("already_done");
      expect(h.briefsClosed).toEqual([]);
    }
  });

  it("reports T1's immediate cancellation plainly", async () => {
    const h = harness({
      row: checkoutRow({ source: "applicant" }),
      transition: async () => ({ ok: true, to: "cancelled", from: "checkout_pending" }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("cancelled");
    expect(r.state === "cancelled" && r.message).toContain("nothing was taken");
  });
});

describe("idempotence: the webhook and the browser race harmlessly", () => {
  it("short-circuits an order that already left checkout_pending, without calling Stripe", async () => {
    const h = harness({ row: checkoutRow({ status: "in_progress" }) });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "already_done", order_id: ORDER, status: "in_progress" });
    expect(h.sessionReads).toBe(0);
    expect(h.recorded).toEqual([]);
  });

  it("reads a losing race as already_done, not as a failure", async () => {
    const h = harness({
      transition: async () => ({ ok: false, code: "conflict", message: "moved" }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("already_done");
  });

  it("running it twice records the hold once per run and never re-triggers a moved order", async () => {
    const h = harness({});
    const a = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    const b = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(a.state).toBe("fulfilled");
    expect(b.state).toBe("already_done");
    expect(h.triggers).toHaveLength(1);
  });
});

describe("cross-tenant", () => {
  it("cannot fulfil another workspace's order", async () => {
    const h = harness({});
    await expect(
      fulfilCreatorCheckout({ tenant_id: OTHER_TENANT, order_id: ORDER }, h.deps),
    ).rejects.toMatchObject({ code: "creator_order_not_found" });
    expect(h.recorded).toEqual([]);
    expect(h.triggers).toEqual([]);
  });

  it("scopes every money call with the ORDER's tenant, never the caller's string", async () => {
    const seen: string[] = [];
    const h = harness({});
    const spied: FulfilDeps = {
      ...h.deps,
      recordHold: async (a) => {
        seen.push(a.tenant_id);
        return h.deps.recordHold(a);
      },
    };
    await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, spied);
    expect(seen).toEqual([TENANT]);
  });
});

describe("hermetic", () => {
  it("makes no fetch call", async () => {
    const spy = vi.spyOn(globalThis, "fetch" as never);
    const h = harness({});
    await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("one capture per brief: the brief is claimed before any capture", () => {
  const ORDER_B = "44444444-4444-4444-4444-444444444444";

  function world() {
    let filledBy: string | null = null;
    const status: Record<string, string> = { [ORDER]: "checkout_pending", [ORDER_B]: "checkout_pending" };
    const apps: Record<string, string> = { [ORDER]: "app-1", [ORDER_B]: "app-2" };
    const declined: string[] = [];
    const captures: string[] = [];
    const released: string[] = [];
    const failCapture = new Set<string>();

    function depsFor(orderId: string): FulfilDeps {
      const h = harness({});
      return {
        ...h.deps,
        loadOrder: (async (_t: string, id: string) =>
          status[id]
            ? checkoutRow({ id, source: "applicant", brief_id: "brief-1", application_id: apps[id], status: status[id] as never })
            : null) as never,
        transition: (async (a: { order_id: string; trigger: string }) => {
          if (status[a.order_id] !== "checkout_pending") return { ok: false, code: "conflict", message: "moved" };
          if (a.trigger === "hire_applicant") {
            if (failCapture.has(a.order_id)) {
              failCapture.delete(a.order_id);
              status[a.order_id] = "cancelled";
              return { ok: true, to: "cancelled", from: "checkout_pending" };
            }
            captures.push(a.order_id);
            status[a.order_id] = "in_progress";
            return { ok: true, to: "in_progress", from: "checkout_pending" };
          }
          status[a.order_id] = "cancelled";
          return { ok: true, to: "cancelled", from: "checkout_pending" };
        }) as never,
        claimBrief: (async ({ order_id }: { order_id: string }) => {
          if (filledBy === null) {
            filledBy = order_id;
            return "claimed";
          }
          return filledBy === order_id ? "ours" : "taken";
        }) as never,
        releaseBrief: (async ({ order_id }: { order_id: string }) => {
          released.push(order_id);
          if (filledBy === order_id) filledBy = null;
        }) as never,
        briefOwner: async () => filledBy,
        declineLate: async ({ application_id }) => {
          declined.push(application_id);
        },
      };
    }
    const fulfil = (orderId: string) => fulfilCreatorCheckout({ tenant_id: TENANT, order_id: orderId }, depsFor(orderId));
    return {
      fulfil,
      depsFor,
      status,
      declined,
      captures,
      released,
      failCapture,
      claim: (id: string) => {
        filledBy = id;
      },
      get filledBy() {
        return filledBy;
      },
    };
  }

  it("A captures first: B is released before any capture and told it was not hired", async () => {
    const w = world();
    expect((await w.fulfil(ORDER)).state).toBe("fulfilled");
    const b = await w.fulfil(ORDER_B);
    expect(b.state).toBe("cancelled");
    expect(b.state === "cancelled" && b.message).toMatch(/nothing was charged/);
    expect(w.captures).toEqual([ORDER]);
    expect(w.declined).toEqual(["app-2"]);
  });

  it("B arrives while A holds the claim but has not charged: B waits, untouched", async () => {
    const w = world();
    w.claim(ORDER);
    const b = await w.fulfil(ORDER_B);
    expect(b).toMatchObject({ state: "pending", reason: "brief_held" });
    expect(w.status[ORDER_B]).toBe("checkout_pending");
    expect(w.declined).toEqual([]);
    expect(w.captures).toEqual([]);
  });

  it("A's capture fails after B waited: B can still be hired", async () => {
    const w = world();
    w.claim(ORDER);
    expect((await w.fulfil(ORDER_B)).state).toBe("pending");
    w.failCapture.add(ORDER);
    expect((await w.fulfil(ORDER)).state).toBe("cancelled");
    expect(w.released).toContain(ORDER);
    const b = await w.fulfil(ORDER_B);
    expect(b.state).toBe("fulfilled");
    expect(w.captures).toEqual([ORDER_B]);
    expect(w.declined).toEqual([]);
  });

  it("an owner whose release died still holds the claim: the next order clears it and is hired", async () => {
    const w = world();
    w.claim(ORDER);
    w.status[ORDER] = "cancelled";
    const b = await w.fulfil(ORDER_B);
    expect(b.state).toBe("fulfilled");
    expect(w.captures).toEqual([ORDER_B]);
  });

  it("a failed claim release is not swallowed: the delivery fails, so it is retried", async () => {
    const w = world();
    w.failCapture.add(ORDER);
    const deps = w.depsFor(ORDER);
    await expect(
      fulfilCreatorCheckout(
        { tenant_id: TENANT, order_id: ORDER },
        { ...deps, releaseBrief: (async () => { throw new Error("db down"); }) as never },
      ),
    ).rejects.toThrow("db down");
    expect((await w.fulfil(ORDER)).state).toBe("already_done");
    expect(w.filledBy).toBeNull();
  });

  it("a retry of the cancelled owner gives its claim back (the release is not lost)", async () => {
    const w = world();
    w.claim(ORDER);
    w.status[ORDER] = "cancelled";
    const r = await w.fulfil(ORDER);
    expect(r.state).toBe("already_done");
    expect(w.released).toEqual([ORDER]);
    expect(w.filledBy).toBeNull();
  });

  it("the same order fulfilled twice is not released by its own claim", async () => {
    const w = world();
    await w.fulfil(ORDER);
    const again = await w.fulfil(ORDER);
    expect(again.state).toBe("already_done");
    expect(w.captures).toEqual([ORDER]);
    expect(w.declined).toEqual([]);
  });

  it("a lost capture reply on the owner completes its hire; a second applicant is never captured", async () => {
    const w = world();
    w.claim(ORDER);
    const deps = w.depsFor(ORDER);
    const attached: string[] = [];
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, {
      ...deps,
      loadOrder: (async (t: string, id: string) => {
        const row = await deps.loadOrder(t, id);
        return row && id === ORDER ? { ...row, stripe_payment_intent_id: PI } : row;
      }) as never,
      readHold: async () => heldState({ status: "succeeded", held: false, captured: true, refunded_cents: 0 }),
      attachPaymentIntent: (async () => {
        attached.push("attach");
      }) as never,
      recordHold: (async () => {
        attached.push("record");
        return heldState();
      }) as never,
    });
    expect(r).toMatchObject({ state: "fulfilled", status: "in_progress" });
    expect(w.captures).toEqual([ORDER]);
    expect(attached).toEqual([]);
    expect(w.filledBy).toBe(ORDER);
    const b = await w.fulfil(ORDER_B);
    expect(b.state).toBe("cancelled");
    expect(w.captures).toEqual([ORDER]);
  });

  it("a lost capture that staff already refunded never starts the job", async () => {
    for (const refunded_cents of [16_500, 500, null]) {
      const h = harness({
        row: checkoutRow({ source: "applicant", brief_id: "brief-1", application_id: "app-1", stripe_payment_intent_id: PI }),
        hold: heldState({ status: "succeeded", held: false, captured: true, refunded_cents }),
      });
      const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
      expect(r.state).toBe("needs_staff");
      expect(h.triggers).toEqual([]);
    }
  });

  it("a booking whose payment shows captured at checkout still parks for staff", async () => {
    const h = harness({
      row: checkoutRow({ source: "booking", stripe_payment_intent_id: PI }),
      hold: heldState({ status: "succeeded", held: false, captured: true }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("needs_staff");
    expect(h.triggers).toEqual([]);
  });

  it("a booking never claims a brief, and still waits for the creator", async () => {
    const seen: string[] = [];
    const booking = harness({ row: checkoutRow({ source: "booking" }) });
    await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, {
      ...booking.deps,
      claimBrief: (async ({ brief_id }: { brief_id: string }) => {
        seen.push(brief_id);
        return "taken";
      }) as never,
    });
    expect(seen).toEqual([]);
    expect(booking.triggers.map((t) => t.trigger)).toEqual(["checkout_completed"]);
  });
});

describe("an order bound to a dead PaymentIntent, paid on a resumed Checkout", () => {
  const DEAD = "pi_dead";
  const LIVE = "pi_live";

  function resumed(opts: { sessionPi: string | null; replace?: (a: { from_payment_intent_id: string; to_payment_intent_id: string }) => Promise<boolean>; liveHold?: CreatorHoldState }) {
    const h = harness({
      row: checkoutRow({ stripe_payment_intent_id: DEAD, stripe_checkout_session_id: "cs_resumed" }),
      session: { status: "complete", payment_status: "unpaid", payment_intent: opts.sessionPi },
    });
    const reads: string[] = [];
    h.deps.readHold = async (id) => {
      reads.push(id);
      if (id === DEAD) return heldState({ payment_intent_id: DEAD, status: "canceled", held: false, released: true });
      return opts.liveHold ?? heldState({ payment_intent_id: LIVE });
    };
    const replaced: { from_payment_intent_id: string; to_payment_intent_id: string }[] = [];
    h.deps.replacePaymentIntent = async (a) => {
      replaced.push({ from_payment_intent_id: a.from_payment_intent_id, to_payment_intent_id: a.to_payment_intent_id });
      expect(a).toMatchObject({ tenant_id: TENANT, order_id: ORDER });
      return opts.replace ? opts.replace(a) : true;
    };
    return { h, reads, replaced };
  }

  it("moves the order onto the session's held PaymentIntent and starts the job", async () => {
    const { h, reads, replaced } = resumed({ sessionPi: LIVE });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toMatchObject({ state: "fulfilled", payment_intent_id: LIVE, status: "awaiting_acceptance" });
    expect(replaced).toEqual([{ from_payment_intent_id: DEAD, to_payment_intent_id: LIVE }]);
    expect(reads).toEqual([DEAD, LIVE]);
    expect(h.attached.map((a) => a.payment_intent_id)).toEqual([LIVE]);
    expect(h.recorded).toEqual([{ cause: "booking", payment_intent_id: LIVE }]);
    expect(h.triggers.map((t) => t.trigger)).toEqual(["checkout_completed"]);
    expect(h.logs.some((l) => l.code === "checkout_replaced_dead_payment_intent")).toBe(true);
  });

  it("loses the guarded swap to a concurrent writer: records nothing and waits", async () => {
    const { h } = resumed({ sessionPi: LIVE, replace: async () => false });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "not_held" });
    expect(h.recorded).toEqual([]);
    expect(h.attached).toEqual([]);
    expect(h.triggers).toEqual([]);
  });

  it("does not swap when the session still points at the same dead PaymentIntent", async () => {
    const { h, replaced } = resumed({ sessionPi: DEAD });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "not_held" });
    expect(replaced).toEqual([]);
  });

  it("does not swap while the resumed session has no PaymentIntent yet", async () => {
    const { h, replaced } = resumed({ sessionPi: null });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "not_held" });
    expect(replaced).toEqual([]);
  });

  it("swaps to the live PaymentIntent but still waits while it is not held", async () => {
    const { h, replaced } = resumed({
      sessionPi: LIVE,
      liveHold: heldState({ payment_intent_id: LIVE, status: "processing", held: false }),
    });
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "not_held" });
    expect(replaced).toHaveLength(1);
    expect(h.recorded).toEqual([]);
  });

  it("a live hold on the order's own PaymentIntent never consults the session", async () => {
    const h = harness({ row: checkoutRow({ stripe_payment_intent_id: PI }) });
    let replaced = 0;
    h.deps.replacePaymentIntent = async () => {
      replaced += 1;
      return true;
    };
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r.state).toBe("fulfilled");
    expect(h.sessionReads).toBe(0);
    expect(replaced).toBe(0);
  });

  it("a saved-card order (no session) whose PaymentIntent died is left alone", async () => {
    const h = harness({
      row: checkoutRow({ source: "offer", stripe_checkout_session_id: null, stripe_payment_intent_id: DEAD }),
      hold: heldState({ payment_intent_id: DEAD, status: "canceled", held: false, released: true }),
    });
    let replaced = 0;
    h.deps.replacePaymentIntent = async () => {
      replaced += 1;
      return true;
    };
    const r = await fulfilCreatorCheckout({ tenant_id: TENANT, order_id: ORDER }, h.deps);
    expect(r).toEqual({ state: "pending", order_id: ORDER, reason: "not_held" });
    expect(replaced).toBe(0);
    expect(h.sessionReads).toBe(0);
  });
});
