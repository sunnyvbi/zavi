import { describe, expect, it, vi } from "vitest";

vi.mock("@/../workers/client", () => ({ inngest: { send: async () => undefined } }));

import { emailCardLink } from "../cards";
import { notifyEmailSendOutcome, type OutcomeDeps } from "../outcome";

const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function linksIn(text: string): URL[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => new URL(m[0].replace(/&amp;/g, "&"))).filter((u) => u.pathname.startsWith("/workspace/email-cards/"));
}

describe("email card links carry the workspace they belong to", () => {
  it("emailCardLink names the tenant as ?company=, and an old caller without one is unchanged", () => {
    const withTenant = new URL(emailCardLink("decisions", CARD, TENANT_B));
    expect(withTenant.pathname).toBe(`/workspace/email-cards/decisions/${CARD}`);
    expect(withTenant.searchParams.get("company")).toBe(TENANT_B);
    expect([...withTenant.searchParams.keys()]).toEqual(["company"]);
    const legacy = new URL(emailCardLink("channel_actions", CARD));
    expect(legacy.pathname).toBe(`/workspace/email-cards/channel_actions/${CARD}`);
    expect(legacy.search).toBe("");
  });

  it("the outcome email to the approver links to the card in the card's own workspace, in both the html and the text part", async () => {
    const sent: Array<{ to: string; html: string; text: string }> = [];
    const deps: Partial<OutcomeDeps> = {
      readCard: async () => ({ body: { variants: [{ content: { subject: "Autumn menu" } }], chosen_variant: 1, list_name: "Regulars" }, approved_by: "u-approver", approved_by_source: null }),
      claim: async () => true,
      release: async () => undefined,
      emailOf: async (u) => (u === "u-approver" ? "approver.b@yopmail.com" : null),
      ownerEmail: async () => "owner.b@yopmail.com",
      send: async (to, _subject, html, text) => {
        sent.push({ to, html, text });
      },
      startResults: async () => undefined,
    };
    expect(await notifyEmailSendOutcome({ tenant_id: TENANT_B, rail: "decisions", card_id: CARD, outcome: "sent", sent: 12, total: 12 }, deps)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("approver.b@yopmail.com");
    for (const part of [sent[0].text, sent[0].html]) {
      const links = linksIn(part);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.pathname).toBe(`/workspace/email-cards/decisions/${CARD}`);
        expect(link.searchParams.get("company")).toBe(TENANT_B);
      }
    }
  });
});
