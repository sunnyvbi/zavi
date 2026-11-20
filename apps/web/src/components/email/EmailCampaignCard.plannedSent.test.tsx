// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string };
const calls: Call[] = [];
const answers: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body), clone() { return this; } });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, PLANNED_STOP_LINE, type EmailCardView, type PlannedOnCard } from "./EmailCampaignCard";

const ID = "55555555-5555-4555-8555-555555555555";
const PID = "66666666-6666-4666-8666-666666666666";
const COUNTED = "Counted again right before you confirm";

const planned = (over: Partial<PlannedOnCard> = {}): PlannedOnCard => ({
  id: PID,
  planned_at: "2099-11-09T10:00:00Z",
  planned_label: "Mon, Nov 9, 10:00",
  timezone: "UTC",
  status: "ready",
  status_reason: null,
  reason: null,
  schedule_gen: 1,
  content_version: 1,
  vetoed: false,
  scheduled: null,
  ...over,
});

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "proposed",
    open: true,
    route: "sendgrid",
    list: { name: "Brightloop members", people: 238 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>V${n}</p>`, tested_by_me: n === 1, tested_by_approver: n === 1 })),
    can_approve: [true, false],
    reasons: [],
    planned_expected: true,
    ...over,
  };
}

const sentCard = (plan: PlannedOnCard | null) =>
  card({
    status: "sent",
    open: false,
    chosen_variant: 1,
    can_approve: [false, false],
    sent_at: "2099-11-09T10:00:41Z",
    sent_count: 238,
    planned: plan,
  });

const serve = (c: EmailCardView) => {
  answers[`GET /api/email-cards/${c.rail}/${c.id}`] = { status: 200, body: { card: c } };
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("EmailCampaignCard: a sent card that came from a planned send", () => {
  it.each([
    ["its planned row is sent", planned({ status: "sent", scheduled: { variant: 1, count: 238, by: "u" } })],
    ["its planned row still reads ready", planned()],
  ])("shows neither the planned chip nor the recount line when %s", async (_name, plan) => {
    serve(sentCard(plan));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toContain("Sent: A"));
    expect(screen.getByTestId("email-card-from").textContent).toContain("hello@brightloop.test");
    expect(screen.queryByTestId("email-card-planned")).toBeNull();
    expect(screen.queryByText(/Planned for/)).toBeNull();
    expect(screen.queryByText(COUNTED)).toBeNull();
    expect(document.body.textContent).not.toContain("Mon, Nov 9, 10:00");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a still-proposed planned card keeps the chip and the recount line", async () => {
    serve(card({ planned: planned() }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-planned"));
    expect(screen.getByTestId("email-card-planned").textContent).toContain("Planned for Mon, Nov 9, 10:00 UTC");
    expect(screen.getByText(COUNTED)).toBeDefined();
  });

  it("a planned card approved for its time, still open, hides the Planned for chip and keeps only the stop note", async () => {
    serve(card({ planned: planned({ status: "scheduled", scheduled: { variant: 1, count: 238, by: "u" } }) }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-scheduled"));
    expect(screen.queryByTestId("email-card-planned")).toBeNull();
    expect(screen.getByTestId("email-card-scheduled").textContent).toBe(PLANNED_STOP_LINE);
    expect(screen.getByTestId("email-card-scheduled").textContent).not.toMatch(/Approved for/);
  });
});

describe("EmailCampaignCard: the details panel of a sent card", () => {
  const learnings = { status: "ok" as const, items: [{ id: "l1", text: "Short subjects got more opens." }] };

  it("To shows the count it was sent to, not the list's size now, and the learnings say this email", async () => {
    serve(card({ status: "sent", open: false, chosen_variant: 1, can_approve: [false, false], sent_at: "2099-11-09T10:00:41Z", sent_count: 1, list: { name: "QA messy 1026", people: 0 }, learnings_read: learnings }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-status").textContent).toContain("Sent: A"));
    expect(screen.getByTestId("email-card-to").textContent).toBe("QA messy 1026 · 1 person");
    expect(document.body.textContent).not.toContain("0 people");
    expect(screen.getByTestId("email-card-learnings").querySelector("summary")!.textContent).toBe("Zavi read 1 learning for this email");
    expect(document.body.textContent).not.toContain("learning for this draft");
    const side = screen.getByTestId("email-card-side");
    expect(screen.queryByTestId("email-card-tests")).toBeNull();
    expect(side.contains(screen.getByTestId("email-card-learnings"))).toBe(true);
    expect(screen.getByRole("tab", { name: /A · Subject 1/ }).getAttribute("title")).toBe("A · Subject 1");
  });

  it("an open draft keeps the list's size and says this draft", async () => {
    serve(card({ list: { name: "QA messy 1026", people: 0 }, learnings_read: learnings }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => screen.getByTestId("email-card-to"));
    expect(screen.getByTestId("email-card-to").textContent).toBe("QA messy 1026 · 0 people");
    expect(screen.getByTestId("email-card-learnings").querySelector("summary")!.textContent).toBe("Zavi read 1 learning for this draft");
  });
});
