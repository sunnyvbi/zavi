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

import { EmailCampaignCard, type EmailCardView, type PlannedOnCard } from "./EmailCampaignCard";

const ID = "77777777-7777-4777-8777-777777777777";
const PID = "88888888-8888-4888-8888-888888888888";
const EXACT = /This is exactly what is sent/;
const WIN = { text: "At least 12 clicks by day 7", metric: "clicks", threshold: 12, frozen: false };

const scheduledPlan = (): PlannedOnCard => ({
  id: PID,
  planned_at: "2099-10-30T05:00:00Z",
  planned_label: "Fri, Oct 30, 05:00",
  timezone: "UTC",
  status: "scheduled",
  status_reason: null,
  reason: null,
  schedule_gen: 1,
  content_version: 1,
  vetoed: false,
  scheduled: { variant: 1, count: 3, by: "u" },
});

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "decisions",
    id: ID,
    class: "bulk_outbound.send",
    status: "proposed",
    open: true,
    route: "zavi_list",
    list: { name: "Newsletter", people: 3 },
    sender: { email: "hello@bakery.test", name: null },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [{ variant: 1, subject: "Fresh from the oven today", preview_text: "Chocolate cake box", html: "<p>Cake</p>", tested_by_me: true, tested_by_approver: true }],
    can_approve: [true],
    reasons: [],
    win_line: WIN,
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET /api/email-cards/${c.rail}/${c.id}`] = { status: 200, body: { card: c } };
};
const status = () => screen.getByTestId("email-card-status").textContent ?? "";

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("EmailCampaignCard: closed cards say what happened", () => {
  it("a sent card whose planned row still reads scheduled says Sent: A with the sent count, not Approved A for its time", async () => {
    serve(card({ status: "sent", open: false, chosen_variant: 1, can_approve: [false], sent_at: "2099-10-30T05:00:41Z", sent_count: 5, planned: scheduledPlan(), planned_expected: true }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Sent: A"));
    expect(status()).not.toMatch(/Approved A for/);
    expect(document.body.textContent).not.toContain("Fri, Oct 30, 05:00");
    expect(document.body.textContent).toContain("Sent to");
    expect(document.body.textContent).not.toContain("Audience");
    expect(screen.queryByTestId("email-card-scheduled")).toBeNull();
    expect(screen.queryByTestId("email-card-scheduled-tracker")).toBeNull();
    expect(screen.queryByRole("button", { name: /Don.t send/ })).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("Notion Flow 26: while an email is scheduled, Ask Zavi to change it cannot start a redraft that would drop the schedule", async () => {
    const ask = vi.fn();
    serve(card({ editable: true, planned: scheduledPlan(), planned_expected: true }));
    render(<EmailCampaignCard rail="decisions" id={ID} onAskZavi={ask} />);
    const button = (await screen.findByRole("button", { name: "Ask Zavi to change it" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("email-card-scheduled-edit").textContent).toContain("Don't send");
    button.click();
    expect(ask).not.toHaveBeenCalled();
  });

  it("control: an unscheduled planned card can still ask Zavi", async () => {
    const ask = vi.fn();
    serve(card({ editable: true, planned: { ...scheduledPlan(), status: "ready", scheduled: null }, planned_expected: true }));
    render(<EmailCampaignCard rail="decisions" id={ID} onAskZavi={ask} />);
    const button = (await screen.findByRole("button", { name: "Ask Zavi to change it" })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("an open card approved for its time keeps Approved A for its time", async () => {
    serve(card({ planned: scheduledPlan(), planned_expected: true }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toContain("Approved A for Fri, Oct 30, 05:00"));
  });

  it.each([["decisions"], ["channel_actions"]] as const)("Notion Flow 26: a rejected %s card says Rejected, not Decided, and claims neither the send nor a day-7 goal", async (rail) => {
    serve(card({ rail, status: "rejected", open: false, chosen_variant: null, can_approve: [false], reasons: ["This email is no longer waiting for approval."] }));
    render(<EmailCampaignCard rail={rail} id={ID} />);
    await waitFor(() => expect(status()).toBe("Rejected"));
    expect(document.body.textContent).not.toContain("Decided");
    expect(document.body.textContent).not.toMatch(EXACT);
    expect(screen.queryByTestId("email-card-win-line")).toBeNull();
    expect(document.body.textContent).not.toContain("Goal for day 7");
    expect(document.body.textContent).not.toContain("Set when sent");
    expect(screen.getByTitle("Email preview, version A")).toBeDefined();
  });

  it("an open card still says the preview is exactly what is sent and shows its day-7 goal", async () => {
    serve(card());
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(status()).toBe("Needs your approval"));
    expect(document.body.textContent).toMatch(EXACT);
    expect(screen.getByTestId("email-card-win-line").textContent).toContain("Set when sent, from your past emails to this list");
  });
});
