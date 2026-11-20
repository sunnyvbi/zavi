// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Answer = { status: number; body: unknown };
const answers: Record<string, Answer> = {};
const calls: { url: string; method: string }[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "33333333-3333-4333-8333-333333333333";
const BASE = `/api/email-cards/channel_actions/${ID}`;
const TOOL_SEND_NO_ANSWER = "Zavi did not hear back from the email tool about this send, so it may have gone out. Zavi will not send it again, so nobody gets it twice. Check the email tool to see whether it went out.";

function failed(over: Partial<EmailCardView>): EmailCardView {
  return {
    rail: "channel_actions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "failed",
    open: false,
    route: "mailchimp",
    list: { name: "Brightloop members", people: 238 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: true,
    chosen_variant: 1,
    editable: false,
    retryable: false,
    versions: [1, 2, 3].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>Version ${n}</p>`, tested_by_me: false, tested_by_approver: false })),
    can_approve: [false, false, false],
    reasons: [],
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
};
const text = () => document.body.textContent ?? "";
const badge = () => screen.getByTestId("email-card-status").textContent;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

const mayHaveSent: { name: string; over: Partial<EmailCardView>; waitFor: RegExp }[] = [
  { name: "exec_outcome_unknown (Zavi still checking)", over: { may_have_sent: true, reconciliation_pending: true, failure_reason: TOOL_SEND_NO_ANSWER }, waitFor: /May have gone out\. Zavi is checking\./ },
  { name: "exec_outcome_unknown settled, no count", over: { may_have_sent: true, reconciliation_pending: false, failure_reason: TOOL_SEND_NO_ANSWER }, waitFor: /did not hear back from the email tool/ },
  { name: "exec_partial with a count", over: { may_have_sent: true, reconciliation_pending: false, sent_count: 1204, failure_reason: `${TOOL_SEND_NO_ANSWER} The email tool reports 1,204 people got it so far.` }, waitFor: /1,204 people got it so far/ },
  { name: "exec_partial, the tool's own words, no count", over: { may_have_sent: true, reconciliation_pending: false, failure_reason: "Zavi could not confirm whether this email went out. It is no longer in Mailchimp. Zavi will not send this card again." }, waitFor: /It is no longer in Mailchimp\./ },
  { name: "partial_risk bucket on a retryable-looking card", over: { may_have_sent: true, reconciliation_pending: false, retryable: true, failure_reason: TOOL_SEND_NO_ANSWER }, waitFor: /did not hear back from the email tool/ },
  { name: "may have sent on a test list", over: { may_have_sent: true, reconciliation_pending: false, test_list: true, failure_reason: TOOL_SEND_NO_ANSWER }, waitFor: /did not hear back from the email tool/ },
];

describe("EmailCampaignCard: a tool send that may have gone out never invites a second send", () => {
  for (const c of mayHaveSent) {
    it(`${c.name}: no redraft or not-retryable tail, no Failed badge, reads Delivery unknown`, async () => {
      serve(failed(c.over));
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await waitFor(() => expect(text()).toMatch(c.waitFor));
      expect(text()).not.toMatch(/draft it again/i);
      expect(text()).not.toMatch(/cannot be tried again/i);
      expect(text()).not.toMatch(/Ask Zavi for a new draft/i);
      expect(text()).not.toMatch(/try it again|then try again/i);
      expect(text()).not.toMatch(/\bFailed\b/);
      expect(badge()).toBe("Delivery unknown: A");
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
      expect(calls.filter((x) => x.method !== "GET")).toEqual([]);
    });
  }

  it("may_have_sent false keeps the not-retryable tail and the Failed badge", async () => {
    serve(failed({ may_have_sent: false, failure_reason: "Mailchimp did not accept this email. Nothing was sent." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(text()).toMatch(/Mailchimp did not accept this email\./));
    expect(text()).toContain("This one cannot be tried again. Ask Zavi to draft it again.");
    expect(badge()).toBe("Failed: A");
    expect(text()).not.toMatch(/Delivery unknown/);
  });

  it("may_have_sent missing reads the same as false", async () => {
    serve(failed({ failure_reason: "Mailchimp did not accept this email. Nothing was sent." }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(text()).toMatch(/Mailchimp did not accept this email\./));
    expect(text()).toContain("This one cannot be tried again. Ask Zavi to draft it again.");
    expect(badge()).toBe("Failed: A");
  });

  it("the Zavi bulk outcome_unknown card keeps its own wording and badge", async () => {
    answers[`GET /api/email-cards/decisions/${ID}`] = { status: 200, body: { card: failed({ rail: "decisions", status: "outcome_unknown", may_have_sent: true, reconciliation_pending: false, failure_reason: "These emails may have gone out: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice." }) } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(text()).toMatch(/email provider did not confirm them/));
    expect(badge()).toBe("Delivery unknown: A");
    expect(text()).not.toMatch(/draft it again|cannot be tried again/i);
  });
});
