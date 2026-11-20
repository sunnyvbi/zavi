
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({ markInviteBounced: vi.fn(), suppressEmail: vi.fn(), logInsert: vi.fn(async (..._a: unknown[]) => ({ ok: true })) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: h.logInsert, logEventConfirmed: h.logInsert }));
vi.mock("@/services/creators/creator-invites", () => ({ markInviteBounced: h.markInviteBounced }));
vi.mock("@/services/tools/email/safety-net", () => ({ suppressEmail: h.suppressEmail }));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({}),
}));

import { sendgridEventsWebhook } from "@/routes/webhooks/sendgrid-events";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_B64 = publicKey
  .export({ type: "spki", format: "pem" })
  .toString()
  .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
  .replace(/\s+/g, "");

function signedReq(events: unknown[], key = privateKey): Request {
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

const INVITE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = PUBLIC_B64;
  h.markInviteBounced.mockReset().mockResolvedValue(undefined);
  h.suppressEmail.mockReset().mockResolvedValue(undefined);
  h.logInsert.mockClear();
});
afterEach(() => {
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
});

describe("SendGrid events for creator invites", () => {
  it("a bounce on an invite is recorded on the invite, not counted as unattributed", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([{ email: "a@b.example", event: "bounce", reason: "550 no such user", creator_invite_id: INVITE }]), r);
    expect(r.statusCode).toBe(200);
    expect(h.markInviteBounced).toHaveBeenCalledWith(INVITE, "bounce: 550 no such user");
    expect(r.body).toMatchObject({ invite_bounces: 1, unattributed: 0, suppressed: 0 });
    expect(h.suppressEmail).not.toHaveBeenCalled();
  });

  it("a spam report on an invite is recorded too; delivered/open events are ignored", async () => {
    const r = res();
    await sendgridEventsWebhook(
      signedReq([
        { email: "a@b.example", event: "spamreport", creator_invite_id: INVITE },
        { email: "a@b.example", event: "delivered", creator_invite_id: INVITE },
      ]),
      r,
    );
    expect(h.markInviteBounced).toHaveBeenCalledTimes(1);
    expect(h.markInviteBounced.mock.calls[0][1]).toMatch(/^complaint/);
  });

  it("a failed invite write answers 500 so SendGrid retries the batch", async () => {
    h.markInviteBounced.mockRejectedValue(new Error("db down"));
    const r = res();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendgridEventsWebhook(
      signedReq([
        { email: "a@b.example", event: "dropped", reason: "Bounced Address", creator_invite_id: INVITE },
        { email: "c@d.example", event: "bounce" },
      ]),
      r,
    );
    expect(r.statusCode).toBe(500);
    expect(h.logInsert).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("tenant events still go to tenant suppression", async () => {
    const r = res();
    await sendgridEventsWebhook(signedReq([{ email: "a@b.example", event: "bounce", tenant_id: "t1" }]), r);
    expect(h.suppressEmail).toHaveBeenCalledWith("t1", "a@b.example", "bounce");
    expect(h.markInviteBounced).not.toHaveBeenCalled();
  });

  it("a forged invite event is rejected before any write", async () => {
    const attacker = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const r = res();
    await sendgridEventsWebhook(signedReq([{ email: "a@b.example", event: "spamreport", creator_invite_id: INVITE }], attacker), r);
    expect(r.statusCode).toBe(403);
    expect(h.markInviteBounced).not.toHaveBeenCalled();
  });
});
