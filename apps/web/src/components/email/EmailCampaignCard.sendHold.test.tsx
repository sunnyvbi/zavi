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
import { EmailCampaignCard, HELD_SEND_COPY, type EmailCardView } from "./EmailCampaignCard";

const ID = "33333333-3333-4333-8333-333333333333";
const BASE = `/api/email-cards/channel_actions/${ID}`;
const ABUSE_REFUSAL = "Bulk email is paused for this workspace because too many people marked a recent email as spam or it bounced. Contact support to switch it back on.";

function card(over: Partial<EmailCardView> = {}): EmailCardView {
  return {
    rail: "channel_actions",
    id: ID,
    class: "email_campaign.create_and_send",
    status: "pending",
    open: true,
    route: "zavi_list",
    list: { name: "Yopmail testers", people: 6 },
    sender: { email: "hello@yopmail.com", name: "Yop" },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2, 3].map((n) => ({
      variant: n,
      subject: `Subject ${n}`,
      preview_text: `Preview ${n}`,
      html: `<p>Version ${n}</p>`,
      tested_by_me: n === 1,
      tested_by_approver: n === 1,
    })),
    can_approve: [true, false, false],
    reasons: [],
    ...over,
  };
}

const failedCard = (over: Partial<EmailCardView> = {}) =>
  card({ open: false, status: "failed", chosen_variant: 1, editable: false, retryable: true, failure_reason: "Zavi's sender did not answer.", can_approve: [false, false, false], ...over });

function setup(c: EmailCardView, pause: unknown) {
  answers[`GET ${BASE}`] = { status: 200, body: { card: c } };
  answers[`GET ${BASE}/count`] = { status: 200, body: { people: 6 } };
  answers["GET /api/workspace/email-pause"] = { status: 200, body: pause };
  render(
    <>
      <ConfirmDialogHost />
      <EmailCampaignCard rail="channel_actions" id={ID} />
    </>,
  );
}

const sendPosts = () => calls.filter((c) => c.method === "POST" && (c.url.endsWith("/approve") || c.url.endsWith("/resume") || c.url.endsWith("/schedule")));
const approveButton = async () => {
  const b = (await screen.findByRole("button", { name: /Approve and send A/ })) as HTMLButtonElement;
  await waitFor(() => expect(b.disabled).toBe(false));
  return b;
};
const dialog = () => screen.findByRole("alertdialog");
const SEND_LABELS = [/^Send now$/, /send when resumed/i, /^Confirm$/];

function expectNoSendButton(d: HTMLElement) {
  for (const label of SEND_LABELS) expect(within(d).queryByRole("button", { name: label })).toBeNull();
  expect(within(d).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(cleanup);

describe("Flow 33: Approve and send while Zavi's own sender is held", () => {
  const holds = ["global", "abuse", "disabled", "unknown"] as const;

  for (const held of holds) {
    for (const paused of [false, true]) {
      it(`${held} hold (founder pause ${paused ? "on" : "off"}): the dialog says it is held, offers no send, and no click sends`, async () => {
        setup(card(), { paused, held });
        fireEvent.click(await approveButton());
        const d = await dialog();
        expect(within(d).getByRole("heading").textContent).toBe(HELD_SEND_COPY[held].title);
        expect(d.textContent).toContain(HELD_SEND_COPY[held].body);
        expect(d.textContent).not.toMatch(/Send to 6 people\?/);
        expect(d.textContent).not.toMatch(/in batches/);
        expect(d.textContent).not.toMatch(/resumes email/);
        expectNoSendButton(d);
        fireEvent.keyDown(document, { key: "Enter" });
        fireEvent.click(within(d).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        fireEvent.click(await approveButton());
        const again = await dialog();
        expectNoSendButton(again);
        await waitFor(() => {
          fireEvent.keyDown(document, { key: "Escape" });
          expect(screen.queryByRole("alertdialog")).toBeNull();
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(sendPosts()).toEqual([]);
      });
    }
  }

  it("global stop and this-workspace abuse hold use distinct words", async () => {
    setup(card(), { paused: false, held: "global" });
    fireEvent.click(await approveButton());
    const g = (await dialog()).textContent ?? "";
    expect(g).toContain("Zavi sender stopped");
    expect(g).toMatch(/every workspace/);
    expect(g).not.toMatch(/spam|bounced|this workspace/);
    cleanup();
    calls.length = 0;
    setup(card(), { paused: false, held: "abuse" });
    fireEvent.click(await approveButton());
    const a = (await dialog()).textContent ?? "";
    expect(a).toMatch(/held for this workspace/);
    expect(a).toMatch(/too many people marked a recent email as spam or it bounced/);
    expect(a).not.toContain("Zavi sender stopped");
    expect(a).not.toMatch(/every workspace/);
  });

  it("81d8: a test refused for the abuse hold keeps its notice through opening and closing the approve dialog, and nothing is sent", async () => {
    setup(card(), { paused: false, held: "abuse" });
    answers[`POST ${BASE}/test`] = { status: 409, body: { error: { code: "bulk_abuse_hold", message: ABUSE_REFUSAL } } };
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A to/ }));
    const notice = await screen.findByText("The test was not sent");
    expect(screen.getByText(ABUSE_REFUSAL)).toBeDefined();
    fireEvent.click(await approveButton());
    const d = await dialog();
    expectNoSendButton(d);
    expect(screen.getByText("The test was not sent")).toBe(notice);
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("The test was not sent")).toBeDefined();
    expect(screen.getAllByText(ABUSE_REFUSAL).length).toBeGreaterThan(0);
    expect(sendPosts()).toEqual([]);
  });

  it("an unrecognised hold value fails closed as unknown", async () => {
    setup(card(), { paused: false, held: "something_new" });
    fireEvent.click(await approveButton());
    const d = await dialog();
    expect(within(d).getByRole("heading").textContent).toBe(HELD_SEND_COPY.unknown.title);
    expectNoSendButton(d);
  });

  it("Try again on a failed Zavi-list send under a global stop offers no send and sends nothing", async () => {
    setup(failedCard(), { paused: false, held: "global" });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const d = await dialog();
    expect(within(d).getByRole("heading").textContent).toBe("Zavi sender stopped");
    expectNoSendButton(d);
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sendPosts()).toEqual([]);
  });

  it("a hold on Zavi's sender does not block a card that sends through the founder's own tool", async () => {
    setup(card({ route: "sendgrid", unsubscribe_group_id: "7" }), { paused: false, held: "global" });
    fireEvent.click(await approveButton());
    const d = await dialog();
    expect(within(d).getByRole("heading").textContent).toBe("Send to 6 people?");
    expect(within(d).getByRole("button", { name: "Send now" })).toBeDefined();
  });

  it("with no hold, cancelling the plain Send now dialog keeps an earlier refusal notice", async () => {
    setup(card(), { paused: false, held: null });
    answers[`POST ${BASE}/test`] = { status: 409, body: { error: { code: "x", message: "Your sending domain is not verified yet." } } };
    fireEvent.click(await screen.findByRole("button", { name: /Send test of A to/ }));
    await screen.findByText("The test was not sent");
    fireEvent.click(await approveButton());
    const d = await dialog();
    expect(within(d).getByRole("button", { name: "Send now" })).toBeDefined();
    expect(screen.getByText("The test was not sent")).toBeDefined();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("The test was not sent")).toBeDefined();
    expect(sendPosts()).toEqual([]);
  });
});
