// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const answer = vi.hoisted(() => ({ card: null as unknown, gets: 0 }));
vi.mock("@/lib/api", () => ({
  apiFetch: (_url: string, init?: { method?: string }) => {
    if ((init?.method ?? "GET") === "GET") answer.gets += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ card: answer.card }) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { cardPoll, EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "33333333-3333-4333-8333-333333333333";
const saved = { ...cardPoll };
const sending = (sent: number): EmailCardView => ({
  rail: "decisions",
  id: ID,
  class: "bulk_outbound.send",
  status: "sending",
  open: false,
  route: "zavi_list",
  list: { name: "Testing", people: 30 },
  sender: { email: "hello@brightloop.test", name: null },
  reply_to: null,
  unsubscribe_group_id: null,
  viewer_can_approve: true,
  chosen_variant: 1,
  versions: [{ variant: 1, subject: "S", preview_text: "", html: "<p>1</p>", tested_by_me: true, tested_by_approver: true }],
  can_approve: [false],
  reasons: [],
  sent_count: sent,
  outcome: { status: "sending", sent, total: 30, unknown: 0, may_have_sent: false, reason: null, pause_hold: null },
});

beforeEach(() => {
  answer.gets = 0;
  cardPoll.ms = 20;
});
afterEach(() => {
  cleanup();
  Object.assign(cardPoll, saved);
});

describe("the sent count on a card that is left open", () => {
  it("climbs by itself as each read returns more, on the line and the big number, then polling stops once done", async () => {
    answer.card = sending(0);
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-in-flight").textContent).toContain("0 people sent so far."));

    answer.card = sending(26);
    await waitFor(() => expect(screen.getByTestId("email-card-in-flight").textContent).toContain("26 people sent so far."));
    expect(document.body.textContent).toMatch(/Sent so far/i);
    expect(document.body.textContent).toContain("26");

    answer.card = sending(29);
    await waitFor(() => expect(screen.getByTestId("email-card-in-flight").textContent).toContain("29 people sent so far."));

    answer.card = { ...sending(30), status: "sent", outcome: { status: "sent", sent: 30, total: 30, unknown: 0, may_have_sent: false, reason: null, pause_hold: null } };
    await waitFor(() => expect(screen.queryByTestId("email-card-in-flight")).toBeNull());
    const settled = answer.gets;
    await new Promise((r) => setTimeout(r, 120));
    expect(answer.gets).toBe(settled);
  });
});
