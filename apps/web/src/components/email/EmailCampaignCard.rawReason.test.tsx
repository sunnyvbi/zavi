// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const answers: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const a = answers[`${init?.method ?? "GET"} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body), clone() { return this; } });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, founderReason, type EmailCardView } from "./EmailCampaignCard";

const ID = "99999999-9999-4999-8999-999999999999";

function closed(over: Partial<EmailCardView>): EmailCardView {
  return {
    rail: "channel_actions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "failed",
    open: false,
    route: "mailchimp",
    list: { name: "Newsletter", people: 3 },
    sender: { email: "hello@bakery.test", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: 1,
    editable: false,
    retryable: false,
    versions: [{ variant: 1, subject: "Fresh from the oven today", preview_text: "Chocolate cake box", html: "<p>Cake</p>", tested_by_me: true, tested_by_approver: true }],
    can_approve: [false],
    reasons: [],
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET /api/email-cards/${c.rail}/${c.id}`] = { status: 200, body: { card: c } };
};

const LONG = `x${"at Object.<anonymous> (/app/apps/backend/dist/send.js:9:1) ".repeat(80)}`;

const RAW: ReadonlyArray<[string, string, string]> = [
  ["a Postgres error", 'duplicate key value violates unique constraint "email_sends_pkey"', "email_sends_pkey"],
  ["a Postgres error that reads like a sentence", 'Relation "email_send_reservations" does not exist.', "email_send_reservations"],
  ["a TypeError with a file path", "TypeError: x is undefined at /app/src/services/connectors/email-campaign/execute-send.ts:457:9", "TypeError"],
  ["a TypeError ending in a full stop", "TypeError: x is undefined.", "TypeError"],
  ["a bare tool status", "Mailchimp returned 503", "returned 503"],
  ["a very long string", LONG, "anonymous"],
  ["an API path quoted after 'on'", 'Mailchimp said no on "/api/v3/lists/abc/members" today.', "/api/v3/lists"],
  ["a quoted error name after 'named'", 'The table named "TypeError: x is undefined" failed.', "TypeError"],
  ["a URL quoted as a list name", 'The list "https://evil.test/x" is no longer in Klaviyo. Nothing was sent.', "evil.test"],
  ["a bare subscriber address", "Bounce for bob@bakery.test. Nothing was sent.", "bob@bakery.test"],
  ["a quoted id that is not after a name word", 'Mailchimp said: "Campaign_id is invalid." Nothing was sent.', "Campaign_id"],
  ["an HTTP status inside the tool clause", "Mailchimp did not accept this: HTTP 500. Nothing was sent.", "HTTP 500"],
  ["a connect error with an IP address", "Mailchimp did not accept this: Error: connect ECONNREFUSED 10.0.12.4:443. Nothing was sent.", "ECONNREFUSED"],
  ["a masked API key", "Mailchimp did not accept this: Invalid API key 3f9a7c-us21. Nothing was sent.", "3f9a7c"],
  ["a masked API key with an ellipsis", "Mailchimp did not accept this: Invalid API key 3f9a\u20267c-us21. Nothing was sent.", "3f9a"],
  ["a status code in a refusal", "Mailchimp refused to send this: Request failed with status code 500. Nothing was sent.", "status code 500"],
  ["a long token", "Klaviyo did not accept this: token pk_live_abcdef0123 was not found. Nothing was sent.", "pk_live_abcdef0123"],
  ["a version number", "Klaviyo did not accept this: api revision 2.3.1 is not supported. Nothing was sent.", "2.3.1"],
  ["an all-caps code", "SendGrid did not accept this: the request was FORBIDDEN. Nothing was sent.", "FORBIDDEN"],
];

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("EmailCampaignCard never renders a raw stored send error", () => {
  it.each(RAW)("%s on a failed card is not in the DOM; the card says the send did not go through", async (_name, raw, fragment) => {
    serve(closed({ status: "failed", may_have_sent: false, failure_reason: raw }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(document.body.textContent).toContain("The send did not go through."));
    expect(document.body.textContent).toContain("Version A was approved but not sent");
    expect(document.body.textContent).not.toContain(fragment);
    expect(document.body.innerHTML).not.toContain(fragment);
  });

  it.each(RAW)("%s on a card that may have gone out is not in the DOM; the card says Zavi will not send it again", async (_name, raw, fragment) => {
    serve(closed({ status: "failed", may_have_sent: true, reconciliation_pending: false, failure_reason: raw }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(document.body.textContent).toContain("May have gone out."));
    expect(document.body.textContent).toContain("Zavi will not send it again, so nobody gets it twice.");
    expect(document.body.textContent).not.toContain(fragment);
    expect(document.body.innerHTML).not.toContain(fragment);
  });

  it.each(RAW)("%s on a decisions-rail outcome card and a held card is not in the DOM", async (_name, raw, fragment) => {
    serve(closed({ rail: "decisions", class: "bulk_outbound.send", route: "zavi_list", status: "outcome_unknown", sent_count: 0, failure_reason: raw }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    const out = await screen.findByTestId("email-card-outcome");
    expect(out.textContent).toContain("May have gone out.");
    expect(document.body.innerHTML).not.toContain(fragment);
    cleanup();
    serve(closed({ rail: "decisions", class: "bulk_outbound.send", route: "zavi_list", status: "held", sent_count: 12, failure_reason: raw }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(document.body.textContent).toContain("This send is on hold."));
    expect(document.body.innerHTML).not.toContain(fragment);
  });

  it("an empty reason shows the card's own state wording", async () => {
    serve(closed({ status: "failed", may_have_sent: false, failure_reason: "   " }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(document.body.textContent).toContain("The send did not go through."));
  });

  it.each([
    ['Mailchimp did not accept this email. Mailchimp said: "Your account is suspended." Nothing was sent.'],
    ["Zavi could not finish this send. Ask Zavi for a new draft."],
    ["SendGrid did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Open SendGrid to see whether it went out."],
    ["Klaviyo rejected the key Zavi has saved for it (it was revoked, is no longer valid, or lacks a permission Zavi needs). In Klaviyo, create a Private API key under Settings > API keys with Read access to Accounts (scopes accounts:read, campaigns:read)."],
    ...["Café Lovers", "VIP 🎉", "VIP_customers", "Newsletter 2025/26", "Members | EU", "Black Friday / Cyber Monday", "iPhone owners", "McDonald's fans"].flatMap((n) => [
      [`Mailchimp did not say how many people are on "${n}" right now, so Zavi did not send. Nothing was sent. Approve it again.`],
      [`The list "${n}" is no longer in Klaviyo. Nothing was sent.`],
      [`Mailchimp did not accept this: the campaign named "Zavi: ${n} (ab12cd34)" goes to a different list. Nothing was sent.`],
    ]),
    ["SendGrid did not accept this: hello@bakery.test is not a verified sender in SendGrid. Nothing was sent."],
    ["SendGrid did not accept this: more than one verified sender in SendGrid uses hello+news@bakery.co.uk, so Zavi cannot tell which one to send as. Nothing was sent."],
    ["Email Campaigns needs the Growth plan ($120/mo). Nothing in the account changed."],
    ["The list grew from 1,000 to 1,204 people since this was approved, more than 10%. Nothing was sent. Approve it again if it should go to everyone on the list now."],
    ["Meta Ads changes are switched off at the platform level right now, so Zavi did not apply this one. Nothing in the account changed. Approve it again once they are back on."],
    ["Autopilot did not send this planned email: the list was imported again after it was drafted, and the draft is for the earlier import. Nothing was sent. Approve it yourself if it is still right."],
  ])("a plain sentence Zavi wrote is rendered as written: %s", async (sentence) => {
    expect(founderReason(sentence)).toBe(sentence);
    serve(closed({ status: "failed", may_have_sent: false, failure_reason: sentence }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(document.body.textContent).toContain(sentence));
  });
});
