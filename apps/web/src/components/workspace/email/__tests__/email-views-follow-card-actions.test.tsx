// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Answer = { status: number; body: unknown };
const calls: Array<{ url: string; method: string }> = [];
const server = vi.hoisted(() => ({
  answer: (_method: string, _url: string): Answer | Promise<Answer> => ({ status: 200, body: {} }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const a = await server.answer(method, url);
    return { ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) };
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { EmailComingUpBlock } from "../EmailComingUpBlock";
import { SentEmailsBlock } from "../SentEmailsBlock";
import { EmailCampaignCard, type EmailCardView } from "@/components/email/EmailCampaignCard";
import { ChannelHistory } from "../../actions/history/ChannelHistory";
import { useChannelHistory } from "../../actions/useChannelHistory";
import { announceEmailCardChanged } from "@/lib/workspace/emailCardEvents";

const PLAN_ID = "1a02534a-0000-4000-8000-000000000001";
const CARD_ID = "84c72576-0000-4000-8000-000000000003";
const CARD = `/api/email-cards/channel_actions/${CARD_ID}`;
const PLAN = "/api/workspace/email-plan";
const RESULTS = "/api/email-results";
const HISTORY = "/api/channels/email_marketing/history";
const CLOSED_TITLE = "Card closed: Halloween member note went out";

type Phase = "ready" | "scheduled" | "sent" | "withdrawn";

const planItem = (phase: Phase) => ({
  id: PLAN_ID,
  route: "zavi_list",
  list_id: "zl1",
  list_name: "Zavi members",
  planned_at: "2026-10-31T09:00:00Z",
  planned_label: "Sat, Oct 31, 9:00 AM",
  timezone: "UTC",
  angle: "Halloween member note",
  why: "Members open weekend notes.",
  source: "email_agent",
  status: phase === "withdrawn" ? "ready" : phase,
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: phase === "withdrawn" ? 3 : 2,
  card: { rail: "channel_actions", id: CARD_ID },
  vetoed: phase === "withdrawn",
  scheduled: phase === "scheduled" ? { variant: 1, count: 2, by: "u" } : null,
  unattended: false,
  sent_at: phase === "sent" ? "2026-10-29T10:00:00Z" : null,
});
const planView = (phase: Phase) => ({ ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: true, items: [planItem(phase)], holds: [], released: [] });

let phase: Phase = "scheduled";
let tested = true;

const cardView = (): EmailCardView => {
  const it = planItem(phase);
  return {
    rail: "channel_actions",
    id: CARD_ID,
    class: "email_campaign.create_and_send",
    status: phase === "sent" ? "sent" : "pending",
    open: phase !== "sent",
    route: "zavi_list",
    list: { name: "Zavi members", people: 2 },
    sender: { email: "hello@zavi.test", name: "Zavi" },
    reply_to: null,
    unsubscribe_group_id: null,
    viewer_can_approve: true,
    chosen_variant: phase === "sent" ? 1 : null,
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>Version ${n}</p>`, tested_by_me: tested, tested_by_approver: tested })),
    can_approve: [tested, tested],
    reasons: [],
    planned: { id: it.id, planned_at: it.planned_at, planned_label: it.planned_label, timezone: it.timezone, status: it.status, status_reason: null, reason: null, schedule_gen: it.schedule_gen, content_version: 1, vetoed: it.vetoed, scheduled: it.scheduled },
  } as EmailCardView;
};

const cell = (value: number | null) => ({ value, why: null });
const sentRow = () => ({
  card: { rail: "channel_actions", id: CARD_ID, link: "" },
  route: "zavi_list",
  sent_with: "Zavi",
  subject: "Subject 1",
  list_name: "Zavi members",
  started_at: "2026-10-29T10:00:00Z",
  finished_at: "2026-10-29T10:00:00Z",
  spanned: false,
  stage: "early",
  people: { sent: 2, total: null, stopped: false },
  as_of: "early",
  delivered: cell(2),
  opens: cell(0),
  opens_label: "Opens",
  clicks: cell(0),
  unsubscribes: cell(0),
  visitors: cell(0),
  win_line: null,
  verdict: null,
  verdict_text: null,
  d7_due_at: null,
  note: null,
});
const closedRow = () => ({
  id: CARD_ID,
  run_id: "run-1",
  position: 1,
  run_of: 1,
  action_type: "email_campaign",
  title: CLOSED_TITLE,
  status: "acted",
  status_at: "2026-10-29T10:00:00Z",
  note: null,
  proposed_at: "2026-10-28T10:00:00Z",
  impact: 3,
  impact_reason: null,
  score: 10,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
  calls.length = 0;
  phase = "scheduled";
  tested = true;
  server.answer = async (method, url) => {
    if (method === "GET" && url === PLAN) return { status: 200, body: planView(phase) };
    if (method === "GET" && url === CARD) return { status: 200, body: { card: cardView() } };
    if (method === "GET" && url === RESULTS) return { status: 200, body: { emails: phase === "sent" ? [sentRow()] : [], more: false } };
    if (method === "GET" && url === HISTORY) return { status: 200, body: { runs: [], closed: phase === "sent" ? [closedRow()] : [], pre_switch: [] } };
    if (method === "GET" && url === `${CARD}/count`) return { status: 200, body: { people: 2 } };
    if (method === "GET" && url === "/api/workspace/email-pause") return { status: 200, body: { paused: false, held: null } };
    if (method === "POST" && url === `${CARD}/approve`) {
      phase = "sent";
      return { status: 200, body: { ok: true } };
    }
    if (method === "POST" && url === `${CARD}/test`) {
      tested = true;
      return { status: 200, body: { ok: true, sent_with: "Zavi" } };
    }
    if (method === "POST" && url === `${PLAN}/${PLAN_ID}/schedule`) {
      phase = "scheduled";
      return { status: 200, body: { ok: true, replayed: false } };
    }
    if (method === "POST" && url === `${PLAN}/${PLAN_ID}/withdraw`) {
      phase = "withdrawn";
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: {} };
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const gets = (url: string) => calls.filter((c) => c.method === "GET" && c.url === url).length;
const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.url);
const settle = () => act(async () => {
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
});

function Done() {
  const history = useChannelHistory("email_marketing");
  return <ChannelHistory slug="email_marketing" history={history} doneHistory />;
}

const outside = (name: RegExp | string) => async () => {
  await waitFor(() => expect(screen.getAllByRole("button", { name }).some((b) => !b.closest("[data-testid=coming-up]"))).toBe(true));
  return screen.getAllByRole("button", { name }).find((b) => !b.closest("[data-testid=coming-up]"))!;
};
const people = () => screen.queryByTestId("stat-people-value")?.textContent ?? null;
const perfRows = (id: string) => screen.queryAllByTestId(id).length;
const comingUpItem = () => document.getElementById(`plan-${PLAN_ID}`) as HTMLElement;
const lane = () => document.querySelector("[data-testid=lane-card]") as HTMLElement;

const mountAll = async () => {
  render(
    <>
      <EmailComingUpBlock />
      <SentEmailsBlock />
      <Done />
      <div data-testid="lane-card">
        <EmailCampaignCard rail="channel_actions" id={CARD_ID} />
      </div>
    </>,
  );
  await waitFor(() => expect(comingUpItem()).not.toBeNull());
  await waitFor(() => expect(people()).not.toBeNull());
  await waitFor(() => expect(gets(HISTORY)).toBe(1));
  await settle();
};

describe("Email views follow card actions without a reload", () => {
  it("Send A now on a card refreshes How your emails are doing and Done, each with one read", async () => {
    await mountAll();
    expect(people()).toBe("–");
    expect(perfRows("row-scheduled")).toBe(1);
    expect(screen.queryByRole("button", { name: /^History/ })).toBeNull();
    expect([gets(PLAN), gets(RESULTS), gets(HISTORY)]).toEqual([3, 1, 1]);

    fireEvent.click(await outside("Send A now")());

    await waitFor(() => expect(people()).toBe("2"));
    expect(perfRows("row-scheduled")).toBe(0);
    expect(within(screen.getByTestId("email-performance")).getByText("Subject 1")).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: /^History/ }));
    expect(await screen.findByText(CLOSED_TITLE)).toBeDefined();
    expect(posts()).toEqual([`${CARD}/approve`]);
    await settle();
    expect([gets(PLAN), gets(RESULTS), gets(HISTORY)]).toEqual([6, 2, 2]);
  });

  it("Approve A for the planned time moves a draft to Scheduled in How your emails are doing", async () => {
    phase = "ready";
    await mountAll();
    expect(perfRows("row-draft")).toBe(1);
    expect(perfRows("row-scheduled")).toBe(0);
    const before = [gets(PLAN), gets(RESULTS), gets(HISTORY)];

    fireEvent.click(await outside(/^Approve A for Sat, Oct 31/)());

    await waitFor(() => expect(perfRows("row-scheduled")).toBe(1));
    expect(perfRows("row-draft")).toBe(0);
    await settle();
    expect([gets(PLAN) - before[0], gets(RESULTS) - before[1], gets(HISTORY) - before[2]]).toEqual([3, 1, 1]);
  });

  it("a bare announce re-reads each email view exactly once", async () => {
    await mountAll();
    const before = [gets(PLAN), gets(RESULTS), gets(HISTORY), gets(CARD)];
    await act(async () => {
      announceEmailCardChanged({ rail: "channel_actions", id: CARD_ID, source: "elsewhere" });
    });
    await settle();
    expect([gets(PLAN) - before[0], gets(RESULTS) - before[1], gets(HISTORY) - before[2], gets(CARD) - before[3]]).toEqual([3, 1, 1, 2]);
    expect(posts()).toEqual([]);
  });

  it("Send me a test in Coming up unlocks approval on the lane copy of the same card", async () => {
    phase = "ready";
    tested = false;
    await mountAll();
    expect(within(lane()).getByTestId("email-card-step-test").getAttribute("data-done")).toBe("false");
    expect(within(lane()).getAllByRole("button", { name: /Send a test first/ }).length).toBeGreaterThan(0);
    const cardBefore = gets(CARD);
    const planBefore = gets(PLAN);

    fireEvent.click(within(comingUpItem()).getByTestId("coming-up-send-test"));

    await waitFor(() => expect(within(lane()).getByTestId("email-card-step-test").getAttribute("data-done")).toBe("true"));
    expect(within(lane()).queryAllByRole("button", { name: /Send a test first/ })).toHaveLength(0);
    expect(within(lane()).getByRole("button", { name: /^Approve A for Sat, Oct 31/ }).hasAttribute("disabled")).toBe(false);
    expect(posts()).toEqual([`${CARD}/test`]);
    await settle();
    expect(gets(CARD) - cardBefore).toBe(2);
    expect(gets(PLAN) - planBefore).toBe(2);
  });

  it("Don't send in Coming up takes Approved off the lane copy of the same card", async () => {
    await mountAll();
    await waitFor(() => expect(within(lane()).getByText(/Approved A for Sat, Oct 31/)).toBeDefined());
    const cardBefore = gets(CARD);
    const planBefore = gets(PLAN);

    fireEvent.click(within(comingUpItem()).getByRole("button", { name: /Don.t send/ }));

    await waitFor(() => expect(within(lane()).queryByText(/Approved A for Sat, Oct 31/)).toBeNull());
    expect(within(lane()).getByRole("button", { name: /^Approve A for Sat, Oct 31/ })).toBeDefined();
    expect(within(comingUpItem()).getByText("You stopped this send")).toBeDefined();
    expect(posts()).toEqual([`${PLAN}/${PLAN_ID}/withdraw`]);
    await settle();
    expect(gets(CARD) - cardBefore).toBe(2);
    expect(gets(PLAN) - planBefore).toBe(3);
  });
});
