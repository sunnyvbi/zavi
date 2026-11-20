import { describe, expect, it } from "vitest";
import { keyRejectedText } from "../provider-errors";
import { TOOL_KEY_REJECTED } from "@/services/email-cards/cards";
import { KLAVIYO_KEY_INSTRUCTION } from "../klaviyo-scopes";
import { EMAIL_CARD_MESSAGES } from "@/services/email-cards/cards";
import { PLAN_REFUSALS } from "@/services/email-plan/messages";

describe("the rejected-key copy matches how each tool connects", () => {
  it("tells a Mailchimp founder to sign in again, never to paste an API key", () => {
    const text = keyRejectedText("Mailchimp");
    expect(text).not.toMatch(/API key/i);
    expect(text).toMatch(/sign in/i);
    expect(text).toMatch(/disconnect Mailchimp/);
    expect(text).toMatch(/rejected the key/i);
  });

  it("still tells SendGrid and Klaviyo founders to paste a new API key", () => {
    expect(keyRejectedText("SendGrid")).toMatch(/new API key/);
    expect(keyRejectedText("SendGrid")).not.toMatch(/sign in/i);
    expect(keyRejectedText("Klaviyo")).toMatch(/new API key/);
    expect(keyRejectedText("Klaviyo")).toContain(KLAVIYO_KEY_INSTRUCTION);
  });

  it("gives steps true for every tool where the tool is not named", () => {
    for (const text of [EMAIL_CARD_MESSAGES.tool_key_rejected, PLAN_REFUSALS.tool_key_rejected]) {
      expect(text).toMatch(/sign in again for Mailchimp/);
      expect(text).toMatch(/new API key for SendGrid or Klaviyo/);
      expect(text).not.toMatch(/then reconnect it with a new API key/);
      expect(text).toContain(KLAVIYO_KEY_INSTRUCTION);
    }
  });

  it("says the same reason in every rejected-key sentence, the tool-agnostic ones included", () => {
    const texts = [
      keyRejectedText("SendGrid"),
      keyRejectedText("Mailchimp"),
      keyRejectedText("Klaviyo"),
      EMAIL_CARD_MESSAGES.tool_key_rejected,
      TOOL_KEY_REJECTED,
      PLAN_REFUSALS.tool_key_rejected,
    ];
    for (const text of texts) {
      expect(text).toContain("rejected the key Zavi has saved for it (it was revoked, is no longer valid, or lacks a permission Zavi needs)");
      expect(text).not.toContain("(it was revoked or is no longer valid)");
    }
  });

  it("warns that emails drafted before the reconnect, approved or scheduled ones included, must be drafted again", () => {
    const texts = [
      keyRejectedText("SendGrid"),
      keyRejectedText("Mailchimp"),
      keyRejectedText("Klaviyo"),
      EMAIL_CARD_MESSAGES.tool_key_rejected,
      TOOL_KEY_REJECTED,
      PLAN_REFUSALS.tool_key_rejected,
    ];
    for (const text of texts) {
      expect(text).toContain("Emails drafted before you reconnect will not send, even approved or scheduled ones: ask Zavi to draft them again.");
      expect(text).not.toMatch(/sealed|digest|NotConnected|composio/i);
    }
  });
});
