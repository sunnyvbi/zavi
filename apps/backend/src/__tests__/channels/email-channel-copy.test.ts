import { describe, expect, it } from "vitest";
import { CHANNELS } from "@zavi/shared";

describe("the Email campaigns channel copy", () => {
  const email = CHANNELS.find((c) => c.slug === "email_marketing")!;

  it("names every way to send: Mailchimp, Klaviyo, SendGrid and Zavi's own sender", () => {
    expect(email.connectors).toEqual(expect.arrayContaining(["composio.mailchimp", "composio.klaviyo", "email"]));
    expect(email.description).toMatch(/Mailchimp/);
    expect(email.description).toMatch(/Klaviyo/);
    expect(email.description).toMatch(/SendGrid/);
    expect(email.description).toMatch(/Zavi's own sender/);
  });
});
