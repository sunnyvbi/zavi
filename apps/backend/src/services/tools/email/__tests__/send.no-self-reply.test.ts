
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, messageId: "m1", statusCode: 202 })));
vi.mock("../_client", () => ({ emailSend: sendMock }));

const INBOUND_SENDER = "ravi@upcar.ai";
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { payload: { email: { from: INBOUND_SENDER } } },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { emailSendTool } from "../send";

const msg = (to: string) => ({ to, subject: "s", body_text: "b" });

beforeEach(() => sendMock.mockClear());

describe("email_send — never re-reply to the person we're already replying to", () => {
  it("REFUSES to email the inbound sender on a trigger='email' run", async () => {
    await expect(
      emailSendTool.execute(
        { tenant_id: "t1", run_id: "r1", run_trigger: "email" } as never,
        msg(INBOUND_SENDER),
      ),
    ).rejects.toThrow(/already sent back to them|reply_is_automatic/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refusal is case-insensitive (an agent can't dodge it by casing the address)", async () => {
    await expect(
      emailSendTool.execute(
        { tenant_id: "t1", run_id: "r1", run_trigger: "email" } as never,
        msg("RAVI@UPCAR.AI"),
      ),
    ).rejects.toThrow(/already sent back/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ALLOWS emailing someone ELSE from the same email-triggered run", async () => {
    await emailSendTool.execute(
      { tenant_id: "t1", run_id: "r1", run_trigger: "email" } as never,
      msg("host@example.com"),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not interfere with non-email triggers (chat, cron, slack)", async () => {
    for (const trigger of ["chat", "cron", "slack"]) {
      sendMock.mockClear();
      await emailSendTool.execute(
        { tenant_id: "t1", run_id: "r1", run_trigger: trigger } as never,
        msg(INBOUND_SENDER),
      );
      expect(sendMock).toHaveBeenCalledTimes(1);
    }
  });
});
