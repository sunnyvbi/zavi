import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  suppressEmail: vi.fn(),
  recordBulkFeedback: vi.fn(),
  resolveBulkRecipientTenant: vi.fn(),
  logInsert: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  rpc: vi.fn(async (_name: string, _args: unknown) => ({ data: { ok: true } as unknown, error: null as unknown })),
  alerts: vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: true, error: null })),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: h.logInsert, logEventConfirmed: h.logInsert }));
vi.mock("@/services/creators/creator-invites", () => ({ markInviteBounced: vi.fn() }));
vi.mock("@/services/tools/email/safety-net", () => ({ suppressEmail: h.suppressEmail }));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    rpc: (name: string, args: unknown) => (name === "enqueue_ops_alert" ? h.alerts(name, args) : h.rpc(name, args)),
  }),
}));
vi.mock("@/services/comms/bulk-outbound/feedback", async (importOriginal) => ({
  bulkFeedbackKind: (await importOriginal<typeof import("@/services/comms/bulk-outbound/feedback")>()).bulkFeedbackKind,
  recordBulkFeedback: h.recordBulkFeedback,
  resolveBulkRecipientTenant: h.resolveBulkRecipientTenant,
}));

import { bulkEngagementEvents, sendgridEventsWebhook, sendgridWebhookPublicKeys } from "@/routes/webhooks/sendgrid-events";

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const b64 = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  return { b64, privateKey };
}
const system = keyPair();
const bulk = keyPair();
const stranger = keyPair();

function signedReq(events: unknown[], key: crypto.KeyObject): Request {
  const body = Buffer.from(JSON.stringify(events));
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign("sha256", Buffer.concat([Buffer.from(ts), body]), { key, dsaEncoding: "der" }).toString("base64");
  const headers: Record<string, string> = {
    "x-twilio-email-event-webhook-signature": sig,
    "x-twilio-email-event-webhook-timestamp": ts,
  };
  return { body, header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: any } & Record<string, unknown>;
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r as unknown as Response & { statusCode: number; body: any };
}

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND = "00000000-0000-4000-8000-000000000001";
const bounce = (over: Record<string, unknown> = {}) => ({ email: "A@B.example", event: "bounce", type: "bounce", tenant_id: TENANT, ...over });

beforeEach(() => {
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = system.b64;
  process.env.BULK_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = bulk.b64;
  h.suppressEmail.mockReset().mockResolvedValue("tok");
  h.recordBulkFeedback.mockReset().mockResolvedValue({ counted: true, tripped: false });
  h.resolveBulkRecipientTenant.mockReset().mockResolvedValue(TENANT);
  h.logInsert.mockClear();
  h.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  h.alerts.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => {
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  delete process.env.BULK_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
});

describe("webhook signing keys", () => {
  it("accepts an event signed by either configured key", async () => {
    for (const key of [system.privateKey, bulk.privateKey]) {
      const r = res();
      await sendgridEventsWebhook(signedReq([bounce()], key), r);
      expect(r.statusCode).toBe(200);
    }
    expect(h.suppressEmail).toHaveBeenCalledTimes(2);
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "a@b.example", "bounce");
  });

  it("works with only the bulk key configured", async () => {
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    const ok = res();
    await sendgridEventsWebhook(signedReq([bounce()], bulk.privateKey), ok);
    expect(ok.statusCode).toBe(200);
    const no = res();
    await sendgridEventsWebhook(signedReq([bounce()], system.privateKey), no);
    expect(no.statusCode).toBe(403);
  });

  it("rejects a key that is not configured, before any write", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce()], stranger.privateKey), r);
    expect(r.statusCode).toBe(403);
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(h.recordBulkFeedback).not.toHaveBeenCalled();
  });

  it("answers 503 when no key is configured", async () => {
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    delete process.env.BULK_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce()], bulk.privateKey), r);
    expect(r.statusCode).toBe(503);
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(sendgridWebhookPublicKeys({ SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: " ", BULK_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "" })).toEqual([]);
  });
});

describe("a failed suppression write", () => {
  it("answers 5xx so SendGrid retries, after still processing the rest of the batch", async () => {
    h.suppressEmail.mockRejectedValueOnce(new Error("db down")).mockResolvedValue("tok");
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce({ email: "first@b.example" }), bounce({ email: "second@b.example" })], bulk.privateKey), r);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: { code: "suppression_write_failed", message: "retry the batch" } });
    expect(h.suppressEmail).toHaveBeenCalledTimes(2);
    expect(h.suppressEmail).toHaveBeenLastCalledWith(TENANT, "second@b.example", "bounce");
  });

  it("a batch with no failures still answers 200", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce(), { email: "a@b.example", event: "delivered", tenant_id: TENANT }], bulk.privateKey), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ received: 2, suppressed: 1, skipped: 1 });
  });
});

describe("abuse counters for a bulk send", () => {
  it("a hard bounce and a spam report on a bulk send are counted against that send", async () => {
    const r = res();
    await sendgridEventsWebhook(
      signedReq([bounce({ bulk_send_id: SEND }), { email: "c@b.example", event: "spamreport", tenant_id: TENANT, bulk_send_id: SEND }], bulk.privateKey),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(h.recordBulkFeedback.mock.calls.map((c) => c[0])).toEqual([
      { tenantId: TENANT, sendId: SEND, email: "a@b.example", kind: "hard_bounce" },
      { tenantId: TENANT, sendId: SEND, email: "c@b.example", kind: "complaint" },
    ]);
  });

  it("a blocked bounce and a message-level drop never suppress or count; a non-bulk hard bounce suppresses but is not counted", async () => {
    const r = res();
    await sendgridEventsWebhook(
      signedReq([bounce({ type: "blocked", bulk_send_id: SEND }), { email: "d@b.example", event: "dropped", reason: "Invalid SMTPAPI header", tenant_id: TENANT, bulk_send_id: SEND }, bounce({ email: "e@b.example" })], bulk.privateKey),
      r,
    );
    expect(h.suppressEmail).toHaveBeenCalledTimes(1);
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "e@b.example", "bounce");
    expect(h.recordBulkFeedback).not.toHaveBeenCalled();
  });

  it("a failed count answers 5xx so the batch comes back", async () => {
    h.recordBulkFeedback.mockRejectedValue(new Error("db down"));
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce({ bulk_send_id: SEND })], bulk.privateKey), r);
    expect(r.statusCode).toBe(500);
  });
});

describe("own sender engagement (email results)", () => {
  const ev = (event: string, over: Record<string, unknown> = {}) => ({ email: "pat@example.test", event, sg_event_id: `id-${event}-${Math.random()}`, tenant_id: TENANT, bulk_send_id: SEND, ...over });

  it("delivered, open, machine open and click become counts by event id; no address leaves the handler", () => {
    const out = bulkEngagementEvents([ev("delivered"), ev("open"), ev("open", { sg_machine_open: true }), ev("click"), ev("processed"), ev("open", { bulk_send_id: undefined }), ev("open", { sg_event_id: undefined })] as never);
    expect(out.map((e) => e.kind)).toEqual(["delivered", "open", "machine_open", "click"]);
    expect(JSON.stringify(out)).not.toContain("pat@example.test");
  });

  it("one RPC per batch; a failed write asks SendGrid to retry", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([ev("delivered"), ev("open"), bounce()], bulk.privateKey), r);
    expect(r.statusCode).toBe(200);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0][0]).toBe("email_bulk_record_events");
    expect((h.rpc.mock.calls[0][1] as { p_events: unknown[] }).p_events).toHaveLength(2);

    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    const fail = res();
    await sendgridEventsWebhook(signedReq([ev("open")], bulk.privateKey), fail);
    expect(fail.statusCode).toBe(500);
  });

  it("a batch with no engagement event makes no RPC", async () => {
    await sendgridEventsWebhook(signedReq([bounce()], bulk.privateKey), res());
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("a bulk bounce or complaint belongs to the workspace our send records say", () => {
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("the tenant comes from the send's recipient row (send id + address), not the custom arg", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce({ bulk_send_id: SEND, tenant_id: undefined })], bulk.privateKey), r);
    expect(r.statusCode).toBe(200);
    expect(h.resolveBulkRecipientTenant).toHaveBeenCalledWith(SEND, "a@b.example");
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "a@b.example", "bounce");
    expect(h.recordBulkFeedback).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, sendId: SEND }));
  });

  it("must catch: an event claiming another workspace is dropped (nothing suppressed or counted for anyone) and alerted once per send", async () => {
    const r = res();
    await sendgridEventsWebhook(
      signedReq([bounce({ bulk_send_id: SEND, tenant_id: OTHER }), { email: "c@b.example", event: "spamreport", tenant_id: OTHER, bulk_send_id: SEND }], bulk.privateKey),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ suppressed: 0, skipped: 2 });
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(h.recordBulkFeedback).not.toHaveBeenCalled();
    expect(h.alerts).toHaveBeenCalledTimes(1);
    const [name, args] = h.alerts.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("enqueue_ops_alert");
    expect(args).toMatchObject({ p_dedupe_key: `sendgrid_bulk_event_dropped:${SEND}`, p_tenant_id: TENANT });
    expect(String(args.p_msg)).toContain("2 event(s) claimed another workspace");
    expect(String(args.p_msg)).not.toMatch(/@/);
  });

  it("an event whose send and address match no recipient is dropped and alerted", async () => {
    h.resolveBulkRecipientTenant.mockResolvedValue(null);
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce({ bulk_send_id: SEND })], bulk.privateKey), r);
    expect(r.statusCode).toBe(200);
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(h.alerts).toHaveBeenCalledTimes(1);
    expect(String((h.alerts.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_msg)).toContain("1 matched no recipient");
  });

  it("our records cannot be read: 5xx so the batch comes back, nothing suppressed on a guess", async () => {
    h.resolveBulkRecipientTenant.mockRejectedValue(new Error("db down"));
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce({ bulk_send_id: SEND })], bulk.privateKey), r);
    expect(r.statusCode).toBe(500);
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(h.alerts).not.toHaveBeenCalled();
  });

  it("a tenant-lane event (no bulk send id) is unchanged: its tenant_id, no lookup", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce()], system.privateKey), r);
    expect(h.resolveBulkRecipientTenant).not.toHaveBeenCalled();
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "a@b.example", "bounce");
  });
});

describe("the dropped-event alert and log", () => {
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const mismatch = () => signedReq([bounce({ bulk_send_id: SEND, tenant_id: OTHER })], bulk.privateKey);

  it("the log row carries its level and source, and is written once per send: a redelivered batch adds nothing", async () => {
    await sendgridEventsWebhook(mismatch(), res());
    expect(h.logInsert).toHaveBeenCalledTimes(1);
    expect(h.logInsert.mock.calls[0][0]).toMatchObject({ level: "warn", source: "sendgrid-events", code: "email.suppression.bulk_event_dropped", tenant_id: TENANT });
    h.alerts.mockResolvedValue({ data: false, error: null });
    const again = res();
    await sendgridEventsWebhook(mismatch(), again);
    expect(again.statusCode).toBe(200);
    expect(h.logInsert).toHaveBeenCalledTimes(1);
  });

  it("an alert that could not be queued answers 5xx (the retry is safe: same outbox key)", async () => {
    h.alerts.mockResolvedValue({ data: null, error: { message: "down" } });
    const r = res();
    await sendgridEventsWebhook(mismatch(), r);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: { code: "alert_write_failed", message: "retry the batch" } });
    expect(h.suppressEmail).not.toHaveBeenCalled();
  });

  it("an unattributed event is logged with its level and source", async () => {
    await sendgridEventsWebhook(signedReq([bounce({ tenant_id: undefined })], system.privateKey), res());
    expect(h.logInsert).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", source: "sendgrid-events", code: "email.suppression.unattributed" }));
  });
});

describe("the dropped-event alert's workspace label", () => {
  it("takes the owner a later event of the same send resolved, when the first matched no one", async () => {
    const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    h.resolveBulkRecipientTenant.mockResolvedValueOnce(null).mockResolvedValueOnce(TENANT);
    await sendgridEventsWebhook(
      signedReq([bounce({ bulk_send_id: SEND, email: "gone@b.example" }), bounce({ bulk_send_id: SEND, tenant_id: OTHER })], bulk.privateKey),
      res(),
    );
    expect(h.alerts).toHaveBeenCalledTimes(1);
    expect((h.alerts.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({ p_tenant_id: TENANT });
    expect(String((h.alerts.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_msg)).toContain("1 event(s) claimed another workspace, 1 matched no recipient");
  });

  it("takes the owner from a normal (not dropped) event of the same send", async () => {
    h.resolveBulkRecipientTenant.mockResolvedValueOnce(null).mockResolvedValueOnce(TENANT);
    await sendgridEventsWebhook(signedReq([bounce({ bulk_send_id: SEND, email: "gone@b.example" }), bounce({ bulk_send_id: SEND })], bulk.privateKey), res());
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "a@b.example", "bounce");
    expect(h.alerts).toHaveBeenCalledTimes(1);
    const args = (h.alerts.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(args).toMatchObject({ p_tenant_id: TENANT });
    expect(String(args.p_msg)).toContain("0 event(s) claimed another workspace, 1 matched no recipient");
  });
});

describe("only a hard bounce or an address-level drop suppresses for good", () => {
  const drop = (email: string, reason: string) => ({ email, event: "dropped", reason, tenant_id: TENANT });

  it("a soft blocked bounce leaves the address mailable and the batch answers 200", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([bounce({ email: "soft@b.example", type: "blocked", reason: "421 try again later" })], bulk.privateKey), r);
    expect(r.statusCode).toBe(200);
    expect(h.suppressEmail).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ received: 1, suppressed: 0, skipped: 1 });
  });

  it("drops about the address suppress; drops about the message or account do not", async () => {
    const r = res();
    await sendgridEventsWebhook(
      signedReq(
        [
          drop("bounced@b.example", "Bounced Address"),
          drop("invalid@b.example", "Invalid"),
          drop("unsub@b.example", "Unsubscribed Address"),
          drop("spam@b.example", "Spam Reporting Address"),
          drop("hdr@b.example", "Invalid SMTPAPI header"),
          drop("credits@b.example", "Exceeded credits"),
          drop("nocontent@b.example", "Missing content"),
          drop("blank@b.example", ""),
          drop("proto@b.example", "constructor"),
        ],
        bulk.privateKey,
      ),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(Object.fromEntries(h.suppressEmail.mock.calls.map((c) => [c[1], c[2]]))).toEqual({
      "bounced@b.example": "bounce",
      "invalid@b.example": "bounce",
      "unsub@b.example": "unsubscribe",
      "spam@b.example": "complaint",
    });
    expect(r.body).toMatchObject({ received: 9, suppressed: 4, skipped: 5 });
  });

  it("a hard bounce with type bounce and a spam report still suppress", async () => {
    const r = res();
    await sendgridEventsWebhook(
      signedReq([bounce({ email: "hard@b.example", type: "bounce" }), { email: "c@b.example", event: "spamreport", tenant_id: TENANT }], bulk.privateKey),
      r,
    );
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "hard@b.example", "bounce");
    expect(h.suppressEmail).toHaveBeenCalledWith(TENANT, "c@b.example", "complaint");
  });
});
