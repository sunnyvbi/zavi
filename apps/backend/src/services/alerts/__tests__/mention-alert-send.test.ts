import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  claimError: null as { message: string } | null,
  claimFresh: true,
  markError: null as { message: string } | null,
  markFailures: 0,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (x: string) => x,
  tenantRpc: vi.fn(async (_tid: string, name: string, args: Record<string, unknown>) => {
    h.rpcCalls.push({ name, args });
    if (name === "claim_mention_alert_send") {
      return h.claimError
        ? { data: null, error: h.claimError }
        : { data: [{ id: "delivery-1", is_fresh: h.claimFresh }], error: null };
    }
    if (name === "mark_mention_alert_sent" && h.markFailures > 0) {
      h.markFailures -= 1;
      return { data: null, error: { message: "transient" } };
    }
    return { data: null, error: h.markError };
  }),
}));

vi.mock("@/email/sendMentionAlert", () => ({
  sendMentionAlertEmail: vi.fn(async () => ({ sent: true, count: 1 })),
}));

import { sendTenantMentionAlert, MAX_MENTIONS_PER_EMAIL } from "../mention-alert-send";
import type { MentionProvider, PendingMention } from "../mention-providers";

const TENANT = { id: "22222222-2222-4222-8222-222222222222", display_name: "UpcarAI" };

function mention(key: string, channel = "reddit_organic"): PendingMention {
  return {
    channel,
    key,
    title: `title-${key}`,
    excerpt: "they said a thing",
    url: `https://reddit.com/${key}`,
    context: "r/carrental",
    sentiment: "negative",
    observed_at: `2026-09-22T10:00:0${key.length}.000Z`,
  };
}

function provider(mentions: PendingMention[], channel = "reddit_organic"): MentionProvider {
  return { channel, label: "Reddit", fetchPending: async () => mentions };
}

const marks = () => h.rpcCalls.filter((c) => c.name === "mark_mention_alert_sent");
const claims = () => h.rpcCalls.filter((c) => c.name === "claim_mention_alert_send");

beforeEach(() => {
  h.claimError = null;
  h.claimFresh = true;
  h.markError = null;
  h.markFailures = 0;
  h.rpcCalls = [];
});

describe("sendTenantMentionAlert", () => {
  it("claims nothing and emails nobody when no mention is pending", async () => {
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    const out = await sendTenantMentionAlert(TENANT, { providers: [provider([])], sendEmail });
    expect(out).toEqual({ status: "skipped", reason: "no_fresh_mentions" });
    expect(h.rpcCalls).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not email while the cooldown is live", async () => {
    h.claimError = { message: "cooldown" };
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
    });
    expect(out).toEqual({ status: "skipped", reason: "cooldown" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(0);
  });

  it("re-claiming an in-flight delivery never sends a second email", async () => {
    h.claimFresh = false;
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
    });
    expect(out).toEqual({ status: "skipped", reason: "reclaim_in_flight" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(0);
  });

  it("stamps exactly the mentions it emailed, with their channels", async () => {
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 2 }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [
        provider([mention("m1")], "reddit_organic"),
        provider([mention("x1", "x_organic")], "x_organic"),
      ],
      sendEmail,
    });
    expect(out.status).toBe("sent");
    expect(claims()).toHaveLength(1);
    const mark = marks()[0];
    expect(mark.args.p_status).toBe("sent");
    expect(mark.args.p_mentions).toEqual([
      { channel: "reddit_organic", mention_key: "m1" },
      { channel: "x_organic", mention_key: "x1" },
    ]);
  });

  it("caps one email at five mentions and stamps only those five", async () => {
    const many = Array.from({ length: 12 }, (_, i) => mention(`m${i}`));
    const seen: Array<{ items: unknown[] }> = [];
    const sendEmail = vi.fn(async (args: { tenant_id: string; items: unknown[] }) => {
      seen.push({ items: args.items });
      return { sent: true as const, count: 1 };
    });
    await sendTenantMentionAlert(TENANT, { providers: [provider(many)], sendEmail });
    const emailed = seen[0];
    expect(emailed.items).toHaveLength(MAX_MENTIONS_PER_EMAIL);
    expect(marks()[0].args.p_mentions).toHaveLength(MAX_MENTIONS_PER_EMAIL);
  });

  it("marks the delivery failed and stamps nothing when the email does not go out", async () => {
    const sendEmail = vi.fn(async () => ({ sent: false as const, reason: "no_recipients" }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
    });
    expect(out).toEqual({ status: "skipped", reason: "no_recipients" });
    const mark = marks()[0];
    expect(mark.args.p_status).toBe("failed");
    expect(mark.args.p_mentions).toBeUndefined();
  });

  it("marks the delivery failed when the send throws, so the next tick can retry", async () => {
    const sendEmail = vi.fn(async () => {
      throw new Error("sendgrid exploded");
    });
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
    });
    expect(out.status).toBe("skipped");
    expect(marks()[0].args.p_status).toBe("failed");
  });

  it("a channel read blowing up does not silently swallow the other channel's mention", async () => {
    const boom: MentionProvider = {
      channel: "linkedin_organic",
      label: "LinkedIn",
      fetchPending: async () => {
        throw new Error("linkedin down");
      },
    };
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [boom, provider([mention("m1")])],
      sendEmail,
    });
    expect(out.status).toBe("sent");
    expect(marks()[0].args.p_mentions).toEqual([
      { channel: "reddit_organic", mention_key: "m1" },
    ]);
  });

  it("keeps the send-day in UTC so a claim cannot straddle two local days", async () => {
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
      now: () => new Date("2026-09-22T23:30:00.000Z"),
    });
    expect(claims()[0].args.p_send_day).toBe("2026-09-22");
  });
});

describe("sendTenantMentionAlert: finalizing after the mail has gone", () => {
  it("retries the finalize once, so a single transient error still records the mentions", async () => {
    h.markFailures = 1;
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
    });
    expect(out.status).toBe("sent");
    expect(marks()).toHaveLength(2);
    expect(marks()[1].args.p_mentions).toEqual([
      { channel: "reddit_organic", mention_key: "m1" },
    ]);
  });

  it("gives up after the second failure rather than retrying forever", async () => {
    h.markFailures = 2;
    const sendEmail = vi.fn(async () => ({ sent: true as const, count: 1 }));
    const out = await sendTenantMentionAlert(TENANT, {
      providers: [provider([mention("m1")])],
      sendEmail,
    });
    expect(out.status).toBe("sent");
    expect(marks()).toHaveLength(2);
  });
});
