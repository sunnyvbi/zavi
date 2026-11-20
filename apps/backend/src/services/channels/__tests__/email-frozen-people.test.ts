import { describe, expect, it } from "vitest";
import { emailSendLabel, servedCardWords, withoutFrozenPeople } from "../channel-actions";
import { buildEmailSendCardBody } from "@/services/tools/email-campaign/_exec-action";

const EMAIL = "email_campaign.create_and_send";
const stored = {
  change_sentence: 'Zavi creates this email in Klaviyo and sends it to your "Zavi QA" list, 4 people today. Klaviyo applies its own unsubscribes.',
  step: { title: "t", body: 'Zavi creates this email in Klaviyo and sends it to your "Zavi QA" list, 1,204 people today. Klaviyo applies its own unsubscribes.\n\nWhy this list.' },
  exact_change: { rows: [{ item: "List", before: "", after: "Zavi QA" }, { item: "People", before: "", after: "4" }] },
};

describe("an email card drafted when the list had 4 people", () => {
  it("its stored words lose the number on every field, and nothing else", () => {
    const served = withoutFrozenPeople(stored, EMAIL) as typeof stored;
    expect(JSON.stringify(served)).not.toMatch(/people today|"People"/);
    expect(served.change_sentence).toBe('Zavi creates this email in Klaviyo and sends it to your "Zavi QA" list. Klaviyo applies its own unsubscribes.');
    expect(served.step.body).toContain("Why this list.");
    expect(served.exact_change.rows).toEqual([{ item: "List", before: "", after: "Zavi QA" }]);
  });

  it("the button and its how-to stop saying 4", () => {
    const w = servedCardWords("executes", "Send to 4 people", "Done", ["Press Send to 4 people. Zavi creates the email."], "x", stored, EMAIL);
    expect(w).toMatchObject({ primary_label: "Send email", how_to: ["Press Send email. Zavi creates the email."] });
    expect(emailSendLabel("Send to 1,204 people", EMAIL)).toBe("Send email");
    expect(emailSendLabel("Send to 1 person", EMAIL)).toBe("Send email");
  });

  it("another class keeps its own words", () => {
    expect(withoutFrozenPeople(stored, "meta_ads.pause")).toBe(stored);
    expect(emailSendLabel("Send to 4 people", "bulk_outbound.send")).toBe("Send to 4 people");
  });

  it("a new card stores no number anywhere, so its button cannot freeze one", () => {
    const body = { tool: "klaviyo", audience_name: "Zavi QA", audience_count: 4, from_name: "A", from_email: "a@b.test", reply_to: null, subject: "Hi", preview_text: null, body_text: "x" };
    const { card } = buildEmailSendCardBody(body as never, null);
    expect(JSON.stringify(card)).not.toMatch(/people today|"People"/);
  });
});
