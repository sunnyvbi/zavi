
import { describe, it, expect, vi, beforeEach } from "vitest";

const sgMock = vi.hoisted(() => ({
  setApiKey: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => [
    { headers: { "x-message-id": "m-1" }, statusCode: 202 },
    {},
  ]),
}));
vi.mock("@sendgrid/mail", () => ({
  default: sgMock,
  setApiKey: sgMock.setApiKey,
  send: sgMock.send,
}));
vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async (_t: string, k: string) =>
    k === "email.api_key"
      ? "SG.test"
      : k === "email.from_address"
        ? "ops@example.com"
        : "Zavi",
  ),
}));

const SUPPRESSED = "bob@acme.com";
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "is_email_suppressed") {
        const addr = String(args?.p_email ?? args?.p_address ?? "").toLowerCase();
        return { data: addr === SUPPRESSED ? "unsubscribed" : null, error: null };
      }
      const data: Record<string, unknown> = {
        get_or_create_unsub_token: "tok-replyall",
        touch_domain_warmup: 0,
        consume_email_send_or_reject: true,
      };
      return { data: data[name], error: null };
    }),
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  }),
}));

import { emailSend } from "../_client";

function sentMsg(): Record<string, unknown> {
  return sgMock.send.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  sgMock.send.mockClear();
});

describe("emailSend — reply-all CC audience", () => {
  it("CCs the other humans on the thread", async () => {
    await emailSend("t-1", {
      to: "jane@acme.com",
      cc: ["carol@acme.com", "dave@partner.com"],
      subject: "Re: booking",
      body_text: "here you go",
      reply_to: "upcar@inbox.zaviagent.com",
    });
    expect(sentMsg().cc).toEqual(["carol@acme.com", "dave@partner.com"]);
  });

  it("DROPS a suppressed participant but still sends to everyone else", async () => {
    await emailSend("t-1", {
      to: "jane@acme.com",
      cc: ["carol@acme.com", SUPPRESSED],
      subject: "Re: booking",
      body_text: "here you go",
      reply_to: "upcar@inbox.zaviagent.com",
    });
    expect(sentMsg().cc).toEqual(["carol@acme.com"]);
    expect(sentMsg().to).toBe("jane@acme.com");
  });

  it("never CCs our OWN address (no self-mail loop)", async () => {
    await emailSend("t-1", {
      to: "jane@acme.com",
      cc: [
        "upcar@inbox.zaviagent.com",
        "ops@example.com",
        "carol@acme.com",
      ],
      subject: "Re: booking",
      body_text: "here you go",
      reply_to: "upcar@inbox.zaviagent.com",
    });
    expect(sentMsg().cc).toEqual(["carol@acme.com"]);
  });

  it("never CCs the primary To, and de-dupes case-insensitively", async () => {
    await emailSend("t-1", {
      to: "jane@acme.com",
      cc: ["JANE@acme.com", "carol@acme.com", "Carol@ACME.com"],
      subject: "Re: booking",
      body_text: "here you go",
    });
    expect(sentMsg().cc).toEqual(["carol@acme.com"]);
  });

  it("omits cc entirely when there is nobody else on the thread", async () => {
    await emailSend("t-1", {
      to: "jane@acme.com",
      subject: "Re: booking",
      body_text: "here you go",
    });
    expect(sentMsg().cc).toBeUndefined();
  });
});
