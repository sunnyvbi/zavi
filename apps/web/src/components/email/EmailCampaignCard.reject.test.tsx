// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
type Answer = { status: number; body: unknown };
const answers: Record<string, Answer> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = answers[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body), clone() { return this; } });
  },
}));
const confirm = vi.hoisted(() => ({ fn: vi.fn(async (_o: { title: string; description?: string }) => true) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: confirm.fn }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardRail, type EmailCardView } from "./EmailCampaignCard";
import { ApprovalBlock } from "@/components/agents/ApprovalBlock";
import { ChannelActionCard } from "@/components/workspace/actions/ChannelActionCard";
import { platformFor } from "@/components/workspace/actions/platforms";
import { makeAction } from "@/components/workspace/actions/__tests__/fixtures";

const ID = "44444444-4444-4444-8444-444444444444";

function card(rail: EmailCardRail, id: string, over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail,
    id,
    class: "email_campaign.create_and_send",
    status: rail === "decisions" ? "proposed" : "pending",
    open: true,
    route: "sendgrid",
    list: { name: "Brightloop members", people: 238 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: false,
    chosen_variant: null,
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>V${n}</p>`, tested_by_me: false, tested_by_approver: false })),
    can_approve: [false, false],
    reasons: [],
    ...over,
  };
}

const serve = (c: EmailCardView) => {
  answers[`GET /api/email-cards/${c.rail}/${c.id}`] = { status: 200, body: { card: c } };
};
const writes = () => calls.filter((c) => c.method !== "GET");
const rejectOpener = () => screen.getByRole("button", { name: "Reject" });
const submitReject = () => screen.getByTestId("email-card-reject").querySelector("button[type=submit]") as HTMLButtonElement;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("Reject on an open email card", () => {
  it("the Reject opener is the solid red Danger button with white text, before the form opens", async () => {
    serve(card("channel_actions", ID, { viewer_can_approve: true }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    expect(rejectOpener().className).toContain("bg-danger");
    expect(rejectOpener().className).toContain("text-white");
  });

  it("the final Reject in the form is the Danger button, not the solid primary", async () => {
    serve(card("decisions", ID, { viewer_can_approve: true, can_approve: [true, true] }));
    render(<EmailCampaignCard rail="decisions" id={ID} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    const cls = submitReject().className.split(/\s+/);
    expect(cls).toContain("bg-danger");
    expect(cls).not.toContain("bg-ink");
  });

  it("channel_actions host: Reject with a reason calls onSetStatus(action, rejected, {note}) exactly once and posts nothing itself", async () => {
    const open = makeAction("send_message", { channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    serve(card("channel_actions", open.id));
    const onSetStatus = vi.fn(async () => undefined);
    render(<ChannelActionCard action={open} platform={platformFor("email_marketing")} handlers={{ onSetStatus, onRedo: vi.fn() }} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Wrong list" } });
    fireEvent.click(submitReject());
    fireEvent.click(submitReject());
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledTimes(1));
    expect(onSetStatus).toHaveBeenCalledWith(open, "rejected", { note: "Wrong list" });
    expect(writes()).toEqual([]);
  });

  it("channel_actions with no host handler requires a reason and posts it once", async () => {
    serve(card("channel_actions", ID));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    expect(submitReject().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Wrong list" } });
    fireEvent.click(submitReject());
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect([w.method, w.url]).toEqual(["POST", `/api/channel-actions/${ID}`]);
    expect((w.body as { action: string; note: string; request_id: string })).toMatchObject({ action: "rejected", note: "Wrong list" });
    expect((w.body as { request_id: string }).request_id.length).toBeGreaterThanOrEqual(8);
  });

  it("decisions host (chat): Reject calls POST /api/approvals/:id/reject once and resolves the chat card as rejected", async () => {
    serve(card("decisions", ID));
    const onResolved = vi.fn();
    render(<ApprovalBlock body={{ decision_id: ID, decision_class: "bulk_outbound.send", title: "Email to send" }} onResolved={onResolved} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    expect(screen.queryByLabelText("Why are you rejecting it?")).toBeNull();
    fireEvent.click(submitReject());
    fireEvent.click(submitReject());
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith(ID, "rejected");
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual([`POST /api/approvals/${ID}/reject?surface=chat`]);
  });

  it("a refused decisions reject says so and does not resolve the card", async () => {
    serve(card("decisions", ID));
    answers[`POST /api/approvals/${ID}/reject`] = { status: 409, body: { error: { code: "already_decided", message: "This was already decided." } } };
    const onRejected = vi.fn();
    render(<EmailCampaignCard rail="decisions" id={ID} onRejected={onRejected} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    fireEvent.click(submitReject());
    await waitFor(() => expect(screen.getByText("Not rejected")).toBeDefined());
    expect(screen.getByText("This was already decided.")).toBeDefined();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("a reject refused because the card was approved in another tab reloads the card, so Approve and Reject are gone", async () => {
    serve(card("channel_actions", ID, { viewer_can_approve: true }));
    answers[`POST /api/channel-actions/${ID}`] = { status: 409, body: { error: { code: "illegal_transition", message: "That action can't be changed from here." } } };
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Already approved" } });
    serve(card("channel_actions", ID, { status: "sending", open: false, chosen_variant: 1, viewer_can_approve: true }));
    const readsBefore = calls.filter((c) => c.method === "GET" && c.url === `/api/email-cards/channel_actions/${ID}`).length;
    fireEvent.click(submitReject());
    await waitFor(() => expect(screen.getByText("Not rejected")).toBeDefined());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reject" })).toBeNull());
    expect(calls.filter((c) => c.method === "GET" && c.url === `/api/email-cards/channel_actions/${ID}`).length).toBe(readsBefore + 1);
    expect(screen.queryByRole("button", { name: /Approve and send|Send a test first/ })).toBeNull();
    expect(screen.queryByTestId("email-card-reject")).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it("a lane reject the host refused reloads the card instead of leaving a stale open card", async () => {
    const open = makeAction("send_message", { channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    serve(card("channel_actions", open.id, { viewer_can_approve: true }));
    const onSetStatus = vi.fn(async () => false);
    render(<ChannelActionCard action={open} platform={platformFor("email_marketing")} handlers={{ onSetStatus, onRedo: vi.fn() }} />);
    await waitFor(() => expect(rejectOpener()).toBeDefined());
    fireEvent.click(rejectOpener());
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Wrong list" } });
    serve(card("channel_actions", open.id, { status: "sending", open: false, chosen_variant: 1, viewer_can_approve: true }));
    fireEvent.click(submitReject());
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reject" })).toBeNull());
    expect(screen.queryByRole("button", { name: /Approve and send|Send a test first/ })).toBeNull();
  });

  for (const status of ["approved", "dispatching", "sending", "sent", "failed"]) {
    it(`a ${status} card (approved, no longer open) shows no Reject`, async () => {
      serve(card("decisions", ID, { status, open: false, chosen_variant: 1, retryable: status === "failed" }));
      render(<EmailCampaignCard rail="decisions" id={ID} />);
      await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
      await screen.findAllByText(/Subject 1/);
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    });
  }

  it("a planned email (it has its own Don't send) shows no Reject", async () => {
    serve(card("channel_actions", ID, { planned_expected: true }));
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await screen.findAllByText(/Subject 1/);
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});
