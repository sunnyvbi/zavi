import { describe, expect, it } from "vitest";
import { parseProposalView } from "./proposalView";

const body = {
  list_id: "11111111-1111-4111-8111-111111111111",
  list_version_id: "22222222-2222-4222-8222-222222222222",
  list_name: "Newsletter",
  from_address: "hello@acme.com",
  reply_to: "founder@acme.com",
  template: { subject: "We miss you", body_text: "Come back and finish your order." },
  est_recipient_count: 1000,
  sample_recipients: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"],
  capped_at: 1000,
  will_be_skipped: 12,
};

describe("bulk email approval card", () => {
  it("shows subject, preview, From, list, people, 5 sample addresses and the footer note", () => {
    const view = parseProposalView("bulk_outbound.send", "bulk_outbound.send", body);
    expect(view.fields).toEqual([
      { label: "Subject", value: "We miss you" },
      { label: "Message", value: "Come back and finish your order." },
      { label: "From", value: "hello@acme.com" },
      { label: "Replies go to", value: "founder@acme.com" },
      { label: "List", value: "Newsletter" },
      {
        label: "People",
        value:
          "1,000 people. The list is longer: one send reaches at most 1,000. 12 already unsubscribed or bounced and will be skipped",
      },
      { label: "For example", value: "a@x.com, b@x.com, c@x.com, d@x.com, e@x.com" },
      { label: "Included", value: "Each email includes an unsubscribe link and your address." },
    ]);
  });

  it("an older draft with no contact list shows no send fields", () => {
    const view = parseProposalView("bulk_outbound.send", "bulk_outbound.send", {
      selector: { segment: "lapsed" },
      template: { subject: "Hi", body_text: "x" },
      sample_recipients: ["a@x.com"],
    });
    expect(view.fields).toEqual([]);
  });

  it("never renders a recipients array smuggled into the body", () => {
    const view = parseProposalView("bulk_outbound.send", "bulk_outbound.send", { ...body, recipients: ["evil@x.com"] });
    expect(JSON.stringify(view.fields)).not.toContain("evil@x.com");
  });
});
