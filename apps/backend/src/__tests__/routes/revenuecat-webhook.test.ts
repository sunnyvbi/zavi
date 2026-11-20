
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ logEvent: vi.fn() }));

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/services/growth/preview-upgrade", () => ({ requestPreviewUpgrade: vi.fn() }));

import { makeRevenueCatWebhook, signatureValid, type StoreOutcome } from "../../routes/webhooks/revenuecat";

const TENANT = "77777777-7777-7777-7777-777777777777";
const USER = "11111111-1111-1111-1111-111111111111";
const AUTH = "Bearer test-secret";
const SIGNING = "whsec_test";
const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
const END_MS = Date.UTC(2026, 10, 24, 12, 0, 0);

type Ev = Record<string, unknown>;

const event = (over: Ev = {}): Ev => ({
  id: "evt_1",
  type: "INITIAL_PURCHASE",
  app_user_id: USER,
  product_id: "zavi_growth_monthly",
  store: "PLAY_STORE",
  environment: "PRODUCTION",
  event_timestamp_ms: NOW_MS,
  expiration_at_ms: END_MS,
  ...over,
});

function makeReq(ev: Ev, headers: Record<string, string> = { authorization: AUTH }, raw?: Buffer) {
  const body = raw ?? Buffer.from(JSON.stringify({ api_version: "1.0", event: ev }));
  return {
    body,
    header: (n: string) => headers[n.toLowerCase()],
  } as never;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
}

function build(over: Record<string, unknown> = {}) {
  const deps = {
    authSecret: () => "Bearer test-secret",
    signingSecret: () => null as string | null,
    allowSandbox: () => false,
    nowMs: () => NOW_MS,
    eventProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    resolveTenantByStoreUser: vi.fn().mockResolvedValue(null),
    resolveTenantByBinding: vi.fn().mockResolvedValue(TENANT),
    applyState: vi.fn().mockResolvedValue({ error: null, outcome: "applied" as StoreOutcome }),
    setMonthlyCredits: vi.fn().mockResolvedValue({ error: null }),
    requestPreviewRerun: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  return { deps, handler: makeRevenueCatWebhook(deps as never) };
}

async function send(handler: ReturnType<typeof build>["handler"], req: never) {
  const res = mockRes();
  await handler(req, res as never);
  return res;
}

const errCode = (r: ReturnType<typeof mockRes>) => ((r.body?.error ?? {}) as { code?: string }).code;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authentication", () => {
  it("is inert until the authorization secret is set", async () => {
    const { handler } = build({ authSecret: () => null });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(503);
  });

  it("rejects a wrong authorization header", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event(), { authorization: "Bearer nope" }));
    expect(res.statusCode).toBe(401);
    expect(errCode(res)).toBe("bad_authorization");
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("rejects a missing authorization header", async () => {
    const { handler } = build();
    const res = await send(handler, makeReq(event(), {}));
    expect(res.statusCode).toBe(401);
  });

  describe("signature", () => {
    const raw = Buffer.from(JSON.stringify({ event: event() }));
    const sign = (t: number, body = raw, secret = SIGNING) =>
      `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
    const nowS = Math.floor(NOW_MS / 1000);

    it("accepts a correct signature", () => {
      expect(signatureValid(raw, sign(nowS), SIGNING, nowS)).toBe(true);
    });
    it("rejects a signature over a different body", () => {
      expect(signatureValid(Buffer.from("{}"), sign(nowS), SIGNING, nowS)).toBe(false);
    });
    it("rejects the wrong secret", () => {
      expect(signatureValid(raw, sign(nowS, raw, "other"), SIGNING, nowS)).toBe(false);
    });
    it("rejects an old timestamp", () => {
      expect(signatureValid(raw, sign(nowS - 3600), SIGNING, nowS)).toBe(false);
    });
    it("rejects garbage", () => {
      expect(signatureValid(raw, "nonsense", SIGNING, nowS)).toBe(false);
      expect(signatureValid(raw, "", SIGNING, nowS)).toBe(false);
    });

    it("the handler enforces it when a signing secret is configured", async () => {
      const { handler, deps } = build({ signingSecret: () => SIGNING });
      const bad = await send(handler, makeReq(event(), { authorization: AUTH, "x-revenuecat-webhook-signature": "t=1,v1=00" }, raw));
      expect(bad.statusCode).toBe(401);
      expect(errCode(bad)).toBe("bad_signature");
      const good = await send(handler, makeReq(event(), { authorization: AUTH, "x-revenuecat-webhook-signature": sign(nowS) }, raw));
      expect(good.statusCode).toBe(200);
      expect(deps.applyState).toHaveBeenCalledTimes(1);
    });
  });
});

describe("request validation and filtering", () => {
  it("400s on a body that is not JSON", async () => {
    const { handler } = build();
    const res = await send(handler, makeReq({}, { authorization: AUTH }, Buffer.from("not json")));
    expect(res.statusCode).toBe(400);
  });

  it("400s when the event has no id or type", async () => {
    const { handler } = build();
    const res = await send(handler, makeReq({ type: "RENEWAL" }));
    expect(res.statusCode).toBe(400);
  });

  it("acknowledges TEST events without doing anything", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event({ type: "TEST" })));
    expect(res.statusCode).toBe(200);
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("ignores sandbox purchases unless explicitly allowed", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event({ environment: "SANDBOX" })));
    expect(res.body).toMatchObject({ ignored: "sandbox" });
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("ignores Test Store purchases unless explicitly allowed", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ store: "TEST_STORE" })));
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("processes sandbox purchases when allowed", async () => {
    const { handler, deps } = build({ allowSandbox: () => true });
    await send(handler, makeReq(event({ environment: "SANDBOX", store: "TEST_STORE" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ source: "test_store" }));
  });

  it("ignores stores it does not sell through", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event({ store: "STRIPE" })));
    expect(res.statusCode).toBe(200);
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("ignores PRODUCT_CHANGE", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event({ type: "PRODUCT_CHANGE" })));
    expect(res.body).toMatchObject({ ignored: "PRODUCT_CHANGE" });
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("500s and logs on a product it cannot map, so RevenueCat retries", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event({ product_id: "mystery" })));
    expect(res.statusCode).toBe(500);
    expect(errCode(res)).toBe("unknown_product");
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "store_unknown_product" }));
    expect(deps.markProcessed).not.toHaveBeenCalled();
  });
});

describe("finding the workspace", () => {
  it("a renewal follows the workspace that already holds the subscription", async () => {
    const { handler, deps } = build({ resolveTenantByStoreUser: vi.fn().mockResolvedValue("tenant-from-row") });
    await send(handler, makeReq(event({ type: "RENEWAL" })));
    expect(deps.resolveTenantByBinding).not.toHaveBeenCalled();
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-from-row" }));
  });

  it("a new purchase follows the workspace the person just chose, not an old one", async () => {
    const { handler, deps } = build({ resolveTenantByStoreUser: vi.fn().mockResolvedValue("old-workspace") });
    await send(handler, makeReq(event({ type: "INITIAL_PURCHASE" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT }));
    expect(deps.resolveTenantByStoreUser).not.toHaveBeenCalled();
  });

  it("a new purchase with no binding falls back to the stored customer", async () => {
    const { handler, deps } = build({
      resolveTenantByBinding: vi.fn().mockResolvedValue(null),
      resolveTenantByStoreUser: vi.fn().mockResolvedValue("tenant-from-row"),
    });
    await send(handler, makeReq(event({ type: "INITIAL_PURCHASE" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-from-row" }));
  });

  it("falls back to the binding for a first purchase", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event()));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT }));
  });

  it("never applies an anonymous customer", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event({ app_user_id: "$RCAnonymousID:abc" })));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ unbound: true });
    expect(deps.resolveTenantByStoreUser).not.toHaveBeenCalled();
    expect(deps.applyState).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "store_event_unbound" }));
  });

  it("acknowledges an unbound customer without applying anything", async () => {
    const { handler, deps } = build({ resolveTenantByBinding: vi.fn().mockResolvedValue(null) });
    const res = await send(handler, makeReq(event()));
    expect(res.body).toMatchObject({ unbound: true });
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("logs an unbound non-purchase event as a warning only", async () => {
    const { handler } = build({ resolveTenantByBinding: vi.fn().mockResolvedValue(null) });
    await send(handler, makeReq(event({ type: "EXPIRATION" })));
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }));
  });
});

describe("applying events", () => {
  it("a first purchase writes the plan, refreshes credits and requests the preview rerun", async () => {
    const { handler, deps } = build();
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenCalledWith({
      tenant_id: TENANT,
      source: "play_store",
      store_app_user_id: USER,
      store_product_id: "zavi_growth_monthly",
      tier: "growth",
      status: "active",
      current_period_end: new Date(END_MS).toISOString(),
      cancel_at_period_end: false,
      event_ms: NOW_MS,
      refund_reversed: false,
      refund: false,
    });
    expect(deps.setMonthlyCredits).toHaveBeenCalledWith(TENANT, Math.floor(NOW_MS / 1000));
    expect(deps.requestPreviewRerun).toHaveBeenCalledWith(TENANT);
    expect(deps.markProcessed).toHaveBeenCalledWith("evt_1", "INITIAL_PURCHASE");
  });

  it("an App Store renewal keeps the source", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ type: "RENEWAL", store: "APP_STORE" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ source: "app_store", status: "active" }));
  });

  it("a cancellation marks the end of the period and grants nothing new", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: "growth", status: "active", cancel_at_period_end: true }));
    expect(deps.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("a customer-support cancellation is applied as a refund in the one locked write", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT" })));
    expect(deps.applyState).toHaveBeenCalledTimes(1);
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ refund: true, event_ms: NOW_MS, store_app_user_id: USER }));
    expect(deps.requestPreviewRerun).not.toHaveBeenCalled();
    expect(deps.markProcessed).toHaveBeenCalledWith("evt_1", "CANCELLATION");
  });

  it("a refund followed by a newer event keeps the refund: nothing is left to run after the newer one", async () => {
    const calls: string[] = [];
    const applyState = vi.fn(async (a: { refund: boolean; event_ms: number }) => {
      calls.push(a.refund ? `refund@${a.event_ms}` : `event@${a.event_ms}`);
      return { error: null, outcome: "applied" as StoreOutcome };
    });
    const { handler } = build({ applyState, resolveTenantByStoreUser: vi.fn().mockResolvedValue(TENANT) });
    await send(handler, makeReq(event({ type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT" })));
    await send(handler, makeReq(event({ id: "evt_2", type: "BILLING_ISSUE", event_timestamp_ms: NOW_MS + 1 })));
    expect(calls).toEqual([`refund@${NOW_MS}`, `event@${NOW_MS + 1}`]);
  });

  it("an expiration returns the workspace to free", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ type: "EXPIRATION" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: null, status: "canceled", cancel_at_period_end: false }));
    expect(deps.setMonthlyCredits).toHaveBeenCalledTimes(1);
    expect(deps.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("a billing issue marks past_due and keeps the tier", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ type: "BILLING_ISSUE" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: "growth", status: "past_due" }));
    expect(deps.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("strips the Google base plan when mapping the tier", async () => {
    const { handler, deps } = build();
    await send(handler, makeReq(event({ product_id: "zavi_pro_6mo:6mo" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: "pro", store_product_id: "zavi_pro_6mo:6mo" }));
  });
});

describe("repeats, ordering and conflicts", () => {
  it("skips an event it has already processed", async () => {
    const { handler, deps } = build({ eventProcessed: vi.fn().mockResolvedValue(true) });
    const res = await send(handler, makeReq(event()));
    expect(res.body).toMatchObject({ duplicate: "evt_1" });
    expect(deps.applyState).not.toHaveBeenCalled();
  });

  it("re-runs the credit refresh when the write path reports a replay", async () => {
    const { handler, deps } = build({ applyState: vi.fn().mockResolvedValue({ error: null, outcome: "replay" }) });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(200);
    expect(deps.setMonthlyCredits).toHaveBeenCalledTimes(1);
    expect(deps.markProcessed).toHaveBeenCalled();
  });

  it("acknowledges a stale event quietly and does nothing else", async () => {
    const { handler, deps } = build({ applyState: vi.fn().mockResolvedValue({ error: null, outcome: "stale" }) });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(200);
    expect(deps.setMonthlyCredits).not.toHaveBeenCalled();
    expect(deps.markProcessed).toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it.each(["stripe_active", "refund_blocked", "store_account_in_use", "grandfathered"] as StoreOutcome[])(
    "a %s conflict is logged as an error, acknowledged, and grants nothing",
    async (outcome) => {
      const { handler, deps } = build({ applyState: vi.fn().mockResolvedValue({ error: null, outcome }) });
      const res = await send(handler, makeReq(event()));
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ outcome });
      expect(deps.setMonthlyCredits).not.toHaveBeenCalled();
      expect(deps.requestPreviewRerun).not.toHaveBeenCalled();
      expect(mocks.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", code: "store_state_conflict", tenant_id: TENANT }),
      );
    },
  );
});

describe("failures are retried, never recorded", () => {
  it("500s when the write path fails", async () => {
    const { handler, deps } = build({ applyState: vi.fn().mockResolvedValue({ error: { message: "db down" }, outcome: null }) });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(500);
    expect(errCode(res)).toBe("apply_failed");
    expect(deps.markProcessed).not.toHaveBeenCalled();
  });

  it("500s when the credit refresh fails", async () => {
    const { handler, deps } = build({ setMonthlyCredits: vi.fn().mockResolvedValue({ error: { message: "rpc failed" } }) });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(500);
    expect(errCode(res)).toBe("set_credits_failed");
    expect(deps.markProcessed).not.toHaveBeenCalled();
  });

  it("500s when the preview rerun cannot be queued", async () => {
    const { handler, deps } = build({ requestPreviewRerun: vi.fn().mockRejectedValue(new Error("queue down")) });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(500);
    expect(errCode(res)).toBe("preview_rerun_request_failed");
    expect(deps.markProcessed).not.toHaveBeenCalled();
  });

  it("500s when a lookup throws", async () => {
    const { handler } = build({ resolveTenantByBinding: vi.fn().mockRejectedValue(new Error("read failed")) });
    const res = await send(handler, makeReq(event()));
    expect(res.statusCode).toBe(500);
    expect(errCode(res)).toBe("internal");
  });
});

describe("refund reversal", () => {
  it("asks the write path to lift the refund block, then refreshes credits", async () => {
    const { handler, deps } = build({ resolveTenantByStoreUser: vi.fn().mockResolvedValue(TENANT) });
    const res = await send(handler, makeReq(event({ type: "REFUND_REVERSED" })));
    expect(res.statusCode).toBe(200);
    expect(deps.applyState).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, refund_reversed: true, tier: "growth", status: "active" }),
    );
    expect(deps.setMonthlyCredits).toHaveBeenCalledWith(TENANT, Math.floor(NOW_MS / 1000));
    expect(deps.markProcessed).toHaveBeenCalledWith("evt_1", "REFUND_REVERSED");
  });

  it("a reversal for a period that already ended lifts the block but restores no plan", async () => {
    const { handler, deps } = build({ resolveTenantByStoreUser: vi.fn().mockResolvedValue(TENANT) });
    await send(handler, makeReq(event({ type: "REFUND_REVERSED", expiration_at_ms: NOW_MS - 1 })));
    expect(deps.applyState).toHaveBeenCalledWith(
      expect.objectContaining({ refund_reversed: true, tier: null, status: "canceled" }),
    );
    expect(deps.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("no other event asks to lift the block", async () => {
    const { handler, deps } = build({ resolveTenantByStoreUser: vi.fn().mockResolvedValue(TENANT) });
    await send(handler, makeReq(event({ type: "RENEWAL" })));
    expect(deps.applyState).toHaveBeenCalledWith(expect.objectContaining({ refund_reversed: false }));
  });

  it("a replayed reversal is not re-applied", async () => {
    const { handler, deps } = build({ eventProcessed: vi.fn().mockResolvedValue(true) });
    const res = await send(handler, makeReq(event({ type: "REFUND_REVERSED" })));
    expect(res.body).toMatchObject({ duplicate: "evt_1" });
    expect(deps.applyState).not.toHaveBeenCalled();
  });
});
