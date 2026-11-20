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

describe("EmailCampaignCard reads the shared outcome when people may have been emailed (ROI #4)", () => {
  it("a stopped card whose outcome may have sent shows outcome.reason and never a locally built not-emailed line", async () => {
    answers[`GET ${BASE}`] = { status: 200, body: { card: card({ status: "stopped", sent_count: 3, may_have_sent: false, failure_reason: STALE, outcome: outcome({}) }) } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-outcome-reason").textContent).toBe(MAY_HAVE));
    expect(text()).not.toMatch(/were not emailed/);
    expect(text()).not.toMatch(/The rest were not sent/);
    expect(text()).not.toContain(STALE);
    expect(badge()).toMatch(/^Delivery unknown(: [A-C])?$/);
    expect(badge()).not.toMatch(/Stopped|Sent|Failed/);
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(calls.filter((x) => x.method !== "GET")).toEqual([]);
  });

  it("a sent card whose outcome is unknown never reads Sent and shows the outcome reason", async () => {
    answers[`GET ${BASE}`] = { status: 200, body: { card: card({ status: "sent", sent_count: 10, failure_reason: null, outcome: outcome({}) }) } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-outcome-reason").textContent).toBe(MAY_HAVE));
    expect(badge()).toMatch(/^Delivery unknown/);
    expect(text()).not.toMatch(/were not emailed/);
  });

  it("a stopped card the outcome says nobody may have got keeps its stopped wording", async () => {
    answers[`GET ${BASE}`] = { status: 200, body: { card: card({ status: "stopped", sent_count: 3, failure_reason: null, outcome: outcome({ status: "stopped", unknown: 0, may_have_sent: false, reason: "Stopped after 3 people." }) }) } };
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(text()).toMatch(/Stopped/));
    expect(badge()).not.toMatch(/Delivery unknown/);
  });
});
