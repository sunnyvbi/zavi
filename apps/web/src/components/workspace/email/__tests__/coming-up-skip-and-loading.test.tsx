// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Answer = { status: number; body: unknown };
const calls: Array<{ url: string; method: string }> = [];
const server = vi.hoisted(() => ({
  plan: (_n: number): unknown => null,
  card: (): unknown => null,
  skip: (): unknown => null,
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
  server.card = () => cardAnswer(true);
  server.skip = () => ({ status: 200, body: { ok: true, changed: true } });
});
afterEach(() => {
  observer?.disconnect();
  observer = null;
  cleanup();
});

const mountApprovable = async () => {
  render(<EmailComingUpBlock />);
  await waitFor(() => expect(approveLinks()).toHaveLength(1));
};
const clickSkip = async () => {
  fireEvent.click(within(row()).getByRole("button", { name: "Skip" }));
  await flush();
};

describe("Skip: an email the founder just skipped offers no way to approve it", () => {
  it("leaves Waiting on you the moment the skip is accepted, while the re-read is still 7 seconds away", async () => {
    const reread = held<Answer>();
    server.plan = (n) => (n === 1 ? plan([planItem()]) : reread.promise);
    await mountApprovable();

    await clickSkip();

    expect(approveLinks()).toHaveLength(0);
    expect(screen.queryByTestId("waiting-on-you-section")).toBeNull();
    expect(screen.queryByText("Needs approval")).toBeNull();
    expect(screen.queryByText("We saved you a slice")).toBeNull();
    expect(row().getAttribute("data-status")).toBe("skipped");
    expect(within(screen.getByTestId("past-section")).getByText("Skipped")).toBeTruthy();
    expect(server.toasts).toEqual([]);

    await act(async () => reread.open(plan([planItem(SKIPPED)])));
    await flush();

    expect(server.toasts).toEqual(["Skipped."]);
    expect(approveLinks()).toHaveLength(0);
    expect(row().getAttribute("data-status")).toBe("skipped");
  });

  it("offers no Approve while the skip request itself is in flight", async () => {
    const answer = held<Answer>();
    server.skip = () => answer.promise;
    await mountApprovable();

    await clickSkip();

    expect(approveLinks()).toHaveLength(0);
    expect(pendingAction()).not.toBeNull();
    expect((pendingAction() as HTMLButtonElement).disabled).toBe(true);
    expect(row().getAttribute("data-status")).toBe("ready");
    await act(async () => answer.open({ status: 200, body: { ok: true, changed: true } }));
  });

  it("a plan read started before the skip that answers late cannot put the email back", async () => {
    const stale = held<Answer>();
    const fresh = held<Answer>();
    server.plan = (n) => (n === 1 ? plan([planItem()]) : n === 2 ? stale.promise : fresh.promise);
    await mountApprovable();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("zavi:email-plan-changed"));
    });

    await clickSkip();
    await act(async () => stale.open(plan([planItem()])));
    await flush();

    expect(approveLinks()).toHaveLength(0);
    expect(row().getAttribute("data-status")).toBe("skipped");

    await act(async () => fresh.open(plan([planItem(SKIPPED)])));
    await flush();
    expect(approveLinks()).toHaveLength(0);
    expect(row().getAttribute("data-status")).toBe("skipped");
  });

  it("a re-read that fails keeps the email out of the list and says the skip is not confirmed", async () => {
    server.plan = (n) => (n === 1 ? plan([planItem()]) : { status: 500, body: {} });
    await mountApprovable();

    await clickSkip();
    await flush();

    expect(approveLinks()).toHaveLength(0);
    expect(row().getAttribute("data-status")).toBe("skipped");
    expect(screen.getByTestId("coming-up-unconfirmed")).toBeTruthy();
    expect(server.toasts).toEqual([]);
  });

  it("a refused skip leaves the email waiting, with its Approve and the reason", async () => {
    server.skip = () => ({ status: 409, body: { error: { code: "not_skippable", message: "This email already went out." } } });
    await mountApprovable();

    await clickSkip();
    await flush();

    expect(row().getAttribute("data-status")).toBe("ready");
    expect(within(row()).getByRole("alert").textContent).toContain("This email already went out.");
    expect(approveLinks()).toHaveLength(1);
  });

  it("a skip whose answer was lost does not claim anything, and the read decides", async () => {
    const reread = held<Answer>();
    server.skip = () => Promise.reject(new TypeError("Failed to fetch"));
    server.plan = (n) => (n === 1 ? plan([planItem()]) : reread.promise);
    await mountApprovable();

    await clickSkip();

    expect(row().getAttribute("data-status")).toBe("ready");
    expect(approveLinks()).toHaveLength(0);

    await act(async () => reread.open(plan([planItem()])));
    await flush();

    expect(row().getAttribute("data-status")).toBe("ready");
    expect(approveLinks()).toHaveLength(1);
    expect(screen.getByTestId("coming-up-unconfirmed")).toBeTruthy();
  });

  it("a later read that still shows the email open wins over the local skip", async () => {
    server.plan = (n) => (n === 1 ? plan([planItem()]) : plan([planItem()]));
    await mountApprovable();

    await clickSkip();
    await flush();

    expect(row().getAttribute("data-status")).toBe("ready");
    expect(screen.getByTestId("coming-up-unconfirmed")).toBeTruthy();
  });

});

describe("A ready email before its card has loaded", () => {
  it("never shows Approve on the way to Send me a test", async () => {
    const card = held<Answer>();
    server.card = () => card.promise;
    watchApprove();
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(row()).toBeTruthy());
    await flush();

    expect(approveLinks()).toHaveLength(0);
    const placeholder = pendingAction() as HTMLButtonElement;
    expect(placeholder.disabled).toBe(true);
    expect(placeholder.tagName).toBe("BUTTON");
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
    expect(placeholder.className).toContain("h-10");
    expect(placeholder.textContent).not.toMatch(/approve/i);

    await act(async () => card.open(cardAnswer(false)));
    await flush();

    expect(screen.getByTestId("coming-up-send-test")).toBeTruthy();
    expect(pendingAction()).toBeNull();
    expect(approveSeen).toBe(false);
  });

  it("offers Approve only after the card says it can be approved", async () => {
    const card = held<Answer>();
    server.card = () => card.promise;
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(row()).toBeTruthy());
    await flush();
    expect(approveLinks()).toHaveLength(0);

    await act(async () => card.open(cardAnswer(true)));
    await flush();

    expect(approveLinks()).toHaveLength(1);
    expect(pendingAction()).toBeNull();
  });

  it.each([
    ["an error answer", () => ({ status: 500, body: {} })],
    ["a body with no card", () => ({ status: 200, body: { ok: true } })],
    ["a card with no versions", () => ({ status: 200, body: { card: { ...cardBody(true), versions: [] } } })],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("when the card read ends in %s it offers Review draft, never Approve", async (_name, answer) => {
    server.card = answer;
    watchApprove();
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(within(row()).getByRole("link", { name: "Review draft" })).toBeTruthy());

    expect(pendingAction()).toBeNull();
    expect(ghostIn(row())).toBeNull();
    expect(approveSeen).toBe(false);
  });

  it("a card read arriving after unmount does nothing and a skip target stays reachable while loading", async () => {
    const card = held<Answer>();
    server.card = () => card.promise;
    const { unmount } = render(<EmailComingUpBlock />);
    await waitFor(() => expect(row()).toBeTruthy());
    expect((within(row()).getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    await act(async () => card.open(cardAnswer(true)));
    expect(approveLinks()).toHaveLength(0);
  });
});

describe("The late draft preview", () => {
  it("holds its space with the drafting skeleton and swaps in place with the More actions menu still open", async () => {
    const card = held<Answer>();
    server.card = () => card.promise;
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(row()).toBeTruthy());
    await flush();

    expect(ghostIn(row())).not.toBeNull();
    expect(within(row()).queryByText("We saved you a slice")).toBeNull();
    expect(within(row()).queryByTestId("coming-up-drafting-status")).toBeNull();

    const li = row();
    const more = within(li).getByRole("button", { name: "More actions" });
    fireEvent.click(more);
    const menu = within(li).getByRole("menu");

    await act(async () => card.open(cardAnswer(false)));
    await flush();

    expect(ghostIn(row())).toBeNull();
    expect(within(row()).getByText("We saved you a slice")).toBeTruthy();
    expect(row()).toBe(li);
    expect(within(li).getByRole("button", { name: "More actions" })).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(li).getByRole("menu")).toBe(menu);
  });

  it("holds the space on an approved email too, and draws one skeleton on an email still drafting", async () => {
    const card = held<Answer>();
    server.card = () => card.promise;
    server.plan = () => plan([planItem({ status: "scheduled", scheduled: { variant: 1, count: 2, by: "u" } }), planItem({ id: "22222222-2222-4222-8222-222222222222", status: "drafting" })]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item")).toHaveLength(2));
    await flush();

    const [approved, drafting] = screen.getAllByTestId("coming-up-item");
    expect(within(approved).getAllByTestId("email-box-ghost")).toHaveLength(1);
    expect(within(drafting).getAllByTestId("email-box-ghost")).toHaveLength(1);
    await act(async () => card.open(cardAnswer(false)));
  });

  it("draws no skeleton on a done email", async () => {
    server.card = () => held<Answer>().promise;
    server.plan = () => plan([planItem({ status: "skipped", status_reason: "not_approved_in_time" })]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(row()).toBeTruthy());
    await flush();
    expect(ghostIn(row())).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});
