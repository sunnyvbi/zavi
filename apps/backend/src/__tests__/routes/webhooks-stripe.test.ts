import { describe, it, expect, vi, beforeEach } from "vitest";

const logEvent = vi.fn(async (_input: unknown) => {});
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (input: unknown) => logEvent(input),
}));

import { makeStripeWebhook } from "@/routes/webhooks/stripe";

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function mockReq(opts: { sig?: string; raw?: Buffer } = {}) {
  return {
    header: (name: string) => (name === "stripe-signature" ? opts.sig ?? "" : ""),
    body: opts.raw ?? Buffer.from("{}"),
  } as never;
}

beforeEach(() => {
  logEvent.mockReset();
});

describe("POST /api/webhooks/stripe", () => {
  it("503s when the rail is off (no STRIPE_WEBHOOK_SECRET) — never silently drops an event", async () => {
    const handler = makeStripeWebhook({ webhookSecret: () => null });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=x" }), res as never);
    expect(res.statusCode).toBe(503);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("400s when the signature header is missing", async () => {
    const handler = makeStripeWebhook({ webhookSecret: () => "whsec_test" });
    const res = mockRes();
    await handler(mockReq({ sig: "" }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "no_signature" } });
  });

  it("400s on a bad signature (constructEvent throws) — never processes", async () => {
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () => {
        throw new Error("No signatures found matching the expected signature");
      },
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=bad" }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "bad_signature" } });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("acks + records a handled payment_intent.succeeded event (C14-safe meta only)", async () => {
    const tenant = "22222222-2222-2222-2222-222222222222";
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_1",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_1",
              amount: 12345,
              currency: "usd",
              metadata: { praxis_tenant_id: tenant, praxis_money_model: "path_b" },
            },
          },
        }) as never,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, type: "payment_intent.succeeded", event_id: "evt_1" });
    expect(logEvent).toHaveBeenCalledTimes(1);
    const call = (logEvent.mock.calls[0] as unknown[])[0] as {
      level: string;
      code: string;
      tenant_id?: string;
      meta: Record<string, unknown>;
    };
    expect(call.code).toBe("stripe.payment_intent.succeeded");
    expect(call.level).toBe("info");
    expect(call.tenant_id).toBe(tenant);
    expect(call.meta).toMatchObject({
      event_id: "evt_1",
      object_id: "pi_1",
      amount: 12345,
      currency: "usd",
      money_model: "path_b",
    });
  });

  it("warns on a dispute.created event", async () => {
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_2",
          type: "charge.dispute.created",
          data: { object: { id: "ch_1", amount: 999, currency: "usd", metadata: {} } },
        }) as never,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    const call = (logEvent.mock.calls[0] as unknown[])[0] as { level: string };
    expect(call.level).toBe("warn");
  });

  it("200 no-ops an unhandled event type (stops Stripe retrying)", async () => {
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({ id: "evt_3", type: "customer.created", data: { object: {} } }) as never,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: "customer.created" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("account.updated with payouts_enabled=true fires the sweep (tenant re-derived, C8)", async () => {
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const tenant = "33333333-3333-3333-3333-333333333333";
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_acct_1",
          type: "account.updated",
          data: { object: { id: "acct_ready", payouts_enabled: true } },
        }) as never,
      resolveTenantByStripeAccount: async (acctId) => {
        expect(acctId).toBe("acct_ready");
        return tenant;
      },
      sendEvent: async (name, data) => {
        sent.push({ name, data });
      },
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, type: "account.updated", swept: true });
    expect(sent).toEqual([
      {
        name: "autopilot/connect.payouts_enabled",
        data: { stripe_account_id: "acct_ready", tenant_id: tenant },
      },
    ]);
    const call = (logEvent.mock.calls[0] as unknown[])[0] as { code: string; tenant_id?: string };
    expect(call.code).toBe("stripe.account.updated.payouts_enabled");
    expect(call.tenant_id).toBe(tenant);
  });

  it("account.updated payouts_enabled=true but NO owning tenant → acks, does NOT fire the sweep", async () => {
    const sendEvent = vi.fn(async () => {});
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_acct_2",
          type: "account.updated",
          data: { object: { id: "acct_orphan", payouts_enabled: true } },
        }) as never,
      resolveTenantByStripeAccount: async () => null,
      sendEvent,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ swept: false });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("account.updated payouts_enabled=false → acks + records, never fires the sweep", async () => {
    const sendEvent = vi.fn(async () => {});
    const resolveTenant = vi.fn(async () => "x");
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_acct_3",
          type: "account.updated",
          data: { object: { id: "acct_pending", payouts_enabled: false } },
        }) as never,
      resolveTenantByStripeAccount: resolveTenant,
      sendEvent,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ type: "account.updated", swept: false });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(resolveTenant).not.toHaveBeenCalled();
    const call = (logEvent.mock.calls[0] as unknown[])[0] as { code: string };
    expect(call.code).toBe("stripe.account.updated");
  });

  it("charge.refunded flips a still-held fund to 'refunded' so it can never be remitted", async () => {
    const markRefunded = vi.fn(async (_a: { id: string }) => true);
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_ref_1",
          type: "charge.refunded",
          data: { object: { id: "ch_1", payment_intent: "pi_1" } },
        }) as never,
      findHeldFundByChargeId: async (chargeId: string) =>
        chargeId === "pi_1" ? ({ id: "hf_1", tenant_id: "t1", status: "held" } as never) : null,
      markHeldFundRefunded: markRefunded,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(markRefunded).toHaveBeenCalledWith({ id: "hf_1" });
    const codes = (logEvent.mock.calls as unknown[][]).map((c) => (c[0] as { code: string }).code);
    expect(codes).toContain("autopilot.held_fund.refunded");
  });

  it("charge.refunded on an ALREADY-remitted fund warns for reconcile (cannot auto-unwind a payout)", async () => {
    const handler = makeStripeWebhook({
      webhookSecret: () => "whsec_test",
      constructEvent: () =>
        ({
          id: "evt_ref_2",
          type: "charge.refunded",
          data: { object: { id: "ch_2", payment_intent: "pi_2" } },
        }) as never,
      findHeldFundByChargeId: async () =>
        ({ id: "hf_2", tenant_id: "t1", status: "remitted" } as never),
      markHeldFundRefunded: async () => false,
    });
    const res = mockRes();
    await handler(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    const codes = (logEvent.mock.calls as unknown[][]).map((c) => (c[0] as { code: string }).code);
    expect(codes).toContain("autopilot.held_fund.refund_after_remit");
  });
});
