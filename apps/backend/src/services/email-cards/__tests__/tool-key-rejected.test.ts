import { describe, expect, it, vi } from "vitest";

const getAudience = vi.hoisted(() => vi.fn());

vi.mock("@/services/connectors/email-campaign/providers", () => ({
  EMAIL_TOOL_LABEL: { klaviyo: "Klaviyo", mailchimp: "Mailchimp", sendgrid: "SendGrid" },
  EMAIL_PROVIDERS: { klaviyo: { getAudience }, mailchimp: { getAudience }, sendgrid: { getAudience } },
}));
vi.mock("@/services/connectors/email-campaign/execute-send", () => ({
  parseEmailSendBody: () => ({ tool: "klaviyo", audience_id: "list-1" }),
  connectedCall: () => vi.fn(),
  EMAIL_ALL_SUPPRESSED_ERROR: "all suppressed",
}));

import { EmailToolError } from "@/services/connectors/email-campaign/provider-errors";
import { sendgridErrorText } from "@/services/connectors/email-campaign/providers-sendgrid";
import { KLAVIYO_KEY_INSTRUCTION } from "@/services/connectors/email-campaign/klaviyo-scopes";
import { approveEmailCard, EMAIL_CARD_MESSAGES, EmailToolKeyRejected, liveCardCount } from "../cards";
import { schedulePlanned } from "@/services/email-plan/api";

const T = "11111111-1111-1111-1111-111111111111";

describe("an email tool that rejects the saved key", () => {
  it("is reported as a rejected key, not as a count to retry", async () => {
    getAudience.mockImplementationOnce(async () => {
      throw new EmailToolError('{"errors":[{"status":401,"detail":"Incorrect authentication credentials."}]}', false, 401);
    });
    await expect(liveCardCount(T, "email_campaign.send", {})).rejects.toBeInstanceOf(EmailToolKeyRejected);
  });

  it("still treats a busy or unreachable tool as worth a retry", async () => {
    getAudience.mockImplementationOnce(async () => {
      throw new EmailToolError("Service Unavailable", true, 503);
    });
    expect(await liveCardCount(T, "email_campaign.send", {})).toBeNull();
  });

  it("refuses the approve with the reconnect steps, never 'try again in a minute'", async () => {
    const rpc = vi.fn(async () => ({ ok: true, open: true, retryable: true, class: "email_campaign.send", body: {} }));
    const out = await approveEmailCard(T, "channel_actions", "card-1", 0, "u1", "req-1", {
      rpc: rpc as never,
      liveCount: async () => {
        throw new EmailToolKeyRejected();
      },
    });

    expect(out).toEqual({ ok: false, code: "tool_key_rejected" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(EMAIL_CARD_MESSAGES.tool_key_rejected).toMatch(/reconnect/i);
    expect(EMAIL_CARD_MESSAGES.tool_key_rejected).not.toMatch(/try again in a minute/i);
    expect(EMAIL_CARD_MESSAGES.tool_key_rejected).toContain(KLAVIYO_KEY_INSTRUCTION);
    for (const scope of ["templates:write", "metrics:read", "accounts:read", "lists:read", "campaigns:write"]) expect(EMAIL_CARD_MESSAGES.tool_key_rejected).toContain(scope);
  });

  it("a held account's 403 is not a dead key: the live count is null, so the founder is not told to reconnect", async () => {
    getAudience.mockImplementationOnce(async () => {
      throw new EmailToolError("Your account has been suspended", false, 403);
    });
    expect(await liveCardCount(T, "email_campaign.send", {})).toBeNull();
  });

  it("SendGrid keeps the vendor's words on a held 403, and only a plain 403 reads as a dead key", () => {
    expect(sendgridErrorText(403, { errors: [{ message: "Your account has been suspended" }] })).toBe("Your account has been suspended");
    expect(sendgridErrorText(403, { errors: [{ message: "access forbidden" }] })).toMatch(/SendGrid refused the key/);
  });

  it("everyone on the list unsubscribed: the approve is refused before the send is queued", async () => {
    const rpc = vi.fn(async () => ({ ok: true, open: true, retryable: false, class: "email_campaign.send", body: {} }));
    const enqueue = vi.fn(async () => {});
    const out = await approveEmailCard(T, "channel_actions", "card-1", 0, "u1", "req-1", {
      rpc: rpc as never,
      enqueue: enqueue as never,
      liveCount: async () => 5,
      suppression: async () => ({ suppressed: 5, complete: true }),
    });
    expect(out).toEqual({ ok: false, code: "all_suppressed" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(EMAIL_CARD_MESSAGES.all_suppressed).toBe("all suppressed");
  });

  it("some unsubscribed, or a read that could not finish: the approve goes on with the list's count", async () => {
    for (const sup of [{ suppressed: 2, complete: true }, { suppressed: 0, complete: false }]) {
      const rpc = vi.fn(async (_t: string, fn: string) => (fn === "email_card_view_state" ? { ok: true, open: true, retryable: false, class: "email_campaign.send", body: {} } : { ok: true, exec_status: "queued" }));
      const enqueue = vi.fn(async () => {});
      const out = await approveEmailCard(T, "channel_actions", "card-1", 0, "u1", "req-1", {
        rpc: rpc as never,
        enqueue: enqueue as never,
        liveCount: async () => 5,
        suppression: async () => sup,
        paused: async () => false,
      });
      expect(out).toMatchObject({ ok: true });
      expect(rpc.mock.calls[1]).toMatchObject([T, "approve_email_card", { p_approved_count: 5 }]);
      expect(enqueue).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a planned send the same way", async () => {
    const out = await schedulePlanned(T, "u1", "plan-1", { variant: 0, schedule_gen: 1, content_version: 1, request_id: "r1" }, {
      rpc: (async () => ({ ok: true, card: { class: "email_campaign.send", body: {} } })) as never,
      count: async () => {
        throw new EmailToolKeyRejected();
      },
    });

    expect(out).toMatchObject({ ok: false, code: "tool_key_rejected" });
    expect((out as { message: string }).message).toMatch(/Connectors/);
    expect((out as { message: string }).message).not.toMatch(/try again in a minute/i);
    expect((out as { message: string }).message).toContain(KLAVIYO_KEY_INSTRUCTION);
  });
});
