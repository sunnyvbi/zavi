import { describe, expect, it } from "vitest";
import { exactActionFields } from "../exact-action-view";
import { decisionCardTitle } from "../decision-copy";

const body = {
  tool: "klaviyo", connected_account_id: "ca", auth_config_id: "ac", audience_id: "L1", audience_name: "Customers", audience_count: 1412, approved_count: 1412,
  subject: "Spring offer", preview_text: null, body_text: "Hello", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
};

describe("exactActionFields: email_campaign.create_and_send", () => {
  it("lists the fields the handler sends, in the founder's words", () => {
    expect(exactActionFields("email_campaign.create_and_send", body)).toEqual([
      { label: "Subject", value: "Spring offer" },
      { label: "From", value: "Acme <hi@acme.test>" },
      { label: "Sending with", value: "Klaviyo" },
      { label: "List", value: "Customers" },
      { label: "People", value: "1,412" },
      { label: "Message", value: "Hello" },
    ]);
  });

  it("a body that is not the sealed shape is not rendered as one", () => {
    expect(exactActionFields("email_campaign.create_and_send", { subject: "x" })).toBeNull();
    expect(exactActionFields("composio.write", body)).toBeNull();
  });

  it("has a plain title", () => {
    expect(decisionCardTitle("email_campaign.create_and_send")).toBe("Send an email to a list in your email tool");
  });
});
