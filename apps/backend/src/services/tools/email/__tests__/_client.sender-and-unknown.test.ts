import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(),
  setApiKey: vi.fn(),
  secrets: {} as Record<string, string | null>,
  pinned: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@sendgrid/mail", () => ({ default: { setApiKey: m.setApiKey, send: m.send }, setApiKey: m.setApiKey, send: m.send }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async (_t: string, k: string) => m.secrets[k] ?? null) }));
vi.mock("@/services/comms/bulk-outbound/readiness", () => ({ readEmailSettingText: m.pinned }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(async (name: string) => {
      const data: Record<string, unknown> = {
        is_email_suppressed: null,
        get_or_create_unsub_token: "tok-1",
        touch_domain_warmup: 0,
        consume_email_send_or_reject: true,
      };
      return { data: data[name], error: null };
    }),
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  }),
}));

import { emailSend, EMAIL_FROM_NOT_SET_MESSAGE, EMAIL_SENDER_UNREADABLE_MESSAGE, SENDGRID_UNCONFIRMED } from "../_client";

const senders = (rows: Array<Record<string, unknown>>) =>
  new Response(JSON.stringify({ results: rows }), { status: 200, headers: { "content-type": "application/json" } });
const ONE = { id: 11, from_email: "maya@bakery.com", from_name: "Maya at Bakery", verified: true };
const TWO = { id: 22, from_email: "hello@bakery.com", from_name: "Bakery", verified: true };
const MSG = { to: "parent@example.com", subject: "Trial", body_text: "Book here." };
const FALLBACK = { verifiedSenderFallback: true };

beforeEach(() => {
  m.send.mockReset().mockResolvedValue([{ headers: { "x-message-id": "sg-1" }, statusCode: 202 }, {}]);
  m.secrets = { "email.api_key": "SG.key" };
  m.pinned.mockReset().mockResolvedValue(null);
  m.fetch.mockReset().mockResolvedValue(senders([ONE]));
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const sentFrom = () => (m.send.mock.calls[0][0] as { from: { email: string; name: string } }).from;

describe("emailSend picks a sender for a key saved through today's SendGrid form (no stored from-address)", () => {
  it("sends as the account's one verified sender, read with the workspace's own key", async () => {
    const r = await emailSend("t-1", MSG, FALLBACK);

    expect(r.messageId).toBe("sg-1");
    expect(sentFrom()).toEqual({ email: "maya@bakery.com", name: "Maya at Bakery" });
    expect(String(m.fetch.mock.calls[0][0])).toContain("/v3/verified_senders");
    expect((m.fetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer SG.key");
    expect(m.pinned).toHaveBeenCalledWith("t-1", "sendgrid_sender_id");
  });

  it("with several verified senders, sends as the one picked in Email campaigns settings", async () => {
    m.fetch.mockResolvedValue(senders([ONE, TWO]));
    m.pinned.mockResolvedValue("22");

    await emailSend("t-1", MSG, FALLBACK);

    expect(sentFrom()).toEqual({ email: "hello@bakery.com", name: "Bakery" });
  });

  it.each([
    ["several verified senders and none picked", () => m.fetch.mockResolvedValue(senders([ONE, TWO]))],
    ["the picked sender is no longer verified", () => { m.fetch.mockResolvedValue(senders([ONE, { ...TWO, verified: false }])); m.pinned.mockResolvedValue("22"); }],
    ["no verified sender at all", () => m.fetch.mockResolvedValue(senders([{ ...ONE, verified: false }]))],
    ["the key cannot read senders", () => m.fetch.mockResolvedValue(new Response("{}", { status: 403 }))],
    ["SendGrid cannot be reached", () => m.fetch.mockRejectedValue(new TypeError("fetch failed"))],
  ])("%s: nothing is sent and the reason is plain, with no page that does not exist", async (_label, arrange) => {
    arrange();

    const err = await emailSend("t-1", MSG, FALLBACK).then(() => { throw new Error("emailSend resolved"); }, (e: unknown) => e as { code: string; message: string });

    expect(err).toMatchObject({ code: "email_from_not_set", message: EMAIL_FROM_NOT_SET_MESSAGE });
    expect(err.message).not.toMatch(/\/connectors|from-address/);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("a stored from-address still wins and SendGrid's senders are never read", async () => {
    m.secrets["email.from_address"] = "ops@legacy.com";

    await emailSend("t-1", MSG, FALLBACK);

    expect(sentFrom().email).toBe("ops@legacy.com");
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("an agent's from_override still wins and SendGrid's senders are never read", async () => {
    await emailSend("t-1", { ...MSG, from_override: "agent@bakery.com" }, FALLBACK);

    expect(sentFrom().email).toBe("agent@bakery.com");
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it("a failed read of the picked sender refuses, never falling back to SendGrid's default sender", async () => {
    m.fetch.mockResolvedValue(senders([ONE, TWO]));
    m.pinned.mockRejectedValue(new Error("get_channel_settings failed"));

    const err = await emailSend("t-1", MSG, FALLBACK).then(() => { throw new Error("emailSend resolved"); }, (e: unknown) => e as { code: string; message: string });

    expect(err).toMatchObject({ code: "email_sender_unreadable", message: EMAIL_SENDER_UNREADABLE_MESSAGE });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("without the fallback (investor emails), no stored from-address stops as before and SendGrid's senders are never read", async () => {
    const err = await emailSend("t-1", MSG).catch((e: unknown) => e as { code: string });

    expect(err).toMatchObject({ code: "email_from_not_set" });
    expect(m.pinned).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("emailSend tells a lost answer apart from a refusal", () => {
  it.each([
    ["a socket hang up after the request went out", Object.assign(new Error("socket hang up"), { isAxiosError: true, code: "ECONNRESET", request: {} })],
    ["a timeout", Object.assign(new Error("timeout of 0ms exceeded"), { isAxiosError: true, code: "ECONNABORTED", request: {} })],
    ["a SendGrid 503", Object.assign(new Error("Service Unavailable"), { code: 503, response: { body: {} } })],
  ])("%s: may have gone out, never a definite failure with the raw error", async (_label, e) => {
    m.secrets["email.from_address"] = "ops@legacy.com";
    m.send.mockRejectedValue(e);

    const err = await emailSend("t-1", MSG).then(() => { throw new Error("emailSend resolved"); }, (x: unknown) => x as { code: string; message: string });

    expect(err).toMatchObject({ code: "email_send_outcome_unknown", message: SENDGRID_UNCONFIRMED });
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a SendGrid 400", Object.assign(new Error("Bad Request"), { code: 400, response: { body: { errors: [] } } })],
    ["a SendGrid 403", Object.assign(new Error("Forbidden"), { code: 403, response: { body: {} } })],
    ["a local error before any request", new Error("Provide at least one of to, cc or bcc")],
  ])("%s: a definite failure", async (_label, e) => {
    m.secrets["email.from_address"] = "ops@legacy.com";
    m.send.mockRejectedValue(e);

    const err = await emailSend("t-1", MSG).then(() => { throw new Error("emailSend resolved"); }, (x: unknown) => x as { code: string; message: string });

    expect(err.code).toBe("email_send_failed");
    expect(err.message).toBe((e as Error).message);
  });
});
