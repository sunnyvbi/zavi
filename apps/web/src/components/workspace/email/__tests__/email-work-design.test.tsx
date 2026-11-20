// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { EmailComingUpBlock } from "../EmailComingUpBlock";
import { TEST_LIST_LINE, TEST_LIST_UNKNOWN_LINE } from "@/components/email/EmailCampaignCard";
import { ChannelActionSection } from "../../actions/ChannelActionSection";
import { platformFor } from "../../actions/platforms";
import { makeAction } from "../../actions/__tests__/fixtures";
import type { ActionHandlers } from "../../actions/types";

const PLAN = "11111111-1111-4111-8111-111111111111";
const CARD = "33333333-3333-4333-8333-333333333333";

const planItem = (over: Record<string, unknown> = {}) => ({
  id: PLAN,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Lapsed regulars",
  planned_at: "2026-10-22T02:30:00Z",
  planned_label: "Wed, Oct 21, 19:30",
  timezone: "America/Los_Angeles",
  angle: "Send a win-back email to 214 lapsed regulars",
  why: "They have not ordered in 45 days.",
  source: "email_agent",
  status: "ready",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: { rail: "channel_actions", id: CARD },
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: null,
  ...over,
});

const plan = (items: unknown[]) => ({ ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, autopilot_on: false, items, holds: [], released: [] });

const cardView = (over: { can_approve?: boolean[]; tested?: boolean; test_list?: boolean; test_list_unknown?: boolean; open?: boolean; status?: string; route?: string } = {}) => ({
  rail: "channel_actions",
  id: CARD,
  class: "email_campaign.create_and_send",
  status: over.status ?? "pending",
  open: over.open ?? true,
  route: over.route ?? "mailchimp",
  list: { name: "Lapsed regulars", people: 214 },
  sender: { email: "hello@example.test", name: "Example" },
  reply_to: null,
  unsubscribe_group_id: null,
  viewer_can_approve: true,
  chosen_variant: null,
  can_approve: over.can_approve ?? [false],
  test_list: over.test_list,
  test_list_unknown: over.test_list_unknown,
  reasons: [],
  versions: [{
    variant: 1,
    subject: "We saved you a slice",
    preview_text: "Your usual is still on the counter.",
    html: "<p>x</p>",
    content: { subject: "We saved you a slice", preview_text: "Your usual is still on the counter.", title: "t", paragraphs: ["Hi {{first_name}},", "One.", "Two.", "Three."], button: { label: "See the menu", url: "https://example.test/menu" } },
    tested_by_me: over.tested ?? false,
    tested_by_approver: over.tested ?? false,
  }],
});

const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a planned email waiting for approval", () => {
  it("shows the email in the design card, and the approve button waits for a test without sending anything", async () => {
    set("GET /api/workspace/email-plan", plan([planItem()]));
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView() });
    render(<EmailComingUpBlock />);
    const item = await screen.findByTestId("coming-up-item");
    expect(within(item).getByText("Needs approval")).toBeTruthy();
    expect(await within(item).findByText("We saved you a slice")).toBeTruthy();
    expect(within(item).getByTestId("email-card-meta").textContent).toContain("Lapsed regulars · 214 people");
    expect(within(item).getByTestId("merge-field").textContent).toBe("first_name");
    expect(within(item).getByTestId("email-box-body").dataset.clamped).toBe("true");
    fireEvent.click(within(item).getByRole("button", { name: "Read more" }));
    expect(within(item).getByTestId("email-box-body").dataset.clamped).toBe("false");
    expect(within(item).queryByRole("link", { name: "Approve and schedule" })).toBeNull();
    expect(within(item).queryByTestId("coming-up-gate")).toBeNull();
    expect(screen.queryByTestId("coming-up-week")).toBeNull();
    expect(within(item).getByTestId("email-cta").textContent).toBe("See the menu");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    set(`POST /api/email-cards/channel_actions/${CARD}/test`, { ok: true });
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView({ can_approve: [true], tested: true }) });
    fireEvent.click(within(item).getByRole("button", { name: "Send me a test" }));
    const approve = await within(item).findByRole("link", { name: "Approve and schedule" });
    expect(approve.getAttribute("href")).toBe(`/workspace/email-cards/channel_actions/${CARD}`);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([{ url: `/api/email-cards/channel_actions/${CARD}/test`, method: "POST", body: { variant: 1 } }]);
    expect(within(item).queryByTestId("coming-up-gate")).toBeNull();
    expect(calls.some((c) => /approve|schedule/.test(c.url))).toBe(false);
  });

  it.each([
    [{ test_list: true }, TEST_LIST_LINE],
    [{ test_list_unknown: true }, TEST_LIST_UNKNOWN_LINE],
    [{ test_list: true, can_approve: [true], tested: true }, TEST_LIST_LINE],
  ])("Flow 12: a draft for a test list (%o) offers no test or approve on the row, says what the card says, and links to the draft", async (over, line) => {
    set("GET /api/workspace/email-plan", plan([planItem()]));
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView(over) });
    render(<EmailComingUpBlock />);
    const item = await screen.findByTestId("coming-up-item");
    expect(await within(item).findByText("We saved you a slice")).toBeTruthy();
    expect((await within(item).findByTestId("coming-up-test-list")).textContent).toBe(line);
    expect(within(item).queryByTestId("coming-up-gate")).toBeNull();
    expect(within(item).queryByRole("link", { name: "Approve and schedule" })).toBeNull();
    expect(within(item).queryByRole("button", { name: "Send me a test" })).toBeNull();
    expect(within(item).queryByTestId("coming-up-send-test")).toBeNull();
    expect(within(item).getByRole("link", { name: "Review draft" }).getAttribute("href")).toBe(`/workspace/email-cards/channel_actions/${CARD}`);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it.each([
    ["failed Mailchimp card on a test list", { test_list: true, open: false, status: "failed" }],
    ["failed Mailchimp card whose test lists could not be read", { test_list_unknown: true, open: false, status: "failed" }],
  ])("Flow 24: a %s offers no send, so the row never says the list is a test list", async (_n, over) => {
    set("GET /api/workspace/email-plan", plan([planItem()]));
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView(over) });
    render(<EmailComingUpBlock />);
    const item = await screen.findByTestId("coming-up-item");
    expect(await within(item).findByText("We saved you a slice")).toBeTruthy();
    expect(within(item).queryByTestId("coming-up-test-list")).toBeNull();
    expect(item.textContent).not.toMatch(/marked as a test list|could not check your test lists/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("Flow 24 control: a sendable card on a list that is not a test list never shows the test-list sentence", async () => {
    set("GET /api/workspace/email-plan", plan([planItem()]));
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView({ test_list: false, can_approve: [true], tested: true }) });
    render(<EmailComingUpBlock />);
    const item = await screen.findByTestId("coming-up-item");
    expect(await within(item).findByRole("link", { name: "Approve and schedule" })).toBeTruthy();
    expect(within(item).queryByTestId("coming-up-test-list")).toBeNull();
    expect(item.textContent).not.toMatch(/marked as a test list/);
  });

  it("keeps the row to primary, Ask Zavi and Skip; Move and Change topic sit in More actions, which Escape and an outside click close", async () => {
    set("GET /api/workspace/email-plan", plan([planItem({ status: "planned", card: null })]));
    render(<EmailComingUpBlock />);
    const item = await screen.findByTestId("coming-up-item");
    const row = within(item).getByTestId("coming-up-actions");
    expect(within(row).getAllByRole("button").map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual(["Draft now", "More actions", "Skip"]);
    expect(within(item).getByText("Zavi drafts it the day before.")).toBeTruthy();
    for (const b of within(row).getAllByRole("button")) looksLikeButton(b);
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Move", "Change topic"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move" }));
    expect(screen.getByRole("button", { name: "Day" })).toBeTruthy();
  });

  it("offers Approve and schedule only once the server says this version can be approved", async () => {
    set("GET /api/workspace/email-plan", plan([planItem()]));
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView({ can_approve: [true], tested: true }) });
    render(<EmailComingUpBlock />);
    const link = await screen.findByRole("link", { name: "Approve and schedule" });
    expect(link.getAttribute("href")).toBe(`/workspace/email-cards/channel_actions/${CARD}`);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("each work item shows in exactly one group", () => {
  const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn() });

  it("a planned card waiting on you is not drawn again under Ready for you", async () => {
    set("GET /api/workspace/email-plan", plan([planItem()]));
    set(`GET /api/email-cards/channel_actions/${CARD}`, { card: cardView() });
    const planned = makeAction("send_message", { id: CARD, channel_slug: "email_marketing", title: "Win-back card", executable: true, email_card: true, card_kind: "executes" });
    const draft = makeAction("send_message", {
      id: "draft-1",
      channel_slug: "email_marketing",
      title: "Send this week's newsletter",
      card_kind: "message",
      primary_label: "Copy email",
      body: { intent: "reach_out", step: { body: "One email to the Newsletter list.", deliverable: { kind: "email", label: "Newsletter", content: "Subject: Fresh from the oven\n\nHi,\n\nNew loaf this week." } } },
    });
    render(<ChannelActionSection actions={[planned, draft]} platform={platformFor("email_marketing")} handlers={handlers()} empty={null} />);
    await screen.findByTestId("waiting-on-you");
    await waitFor(() => expect(document.querySelectorAll(`[data-testid="action-${CARD}"]`)).toHaveLength(0));
    const ready = document.querySelector('[data-ad-section="ready"]') as HTMLElement;
    expect(within(ready).getByText("Send this week's newsletter")).toBeTruthy();
    expect(within(ready).queryByText("Win-back card")).toBeNull();
    expect(screen.getAllByTestId("coming-up-item")).toHaveLength(1);
    const ids = [...document.querySelectorAll("[data-testid^='action-'], [data-testid='coming-up-item']")].map((el) => el.getAttribute("data-testid") === "coming-up-item" ? `plan:${el.id}` : el.getAttribute("data-testid"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getByTestId("section-count").textContent).toBe("2");
  });

});

describe("finished work on the email channel", () => {
  const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn() });
  const sentCard = () => makeAction("send_message", { id: "sent-1", channel_slug: "email_marketing", title: "October newsletter", executable: true, email_card: true, exec_status: "executed", executed_at: "2026-10-18T16:00:00Z" });

  it("draws no Done or Zavi did for you group inside What Zavi wants to do, and no card for a sent email or a sent planned email", async () => {
    set("GET /api/workspace/email-plan", plan([planItem({ id: "sent-plan", status: "sent", card: null, angle: "Tell regulars about the pumpkin loaf", sent_at: "2026-10-19T16:00:00Z" }), planItem({ id: "skipped-plan", status: "skipped", card: null, angle: "A skipped one" })]));
    render(<ChannelActionSection actions={[]} completed={[sentCard()]} platform={platformFor("email_marketing")} handlers={handlers()} empty={null} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByText("Zavi did for you")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Done" })).toBeNull();
    expect(document.querySelector('[data-testid="action-sent-1"]')).toBeNull();
    expect(screen.queryByText("October newsletter")).toBeNull();
    expect(screen.queryByText("Tell regulars about the pumpkin loaf")).toBeNull();
  });

  it("another channel draws no completed group either", () => {
    const executed = makeAction("check", { id: "ad-1", channel_slug: "meta_ads", title: "Paused the weak ad set", executable: true, status: "acted", exec_status: "executed" });
    render(<ChannelActionSection actions={[]} completed={[executed]} platform={platformFor("meta_ads")} handlers={handlers()} empty={null} />);
    expect(screen.queryByText("Zavi did for you")).toBeNull();
    expect(screen.queryByText("Paused the weak ad set")).toBeNull();
  });
});
