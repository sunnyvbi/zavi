// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Answer = { status: number; body: unknown };
const calls: Array<{ url: string; method: string }> = [];
const server = vi.hoisted(() => ({
  plan: (_n: number): unknown => null,
  card: (): unknown => null,
  skip: (): unknown => null,
  angle: (): unknown => null,
  toasts: [] as string[],
}));
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    let a: Answer = { status: 200, body: {} };
    if (method === "GET" && url === "/api/workspace/email-plan") a = (await server.plan(calls.filter((c) => c.url === url).length)) as Answer;
    else if (method === "GET" && url.startsWith("/api/email-cards/") && url.split("/").length === 5) a = (await server.card()) as Answer;
    else if (method === "POST" && url.endsWith("/skip")) a = (await server.skip()) as Answer;
    else if (method === "POST" && url.endsWith("/angle")) a = (await server.angle()) as Answer;
    return { ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) };
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: (t: { title: string }) => server.toasts.push(t.title) } }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { EmailComingUpBlock } from "../EmailComingUpBlock";
import { ChannelActionSection } from "../../actions/ChannelActionSection";
import { platformFor } from "../../actions/platforms";
import { makeAction } from "../../actions/__tests__/fixtures";
import type { ActionHandlers } from "../../actions/types";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const APPROVE = "Approve and schedule";

const held = <T,>() => {
  let open: (v: T) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { promise, open, fail };
};

const planItem = (over: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Lapsed regulars",
  planned_at: "2036-10-22T02:30:00Z",
  planned_label: "Wed, Oct 21, 19:30",
  timezone: "UTC",
  angle: "Win back lapsed regulars",
  why: "They have not ordered in 45 days.",
  source: "email_agent",
  status: "ready",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: { rail: "channel_actions", id: CARD_ID },
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: null,
  ...over,
});
const NEW_ANGLE = "Show off the new autumn menu";
const CHANGED = { angle: NEW_ANGLE, status: "planned", status_reason: null, reason: null, content_version: 2, card: null, card_status: null };
const SKIPPED = { status: "skipped", status_reason: "skipped_by_founder", reason: "You skipped this email.", card: null };
const plan = (items: unknown[]): Answer => ({ status: 200, body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: true, items, holds: [], released: [] } });

const cardBody = (tested: boolean) => ({
  rail: "channel_actions",
  id: CARD_ID,
  class: "email_campaign.create_and_send",
  status: "pending",
  open: true,
  route: "mailchimp",
  list: { name: "Lapsed regulars", people: 214 },
  sender: { email: "hello@example.test", name: "Example" },
  reply_to: null,
  unsubscribe_group_id: null,
  viewer_can_approve: true,
  chosen_variant: null,
  can_approve: [tested],
  reasons: [],
  versions: [{ variant: 1, subject: "We saved you a slice", preview_text: "Your usual", html: "<p>x</p>", content: { subject: "We saved you a slice", preview_text: "Your usual", title: "t", paragraphs: ["Hi there."], button: null }, tested_by_me: tested, tested_by_approver: tested }],
});
const cardAnswer = (tested: boolean): Answer => ({ status: 200, body: { card: cardBody(tested) } });

const row = () => document.getElementById(`plan-${PLAN_ID}`) as HTMLElement;
const approveLinks = () => screen.queryAllByRole("link").filter((a) => a.textContent?.includes(APPROVE));
const pendingAction = () => screen.queryByTestId("coming-up-action-pending");
const ghostIn = (el: HTMLElement) => within(el).queryByTestId("email-box-ghost");
const flush = () => act(async () => {
  for (let n = 0; n < 12; n += 1) await Promise.resolve();
});

let observer: MutationObserver | null = null;
let approveSeen = false;
const watchApprove = () => {
  approveSeen = false;
  observer = new MutationObserver(() => {
    if (document.body.textContent?.includes(APPROVE)) approveSeen = true;
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
};

beforeEach(() => {
  calls.length = 0;
  server.toasts.length = 0;
  server.plan = () => plan([planItem()]);
  server.card = () => cardAnswer(false);
  server.skip = () => ({ status: 200, body: { ok: true, changed: true } });
  server.angle = () => ({ status: 200, body: { ok: true } });
});
afterEach(() => {
  observer?.disconnect();
  observer = null;
  cleanup();
});

const sendTest = () => screen.queryByTestId("coming-up-send-test");
const changeTopic = async () => {
  fireEvent.click(within(row()).getByRole("button", { name: "More actions" }));
  fireEvent.click(within(row()).getByRole("menuitem", { name: "Change topic" }));
  fireEvent.change(within(row()).getByLabelText("Topic"), { target: { value: NEW_ANGLE } });
  fireEvent.click(within(row()).getByRole("button", { name: "Save" }));
  await flush();
};

describe("Change topic: a draft that was replaced cannot be tested or approved", () => {
  it("shows the new topic, planned, with no old draft, while the re-read is held and when it returns the old row", async () => {
    const reread = held<Answer>();
    server.plan = (n) => (n === 1 ? plan([planItem()]) : reread.promise);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(sendTest()).not.toBeNull());

    await changeTopic();

    expect(row().getAttribute("data-status")).toBe("planned");
    expect(within(row()).getByText(NEW_ANGLE)).toBeTruthy();
    expect(within(row()).queryByText("Win back lapsed regulars")).toBeNull();
    expect(sendTest()).toBeNull();
    expect(screen.queryByText("We saved you a slice")).toBeNull();
    expect(approveLinks()).toHaveLength(0);

    await act(async () => reread.open(plan([planItem()])));
    await flush();

    expect(row().getAttribute("data-status")).toBe("planned");
    expect(within(row()).getByText(NEW_ANGLE)).toBeTruthy();
    expect(sendTest()).toBeNull();
    expect(approveLinks()).toHaveLength(0);
    expect(screen.getByTestId("coming-up-unconfirmed")).toBeTruthy();
  });

  it("a later read that shows the change takes over and confirms it", async () => {
    server.plan = (n) => (n === 1 ? plan([planItem()]) : plan([planItem(CHANGED)]));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(sendTest()).not.toBeNull());

    await changeTopic();

    expect(row().getAttribute("data-status")).toBe("planned");
    expect(within(row()).getByText(NEW_ANGLE)).toBeTruthy();
    expect(sendTest()).toBeNull();
    expect(server.toasts).toEqual(["Changed. Zavi redrafts it; the old draft and any approval are replaced."]);
    expect(screen.queryByTestId("coming-up-unconfirmed")).toBeNull();
  });

});
