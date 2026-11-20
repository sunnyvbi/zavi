import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tools/email/safety-net", () => ({
  unsubscribeUrl: (t: string) => `https://api.zaviagent.com/api/email/unsubscribe?token=${t}`,
  unsubscribeHeaders: () => ({}),
}));

import { exactActionFields } from "../exact-action-view";
import { decisionConsequence } from "../decision-copy";
import { buildApprovalBlocks } from "../slack-approval-blocks";
import { buildBulkPayload } from "@/services/comms/bulk-outbound/wire";

const body = {
  list_id: "11111111-1111-4111-8111-111111111111",
  list_version_id: "22222222-2222-4222-8222-222222222222",
  list_name: "Newsletter",
  from_address: "hello@acme.com",
  reply_to: "founder@acme.com",
  template: { subject: "We miss you", body_text: "Come back." },
  est_recipient_count: 3,
  sample_recipients: ["a@x.com", "b@x.com", "c@x.com"],
};

describe("exactActionFields for bulk_outbound.send", () => {
  it("shows the exact send: subject, the whole message, From, replies, list, people, a sample and the footer note", () => {
    expect(exactActionFields("bulk_outbound.send", body)).toEqual([
      { label: "Subject", value: "We miss you" },
      { label: "Message", value: "Come back." },
      { label: "From", value: "hello@acme.com" },
      { label: "Replies go to", value: "founder@acme.com" },
      { label: "List", value: "Newsletter" },
      { label: "People", value: "3 people" },
      { label: "For example", value: "a@x.com, b@x.com, c@x.com" },
      { label: "Included", value: "Each email includes an unsubscribe link and your address." },
    ]);
  });

  it("never cuts the message: the founder reads every word that goes out", () => {
    const long = "word ".repeat(3000).trim();
    const fields = exactActionFields("bulk_outbound.send", { ...body, template: { subject: "s", body_text: long } })!;
    expect(fields.find((f) => f.label === "Message")!.value).toBe(long);
  });

  it("an older draft with no contact list is not an exact-action card", () => {
    expect(exactActionFields("bulk_outbound.send", { selector: { segment: "x" }, template: { subject: "s", body_text: "b" } })).toBeNull();
  });
});

describe("what the card shows is what is sent", () => {
  it("the Message on the card is the text each person receives, before the fixed footer", () => {
    const text = "Hello,\n\nOur <b>sale</b> starts Monday: https://acme.com/sale\nThanks";
    const card = exactActionFields("bulk_outbound.send", { ...body, template: { subject: "Sale", body_text: text } })!;
    const shown = card.find((f) => f.label === "Message")!.value;
    const sent = buildBulkPayload({
      tenantId: "t", sendId: "s", to: "a@x.com", from: { email: "hello@acme.com" }, replyTo: "founder@acme.com",
      subject: "Sale", bodyText: shown, unsubToken: "tok", postalAddress: "1 Main St",
    }) as { subject: string; content: Array<{ type: string; value: string }>; reply_to: { email: string } };
    const plain = sent.content.find((c) => c.type === "text/plain")!.value;
    expect(plain.startsWith(text)).toBe(true);
    expect(plain.slice(text.length)).toBe("\n\n--\n1 Main St\nUnsubscribe: https://api.zaviagent.com/api/email/unsubscribe?token=tok\n");
    const html = sent.content.find((c) => c.type === "text/html")!.value;
    expect(html).toContain("Our &lt;b&gt;sale&lt;/b&gt; starts Monday: https://acme.com/sale");
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(sent.reply_to.email).toBe(card.find((f) => f.label === "Replies go to")!.value);
  });
});

describe("a hostile list name or subject cannot change the Slack card", () => {
  const hostile = {
    ...body,
    list_name: "<https://evil.example|Approve here> *URGENT* <!channel> <@U123> _x_ ~y~ `z`",
    from_address: "hello@acme.com",
    template: { subject: "<!here> *Click* <https://evil.example|now>", body_text: "<@U999> hi" },
  };

  it("the mrkdwn consequence line carries no founder-typed text", () => {
    const c = decisionConsequence("bulk_outbound.send", "bulk_outbound.send", hostile);
    expect(c.approve).toBe(
      "Sends this email to 3 people on the list shown below, from the address shown below. One email per person. Each email includes an unsubscribe link and your address.",
    );
  });

  it("every hostile value reaches Slack only as plain text, and the header is plain text", () => {
    const blocks = buildApprovalBlocks({
      id: "d1",
      tenant_id: "t1",
      decision_class: "bulk_outbound.send",
      dispatch_handler: "bulk_outbound.send",
      body: hostile,
    } as never) as Array<Record<string, any>>;
    const json = JSON.stringify(blocks);
    expect(json).toContain("evil.example");
    for (const b of blocks) {
      const texts = [b.text, ...(b.fields ?? []), ...(b.elements ?? [])].filter(Boolean);
      for (const t of texts) {
        if (typeof t.text === "string" && /evil\.example|<!channel>|<!here>|<@U/.test(t.text)) {
          expect(t.type).toBe("plain_text");
        }
      }
    }
  });
});
