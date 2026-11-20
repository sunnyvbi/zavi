
import { describe, it, expect, vi, beforeEach } from "vitest";

const sgMock = vi.hoisted(() => ({
  setApiKey: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => [{ headers: { "x-message-id": "m-1" }, statusCode: 202 }, {}]),
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
        : "Praxis Ops",
  ),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(async (name: string, _args: Record<string, unknown>) => {
      const data: Record<string, unknown> = {
        is_email_suppressed: null,
        get_or_create_unsub_token: "tok-attachments-test",
        touch_domain_warmup: 0,
        consume_email_send_or_reject: true,
      };
      return { data: data[name], error: null };
    }),
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  }),
}));

import { emailSend } from "../_client";

beforeEach(() => {
  sgMock.send.mockClear();
});

describe("emailSend attachments threading", () => {
  it("attachments[] is passed through to sgMail.send() in SDK shape", async () => {
    await emailSend("t-1", {
      to: "user@example.com",
      subject: "report",
      body_text: "see attached",
      attachments: [{ filename: "r.pdf", content: "JVBERi0=", type: "application/pdf" }],
    });
    expect(sgMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: "r.pdf",
            content: "JVBERi0=",
            type: "application/pdf",
            disposition: "attachment",
          }),
        ],
      }),
    );
  });

  it("no attachments param → no attachments key in send payload", async () => {
    await emailSend("t-1", { to: "user@example.com", subject: "s", body_text: "b" });
    const call = sgMock.send.mock.calls[0][0];
    expect(call).not.toHaveProperty("attachments");
  });

  it("empty attachments[] → no attachments key in send payload", async () => {
    await emailSend("t-1", { to: "user@example.com", subject: "s", body_text: "b", attachments: [] });
    const call = sgMock.send.mock.calls[0][0];
    expect(call).not.toHaveProperty("attachments");
  });
});

describe("derived HTML shows the text as written", () => {
  it("escapes <, > and & before turning newlines into <br>", async () => {
    await emailSend("t-1", { to: "user@example.com", subject: "s", body_text: "Use code <SAVE20> & enjoy\nThanks" });
    const arg = sgMock.send.mock.calls[0][0] as { html: string; text: string };
    expect(arg.html).toBe("Use code &lt;SAVE20&gt; &amp; enjoy<br>Thanks");
    expect(arg.text).toBe("Use code <SAVE20> & enjoy\nThanks");
  });

  it("a caller-supplied HTML body is sent as given", async () => {
    await emailSend("t-1", { to: "user@example.com", subject: "s", body_text: "t", body_html: "<p>Hi</p>" });
    expect((sgMock.send.mock.calls[0][0] as { html: string }).html).toBe("<p>Hi</p>");
  });
});
