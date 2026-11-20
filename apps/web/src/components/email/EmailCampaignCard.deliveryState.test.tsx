// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Answer = { status: number; body: unknown };
const answers: Record<string, Answer> = {};
const calls: { url: string; method: string; body?: unknown }[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { sentPill } from "@/components/workspace/email/SentEmailsBlock";
import { EmailCampaignCard, LIST_UNCHECKED_LINE, suppressionLine, type EmailCardView } from "./EmailCampaignCard";

const ID = "44444444-4444-4444-8444-444444444444";
const BASE = `/api/email-cards/decisions/${ID}`;
const MAY_HAVE = "Zavi stopped this send. 3 people got it, and 2 more may have: their email provider never confirmed. Zavi will not send it to them again.";
const STALE = "7 people were not emailed.";

function card(over: Partial<EmailCardView>): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "stopped",
    open: false,
    route: "zavi_list",
    list: { name: "Members", people: 10 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: null,
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

const text = () => document.body.textContent ?? "";
const badge = () => screen.getByTestId("email-card-status").textContent ?? "";
const outcome = (over: Record<string, unknown>) => ({ status: "outcome_unknown", sent: 3, total: 10, unknown: 2, may_have_sent: true, reason: MAY_HAVE, pause_hold: null, ...over }) as EmailCardView["outcome"];

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

afterEach(() => {
  cleanup();
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});

const sendgridSent = (over: Partial<EmailCardView>) =>
  card({ route: "sendgrid", status: "sent", sent_at: "2026-11-02T06:30:48Z", sent_count: null, ...over });
const show = async (c: EmailCardView) => {
  answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
  render(<EmailCampaignCard rail="decisions" id={ID} />);
  return screen.findByTestId("email-card-outcome");
};

describe("a SendGrid send on the card", () => {
  it("accepted, no numbers yet: the badge reads Sent, the line stays honest and no list count shows", async () => {
    const box = await show(sendgridSent({ delivery: "unconfirmed" }));
    await waitFor(() => expect(box.textContent).toMatch(/SendGrid accepted this send.*Delivery is not confirmed yet\./));
    expect(box.textContent).not.toMatch(/^Sent/);
    expect(badge()).toMatch(/^Sent/);
    expect(badge()).not.toMatch(/Accepted/);
    expect(box.textContent).not.toMatch(/\b10\b people/);
  });

  it("nobody reached: says so with the reason", async () => {
    const box = await show(sendgridSent({ delivery: "nobody", failure_reason: "SendGrid accepted this send but reports that nobody received it." }));
    await waitFor(() => expect(box.textContent).toMatch(/SendGrid reached nobody/));
    expect(screen.getByTestId("email-card-outcome-reason").textContent).toMatch(/nobody received it/);
    expect(badge()).toMatch(/^Nobody reached/);
  });

  it("reached: the real number", async () => {
    const box = await show(sendgridSent({ delivery: "reached", sent_count: 3 }));
    await waitFor(() => expect(box.textContent).toMatch(/Sent to 3 people/));
  });
});

describe("the unsubscribed line before approve", () => {
  it("gives the real number when some are gone", () => {
    expect(suppressionLine({ suppressed: 2, complete: true }, 5)).toBe("2 on this list are unsubscribed, so SendGrid skips them. 3 of 5 can get it.");
  });
  it("says everyone", () => {
    expect(suppressionLine({ suppressed: 5, complete: true }, 5)).toMatch(/^Everyone on this list/);
  });
  it("never reads as clear when the check could not finish", () => {
    expect(suppressionLine({ suppressed: 0, complete: false }, 5)).toMatch(/could not fully check/);
    expect(suppressionLine({ suppressed: 1, complete: false }, 5)).toMatch(/could not fully check/);
  });
});

describe("the Sent emails pill", () => {
  const row = (delivery: string | null) => ({ delivery, outcome: null, stop_note: null }) as unknown as Parameters<typeof sentPill>[0];
  it("reads Sent once the tool accepted it, for every tool", () => {
    expect(sentPill({ ...row("unconfirmed"), sent_with: "SendGrid" }).text).toBe("Sent");
    expect(sentPill({ ...row("unconfirmed"), sent_with: "Klaviyo" }).text).toBe("Sent");
    expect(sentPill({ ...row("reached"), delivery_skipped: 3 }).text).toBe("Some skipped");
    expect(sentPill(row("nobody")).text).toBe("Nobody reached");
    expect(sentPill(row("reached")).text).toBe("Sent");
    expect(sentPill(row(null)).text).toBe("Sent");
  });
});

describe("the people a card shows before and after a send", () => {
  const mount = (c: EmailCardView) => {
    answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
  };
  const body = () => calls.filter((c) => c.method === "POST").map((c) => c.body);

  it("Klaviyo before results: the badge reads Sent, the line names Klaviyo and not SendGrid", async () => {
    await show(card({ route: "klaviyo", status: "sent", delivery: "unconfirmed", sent_count: null, sent_at: "2026-11-02T06:30:48Z" }));
    await waitFor(() => expect(badge()).toMatch(/^Sent/));
    expect(badge()).not.toContain("Accepted");
    expect(text()).toContain("Klaviyo accepted this send");
    expect(text()).not.toContain("SendGrid");
  });

  it("1 of 4: the outcome says 1 and tells the skip plainly, though the send-time outcome said 4", async () => {
    await show(card({ route: "klaviyo", status: "sent", delivery: "reached", sent_count: 1, skipped_count: 3, sent_at: "2026-11-02T06:30:48Z", failure_reason: "Klaviyo skipped 3 of 4 people, so 1 person received it. Check the skipped addresses in Klaviyo.", outcome: outcome({ status: "sent", sent: 4, total: null, unknown: 0, may_have_sent: false, reason: null }) }));
    await waitFor(() => expect(screen.getByTestId("email-card-outcome").textContent).toContain("Sent to 1 person"));
    expect(screen.getByTestId("email-card-outcome").textContent).not.toContain("Sent to 4");
    expect(screen.getByTestId("email-card-outcome-reason").textContent).toContain("skipped 3 of 4");
    expect(badge()).toContain("Some skipped");
  });

  it("a Zavi list send says who was left out, and the badge stays Sent", async () => {
    await show(card({ status: "sent", sent_count: 3, left_out_count: 2, list: { name: "Testing", people: 3 }, outcome: outcome({ status: "sent", sent: 3, total: 3, unknown: 0, may_have_sent: false, reason: null }) }));
    await waitFor(() => expect(screen.getByTestId("email-card-outcome").textContent).toContain("Sent to 3 people"));
    expect(screen.getByTestId("email-card-left-out").textContent).toBe("2 people on this list were left out because they unsubscribed or bounced.");
    expect(badge()).toMatch(/^Sent/);
  });

  it("one left out reads in the singular, and none shows no line", async () => {
    await show(card({ status: "sent", sent_count: 3, left_out_count: 1, outcome: outcome({ status: "sent", sent: 3, total: 3, unknown: 0, may_have_sent: false, reason: null }) }));
    await waitFor(() => expect(screen.getByTestId("email-card-left-out").textContent).toBe("1 person on this list was left out because they unsubscribed or bounced."));
    cleanup();
    await show(card({ status: "sent", sent_count: 3, outcome: outcome({ status: "sent", sent: 3, total: 3, unknown: 0, may_have_sent: false, reason: null }) }));
    await waitFor(() => expect(screen.getByTestId("email-card-outcome")).toBeTruthy());
    expect(screen.queryByTestId("email-card-left-out")).toBeNull();
  });

  it("an open draft tells who will be left out before approval", async () => {
    mount(card({ status: "pending", open: true, chosen_variant: null, list: { name: "Testing", people: 3, left_out: 2 } }));
    await waitFor(() => expect(screen.getByTestId("email-card-will-leave-out").textContent).toBe("2 people on this list are left out because they unsubscribed or bounced."));
    expect(screen.getByTestId("email-card-to").textContent).toContain("Testing · 3 people");
  });

  it("an unchecked list says so on the To row and shows no number", async () => {
    mount(card({ route: "klaviyo", status: "pending", open: true, chosen_variant: null, list: { name: "Zavi QA", people: null, unchecked: true } }));
    await waitFor(() => expect(screen.getByTestId("email-card-count-unchecked").textContent).toBe(LIST_UNCHECKED_LINE));
    expect(screen.getByTestId("email-card-to").textContent).toBe("Zavi QA");
  });

  it("an interrupted send never tells the founder to fix something", async () => {
    mount(card({ route: "klaviyo", status: "failed", retryable: true, chosen_variant: 1, failure_reason: "This send was interrupted before anything went out. Nothing was sent. Approve it again." }));
    await waitFor(() => expect(text()).toContain("was interrupted"));
    expect(text()).not.toContain("Fix that");
    expect(text()).toContain("The same approved version is sent");
  });

  it("another failed send keeps its Fix that", async () => {
    mount(card({ route: "klaviyo", status: "failed", retryable: true, chosen_variant: 1, failure_reason: "Klaviyo refused the sender. Nothing was sent." }));
    await waitFor(() => expect(text()).toContain("Fix that, then try again."));
  });

  it("Try again sends the number shown in the dialog, not the one the card loaded with", async () => {
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 1 } };
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true, queued: true, changed: true } };
    mount(card({ route: "klaviyo", status: "failed", retryable: true, chosen_variant: 1, list: { name: "Zavi QA", people: 4 }, failure_reason: "Klaviyo refused the sender. Nothing was sent." }));
    await screen.findByRole("button", { name: /try again/i }).then((b) => b.click());
    await waitFor(() => expect(body().length).toBeGreaterThan(0));
    expect(JSON.parse(body()[0] as string)).toMatchObject({ seen_people: 1, variant: 1 });
  });
});
