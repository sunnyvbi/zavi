// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const answers: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const a = answers[`${init?.method ?? "GET"} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";

const ID = "55555555-5555-4555-8555-555555555555";
const view = (over: Partial<EmailCardView>): EmailCardView => ({
  rail: "channel_actions",
  id: ID,
  class: "email_campaign.create_and_send",
  status: "failed",
  open: false,
  route: "sendgrid",
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
});
const mount = async (c: EmailCardView, props: { canCancel?: boolean; onReject?: (note?: string) => void | Promise<unknown> } = {}) => {
  answers[`GET /api/email-cards/channel_actions/${ID}`] = { status: 200, body: { card: c } };
  render(<EmailCampaignCard rail="channel_actions" id={ID} canCancel onReject={vi.fn(async () => true)} {...props} />);
  await screen.findByTestId("email-card-status");
};
afterEach(cleanup);

describe("Cancel on a failed email card", () => {
  it("rejects the failed card with no note, one press", async () => {
    const onReject = vi.fn(async () => true);
    await mount(view({ status: "failed" }), { onReject });
    fireEvent.click(screen.getByTestId("email-card-cancel"));
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect(onReject).toHaveBeenCalledWith();
  });

  it.each(["failed", "dispatch_failed", "not_sent", "outcome_unknown"])("is offered on %s", async (status) => {
    await mount(view({ status }));
    expect(screen.getByTestId("email-card-cancel").textContent).toBe("Cancel");
  });

  it("stays beside Try again on a failure that can be retried", async () => {
    await mount(view({ status: "failed", retryable: true }));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByTestId("email-card-cancel")).toBeTruthy();
  });

  it("is offered when the send may have gone out, and goes through the same reject", async () => {
    const onReject = vi.fn(async () => true);
    await mount(view({ status: "failed", may_have_sent: true }), { onReject });
    fireEvent.click(screen.getByTestId("email-card-cancel"));
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
  });

  it.each(["sending", "dispatching", "queued", "sent", "waiting_for_tomorrow"])("is never offered on %s", async (status) => {
    await mount(view({ status }));
    expect(screen.queryByTestId("email-card-cancel")).toBeNull();
  });

  it("is not offered while Zavi is still finding out what happened", async () => {
    await mount(view({ status: "failed", may_have_sent: true, reconciliation_pending: true }));
    expect(screen.queryByTestId("email-card-cancel")).toBeNull();
  });

  it("is not offered when the lane says the row cannot be rejected", async () => {
    await mount(view({ status: "failed" }), { canCancel: false });
    expect(screen.queryByTestId("email-card-cancel")).toBeNull();
  });

  it("says so when the reject did not go through, and the card stays", async () => {
    await mount(view({ status: "failed" }), { onReject: vi.fn(async () => { throw new Error("offline"); }) });
    fireEvent.click(screen.getByTestId("email-card-cancel"));
    await screen.findByText("Not cancelled");
    expect(screen.getByTestId("email-card-cancel")).toBeTruthy();
  });
});
