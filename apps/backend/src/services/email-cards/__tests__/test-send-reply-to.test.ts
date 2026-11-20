import { describe, expect, it, vi } from "vitest";
import { sendBulkTestEmail } from "@/services/email-cards/test-send";

const v = { n: 1, subject: "S", preview_text: null, html: "<p>x {{zavi_unsubscribe_url}}</p>", text: "x {{zavi_unsubscribe_url}}", render_sha: "a".repeat(64) };

function deps(replyTo: () => Promise<string | null>) {
  const sent: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? "{}"));
    return new Response(null, { status: 202 });
  });
  return {
    sent,
    fetch,
    d: {
      checkSender: (async () => ({ ok: true, sender: { domain: "acme.com", from_address: "hi@acme.com", from_name: "Acme" } })) as never,
      bulkKey: () => "bulk-key",
      fetch: fetch as never,
      recheckDomain: vi.fn(async () => "verified" as const) as never,
      replyTo,
    },
  };
}

describe("a Zavi-list test send checks where replies go before sending", () => {
  it("sends with the reply-to the card was drafted with when it still matches, case aside", async () => {
    const t = deps(async () => "Founder@Acme.com");
    await expect(sendBulkTestEmail("t", { from_address: "hi@acme.com", reply_to: "founder@acme.com" }, v, "owner@acme.com", t.d)).resolves.toBeTruthy();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.sent[0].reply_to).toEqual({ email: "Founder@Acme.com" });
  });

  it("refuses without calling the provider when the workspace's reply-to changed since the draft", async () => {
    const t = deps(async () => "new@acme.com");
    await expect(sendBulkTestEmail("t", { from_address: "hi@acme.com", reply_to: "old@acme.com" }, v, "owner@acme.com", t.d)).rejects.toMatchObject({
      code: "sender_not_ready",
      message: expect.stringContaining("Where replies go changed"),
    });
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("refuses when a reply-to was added after a draft that had none", async () => {
    const t = deps(async () => "added@acme.com");
    await expect(sendBulkTestEmail("t", { from_address: "hi@acme.com" }, v, "owner@acme.com", t.d)).rejects.toMatchObject({ code: "sender_not_ready" });
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("refuses without sending when the reply-to cannot be read", async () => {
    const t = deps(async () => {
      throw new Error("db down");
    });
    await expect(sendBulkTestEmail("t", { from_address: "hi@acme.com", reply_to: "founder@acme.com" }, v, "owner@acme.com", t.d)).rejects.toMatchObject({
      code: "sender_not_ready",
      message: expect.stringContaining("could not check where replies go"),
    });
    expect(t.fetch).not.toHaveBeenCalled();
  });
});
