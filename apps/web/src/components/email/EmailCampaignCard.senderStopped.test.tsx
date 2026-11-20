// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
type Answer = { status: number; body: unknown };
const answers: Record<string, Answer> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
  },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => ({ email: "founder@yopmail.com" }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { cardPoll, EmailCampaignCard, HELD_SEND_APPROVED_LINE, ResultsRow, HELD_SEND_COPY, HELD_SEND_KEPT_LINE, type EmailCardView } from "./EmailCampaignCard";

const ID = "44444444-4444-4444-8444-444444444444";
const BASE = `/api/email-cards/decisions/${ID}`;
const STOPPED =
  "Zavi sender stopped: Zavi's own sender is stopped for every workspace right now, so nothing was sent. Zavi tries again on its own once the sender is running, or you can Send now then.";

function heldCard(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "bulk_outbound.send",
    status: "held",
    open: false,
    route: "zavi_list",
    list: { name: "Yopmail testers", people: 6 },
    sender: { email: "hello@yopmail.com", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: 1,
    editable: false,
    retryable: true,
    failure_reason: STOPPED,
    pause_hold: null,
    may_have_sent: false,
    sent_count: null,
    versions: [1, 2].map((n) => ({
      variant: n,
      subject: `Subject ${n}`,
      preview_text: `Preview ${n}`,
      html: `<p>Version ${n}</p>`,
      tested_by_me: true,
      tested_by_approver: true,
    })),
    can_approve: [false, false],
    reasons: [],
    ...over,
  } as EmailCardView;
}

const RUNNING_AGAIN =
  "Zavi's own sender was stopped for every workspace when Zavi went to send this approved email, so nothing was sent. The sender is running again: Zavi tries again on its own, or you can Send now.";

function setup(c: EmailCardView, gate: unknown, onApproved?: () => void) {
  answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 6 } };
  answers["GET /api/workspace/email-pause"] = { status: 200, body: gate };
  render(
    <>
      <ConfirmDialogHost />
      <EmailCampaignCard rail="decisions" id={ID} onApproved={onApproved} />
    </>,
  );
}

const approvePosts = () => calls.filter((c) => c.method === "POST" && c.url === `${BASE}/approve`);

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("81e6: an approved Zavi-list card released because Zavi's sender was stopped", () => {
  it("shows the sender-stopped reason and that nothing was sent, never 'starting', and offers Send now instead of Stop the rest", async () => {
    setup(heldCard(), { paused: false, held: null });
    const flight = await screen.findByTestId("email-card-in-flight");
    expect(flight.textContent).toContain("Zavi sender stopped");
    expect(flight.textContent).toContain("nothing was sent");
    expect(document.body.textContent).not.toMatch(/starting/i);
    expect(document.body.textContent).not.toMatch(/Starting the send/);
    expect(screen.getByText("On hold: A")).toBeTruthy();
    expect(within(flight).getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stop the rest/ })).toBeNull();
  });

  it("Send now while the sender is still stopped explains the hold and sends nothing", async () => {
    setup(heldCard(), { paused: false, held: "global" });
    const flight = await screen.findByTestId("email-card-in-flight");
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    expect(d.textContent).toContain(HELD_SEND_COPY.global.title);
    expect(within(d).queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(approvePosts()).toEqual([]);
  });

  it("Send now on a retry repeats the sender warning from the count read", async () => {
    setup(heldCard(), { paused: false, held: null });
    answers[`GET ${BASE}/count`] = { status: 200, body: { people: 6, sender_warning: "The domain is not authenticated." } };
    const flight = await screen.findByTestId("email-card-in-flight");
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    expect(d.textContent).toContain("The domain is not authenticated.");
    expect(within(d).getByRole("button", { name: "Send now" })).toBeTruthy();
  });

  it("Send now once the sender is back on sends the approved version exactly once", async () => {
    setup(heldCard(), { paused: false, held: null });
    const flight = await screen.findByTestId("email-card-in-flight");
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true, queued: true, changed: false } };
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    answers[`GET ${BASE}`] = { status: 200, body: { card: heldCard({ status: "approved", retryable: false, failure_reason: null }) } };
    fireEvent.click(within(d).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(approvePosts()).toHaveLength(1));
    expect(approvePosts()[0].body).toMatchObject({ variant: 1 });
    await screen.findByText("Trying again");
    await new Promise((r) => setTimeout(r, 20));
    expect(approvePosts()).toHaveLength(1);
  });
});

describe("Flow 33: a held card's words match what already happened", () => {
  it("Send now while the sender is stopped says the email is approved but not sent, never that nothing was approved", async () => {
    setup(heldCard(), { paused: false, held: "global" });
    const flight = await screen.findByTestId("email-card-in-flight");
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    expect(d.textContent).toContain(HELD_SEND_COPY.global.body);
    expect(d.textContent).toContain(HELD_SEND_APPROVED_LINE);
    expect(d.textContent).not.toContain(HELD_SEND_KEPT_LINE);
    expect(d.textContent).not.toMatch(/Nothing was approved/);
    expect(d.textContent).toMatch(/approved but not sent yet/);
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(approvePosts()).toEqual([]);
  });

  it("with the sender back on, the held card shows the past-tense reason and never says it is stopped right now", async () => {
    setup(heldCard({ failure_reason: RUNNING_AGAIN }), { paused: false, held: null });
    const flight = await screen.findByTestId("email-card-in-flight");
    expect(flight.textContent).toContain(RUNNING_AGAIN);
    expect(document.body.textContent).not.toMatch(/right now/);
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true, queued: true, changed: false } };
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    expect(d.textContent).toMatch(/Send to 6 people\?/);
    fireEvent.click(within(d).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(approvePosts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(approvePosts()).toHaveLength(1);
  });
});

describe("Flow 33: the Trying again block goes once the send result arrives", () => {
  const saved = { ...cardPoll };
  afterEach(() => {
    Object.assign(cardPoll, saved);
  });
  const sentCard = () => heldCard({ status: "sent", retryable: false, failure_reason: null, sent_count: 3, sent_at: "2026-10-29T10:00:00.000Z" });

  it("Send now, the card shows Trying again while queued, then a poll shows it sent and the block is gone", async () => {
    cardPoll.ms = 20;
    const onApproved = vi.fn();
    setup(heldCard(), { paused: false, held: null }, onApproved);
    const flight = await screen.findByTestId("email-card-in-flight");
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true, queued: true, changed: false } };
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    answers[`GET ${BASE}`] = { status: 200, body: { card: heldCard({ status: "approved", retryable: false, failure_reason: null }) } };
    fireEvent.click(within(d).getByRole("button", { name: "Send now" }));
    await screen.findByText("Trying again");
    answers[`GET ${BASE}`] = { status: 200, body: { card: sentCard() } };
    await screen.findByText(/Sent to 3 people/);
    await waitFor(() => expect(screen.getByText("Sent: A")).toBeTruthy());
    expect(screen.queryByText("Trying again")).toBeNull();
    expect(document.body.textContent).not.toContain("updates this card when it is done");
    const reads = calls.filter((c) => c.method === "GET" && c.url === BASE).length;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((c) => c.method === "GET" && c.url === BASE).length).toBe(reads);
    expect(screen.queryByText("Trying again")).toBeNull();
    expect(approvePosts()).toHaveLength(1);
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("Send now whose first read already shows it sent never shows Trying again, and the host still hears it once", async () => {
    const onApproved = vi.fn();
    setup(heldCard(), { paused: false, held: null }, onApproved);
    const flight = await screen.findByTestId("email-card-in-flight");
    answers[`POST ${BASE}/approve`] = { status: 200, body: { ok: true, queued: true, changed: false } };
    fireEvent.click(within(flight).getByRole("button", { name: "Send now" }));
    const d = await screen.findByRole("alertdialog");
    answers[`GET ${BASE}`] = { status: 200, body: { card: sentCard() } };
    fireEvent.click(within(d).getByRole("button", { name: "Send now" }));
    await screen.findByText(/Sent to 3 people/);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((c) => c.method === "GET" && c.url === BASE)).toHaveLength(2);
    expect(screen.queryByText("Trying again")).toBeNull();
    expect(approvePosts()).toHaveLength(1);
    expect(onApproved).toHaveBeenCalledTimes(1);
  });
});

describe("the results row", () => {
  it("says what a Mailchimp number proves and never Delivered", () => {
    render(<ResultsRow label="After 1 hour:" r={{ delivered: 1, delivered_label: "Not bounced", opens: 0, clicks: 0 }} />);
    const row = screen.getByTestId("email-card-results");
    expect(row.textContent).toContain("Not bounced 1");
    expect(row.textContent).not.toMatch(/delivered/i);
  });

  it("keeps Delivered for a route that reports it", () => {
    render(<ResultsRow label="After 1 hour:" r={{ delivered: 4 }} />);
    expect(screen.getByTestId("email-card-results").textContent).toContain("Delivered 4");
  });
});
