import { describe, expect, it } from "vitest";
import { emailToolIssueReason } from "./useEmailToolIssues";

describe("the rejected-key reason on an email tool in Settings", () => {
  it("tells the founder that emails drafted before reconnecting must be drafted again", () => {
    for (const label of ["SendGrid", "Mailchimp", "Klaviyo"]) {
      const text = emailToolIssueReason("rejected", label);
      expect(text).toMatch(new RegExp(`^${label} rejected the key Zavi has saved`));
      expect(text).toContain("Emails drafted before you reconnect will not send, even approved or scheduled ones: ask Zavi to draft them again.");
    }
  });

  it("control: a tool Zavi cannot reach says nothing about drafting again", () => {
    expect(emailToolIssueReason("unreadable", "SendGrid")).not.toMatch(/draft/i);
  });
});
