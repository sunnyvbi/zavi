
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sgMock = vi.hoisted(() => ({
  setApiKey: vi.fn(),
  send: vi.fn(async (..._a: unknown[]) => [
    { headers: { "x-message-id": "sys-1" }, statusCode: 202 },
    {},
  ]),
}));
vi.mock("@sendgrid/mail", () => ({
  default: sgMock,
  setApiKey: sgMock.setApiKey,
  send: sgMock.send,
}));

vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async () => {
    throw new Error("REGRESSION: AgentMail reply must NOT read the tenant vault key");
  }),
}));

const SUPPRESSED = "bob@acme.com";
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "is_email_suppressed") {
        const a = String(args?.p_email ?? "").toLowerCase();
        return { data: a === SUPPRESSED ? "unsubscribed" : null, error: null };
      }
      return { data: null, error: null };
    }),
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { sendAgentMailReply } from "../sendAgentMailReply";

function sent(): Record<string, unknown> {
  return sgMock.send.mock.calls[0][0] as Record<string, unknown>;
}

const ORIG = { ...process.env };
beforeEach(() => {
  sgMock.send.mockClear();
  sgMock.setApiKey.mockClear();
  process.env.SYSTEM_SENDGRID_API_KEY = "SG.system";
  process.env.ZAVI_EMAIL_FROM = "system@zaviagent.com";
});
afterEach(() => {
  process.env = { ...ORIG };
});

describe("sendAgentMailReply — Zavi's own sender, never the tenant's", () => {
  it("sends even though the tenant has NO email connector", async () => {
    const r = await sendAgentMailReply({
      tenant_id: "t-no-connector",
      to: "ravi@upcar.ai",
      subject: "Re: how many hosts?",
      body_text: "247 active hosts right now.",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect(r.sent).toBe(true);
    expect(sgMock.setApiKey).toHaveBeenCalledWith("SG.system");
  });

  it("From is the AUTHENTICATED system sender; the agent address rides in Reply-To", async () => {
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect((sent().from as { email: string }).email).toBe("upcarai@inbox.zaviagent.com");
    expect((sent().replyTo as { email: string }).email).toBe("upcarai@inbox.zaviagent.com");
  });

  it("falls back to the system sender when the flag is off (reversible without deploy)", async () => {
    process.env.AGENTMAIL_FROM_IDENTITY = "0";
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect((sent().from as { email: string }).email).toBe("system@zaviagent.com");
    delete process.env.AGENTMAIL_FROM_IDENTITY;
  });

  it("falls back to the system sender for a non-inbox reply_to (unauthenticated domain)", async () => {
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "someone@random-domain.com",
    });
    expect((sent().from as { email: string }).email).toBe("system@zaviagent.com");
  });

  it("threads the reply (In-Reply-To + References)", async () => {
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
      in_reply_to: "<a@x>",
      references: ["<a@x>", "<b@x>"],
    });
    const h = sent().headers as Record<string, string>;
    expect(h["In-Reply-To"]).toBe("<a@x>");
    expect(h["References"]).toBe("<a@x> <b@x>");
  });

  it("brackets bare ids in In-Reply-To + References and keeps bracketed ones as-is", async () => {
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
      in_reply_to: "CAbc123@mail.gmail.com",
      references: ["zavi-root@inbox.zaviagent.com", "<CAbc123@mail.gmail.com>", "  "],
    });
    const h = sent().headers as Record<string, string>;
    expect(h["In-Reply-To"]).toBe("<CAbc123@mail.gmail.com>");
    expect(h["References"]).toBe("<zavi-root@inbox.zaviagent.com> <CAbc123@mail.gmail.com>");
  });

  it("always sets a Message-ID on the From domain and returns it (not SendGrid's x-message-id)", async () => {
    const r = await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    const h = sent().headers as Record<string, string>;
    expect(h["Message-ID"]).toMatch(/^<zavi-[0-9a-f-]+@inbox\.zaviagent\.com>$/);
    expect(r).toEqual({ sent: true, messageId: h["Message-ID"] });
  });

  it("sends under a caller-given Message-ID", async () => {
    const r = await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
      message_id: "given-1@inbox.zaviagent.com",
    });
    expect((sent().headers as Record<string, string>)["Message-ID"]).toBe("<given-1@inbox.zaviagent.com>");
    expect(r).toEqual({ sent: true, messageId: "<given-1@inbox.zaviagent.com>" });
  });

  it("CCs the other humans on the thread, excluding ourselves", async () => {
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      cc: [
        "carol@acme.com",
        "upcarai@inbox.zaviagent.com",
        "system@zaviagent.com",
        "ravi@upcar.ai",
      ],
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect(sent().cc).toEqual(["carol@acme.com"]);
  });

  it("drops a suppressed CC without killing the reply to everyone else", async () => {
    await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      cc: ["carol@acme.com", SUPPRESSED],
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect(sent().cc).toEqual(["carol@acme.com"]);
    expect(sent().to).toBe("ravi@upcar.ai");
  });

  it("does not mail a suppressed primary recipient", async () => {
    const r = await sendAgentMailReply({
      tenant_id: "t1",
      to: SUPPRESSED,
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect(r).toEqual({ sent: false, reason: "recipient_suppressed" });
    expect(sgMock.send).not.toHaveBeenCalled();
  });

  it("refuses (does not throw, does not pretend) when the system sender is unset", async () => {
    delete process.env.SYSTEM_SENDGRID_API_KEY;
    const r = await sendAgentMailReply({
      tenant_id: "t1",
      to: "ravi@upcar.ai",
      subject: "Re: x",
      body_text: "hi",
      reply_to: "upcarai@inbox.zaviagent.com",
    });
    expect(r).toEqual({ sent: false, reason: "system_sender_unset" });
    expect(sgMock.send).not.toHaveBeenCalled();
  });
});
