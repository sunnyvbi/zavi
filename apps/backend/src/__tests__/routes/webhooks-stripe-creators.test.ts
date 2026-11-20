
import { describe, expect, it, vi } from "vitest";
import { makeCreatorStripeWebhook } from "@/routes/webhooks/stripe-creators";

function mockRes() {
  return {
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
}

function mockReq(opts: { sig?: string; raw?: Buffer } = {}) {
  return {
    header: (name: string) => (name === "stripe-signature" ? (opts.sig ?? "") : ""),
    body: opts.raw ?? Buffer.from("{}"),
  } as never;
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "account.updated",
    livemode: false,
    data: { object: { id: "acct_1" } },
    ...over,
  } as never;
}

function base(over: Parameters<typeof makeCreatorStripeWebhook>[0] = {}) {
  return makeCreatorStripeWebhook({
    webhookSecrets: () => ["whsec_platform"],
    constructEvent: () => event(),
    railEnabled: () => true,
    keyLivemode: () => false,
    apply: async () => ({ outcome: "recorded" as const }),
    log: async () => {},
    ...over,
  });
}

describe("POST /api/webhooks/stripe/creators", () => {
  it("503s with no signing secret — a retryable state, never a dropped event", async () => {
    const res = mockRes();
    await base({ webhookSecrets: () => [] })(mockReq({ sig: "t=1,v1=x" }), res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "creator_webhook_disabled" } });
  });

  it("400s when the stripe-signature header is missing", async () => {
    const res = mockRes();
    await base()(mockReq({ sig: "" }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "no_signature" } });
  });

  it("400s on a bad signature and never reaches a handler", async () => {
    const apply = vi.fn(async () => ({ outcome: "recorded" as const }));
    const res = mockRes();
    await base({
      constructEvent: () => {
        throw new Error("No signatures found matching the expected signature");
      },
      apply,
    })(mockReq({ sig: "t=1,v1=bad" }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "bad_signature" } });
    expect(apply).not.toHaveBeenCalled();
  });

  it("accepts a delivery signed with the CONNECT secret when the platform one does not match", async () => {
    const apply = vi.fn(async () => ({ outcome: "recorded" as const }));
    const constructEvent = vi.fn((_p: Buffer, _s: string, secret: string) => {
      if (secret !== "whsec_connect") throw new Error("no match");
      return event();
    });
    const res = mockRes();
    await base({
      webhookSecrets: () => ["whsec_platform", "whsec_connect"],
      constructEvent,
      apply,
    })(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(constructEvent).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("503s when the creator rail is off, AFTER verifying the signature", async () => {
    const apply = vi.fn(async () => ({ outcome: "recorded" as const }));
    const res = mockRes();
    await base({ railEnabled: () => false, apply })(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "creator_payments_disabled" } });
    expect(apply).not.toHaveBeenCalled();
  });

  it("503s when this process has no usable Stripe platform key", async () => {
    const res = mockRes();
    await base({
      keyLivemode: () => {
        throw new Error("no key");
      },
    })(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "stripe_platform_not_configured" } });
  });

  it("IGNORES a live event in a test-mode process (and the reverse) without handling it", async () => {
    const apply = vi.fn(async () => ({ outcome: "recorded" as const }));
    const logs: Array<Record<string, unknown>> = [];
    const res = mockRes();
    await base({
      constructEvent: () => event({ livemode: true }),
      keyLivemode: () => false,
      apply,
      log: async (l) => {
        logs.push(l as Record<string, unknown>);
      },
    })(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outcome: "ignored_livemode_mismatch" });
    expect(apply).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ meta: { reject_reason: "livemode_mismatch" } });
  });

  it("acks an event type this rail does not handle, without calling a handler", async () => {
    const apply = vi.fn(async () => ({ outcome: "recorded" as const }));
    const res = mockRes();
    await base({ constructEvent: () => event({ type: "invoice.paid" }), apply })(
      mockReq({ sig: "t=1,v1=ok" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ outcome: "ignored_unhandled_type" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("200s with the handler outcome for a handled event", async () => {
    const res = mockRes();
    await base({ apply: async () => ({ outcome: "released" as const, released: 2, waiting: 0 }) })(
      mockReq({ sig: "t=1,v1=ok" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      event_id: "evt_1",
      type: "account.updated",
      outcome: "released",
      released: 2,
    });
  });

  it("500s when a handler throws, so Stripe redelivers rather than the event being lost", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const res = mockRes();
    await base({
      apply: async () => {
        throw new Error("supabase unreachable");
      },
      log: async (l) => {
        logs.push(l as Record<string, unknown>);
      },
    })(mockReq({ sig: "t=1,v1=ok" }), res as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: { code: "creator_webhook_handler_failed" } });
    expect(logs[0]).toMatchObject({ level: "error", code: "creator.webhook.handler_error" });
  });
});
