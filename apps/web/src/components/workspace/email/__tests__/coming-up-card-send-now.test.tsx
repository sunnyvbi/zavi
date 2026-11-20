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
import { EmailCampaignCard, type EmailCardView } from "@/components/email/EmailCampaignCard";

const PLAN_ID = "1a02534a-0000-4000-8000-000000000001";
const OTHER_ID = "1a02534a-0000-4000-8000-000000000002";
const CARD_ID = "84c72576-0000-4000-8000-000000000003";
const CARD = `/api/email-cards/channel_actions/${CARD_ID}`;
const PLAN = "/api/workspace/email-plan";

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
const otherItem = {
  ...planItem("ready"),
  id: OTHER_ID,
  list_name: "Trial users",
  list_id: "zl2",
  angle: "Trial tips",
  planned_at: "2026-11-02T15:00:00Z",
  planned_label: "Mon, Nov 2, 3:00 PM",
  status: "planned",
  card: null,
};
const planView = (phase: Phase) => ({ ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: true, items: [planItem(phase), otherItem], holds: [], released: [] });

const cardView = (phase: Phase): EmailCardView => {
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
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>Version ${n}</p>`, tested_by_me: true, tested_by_approver: true })),
    can_approve: [true, true],
    reasons: [],
    planned: { id: it.id, planned_at: it.planned_at, planned_label: it.planned_label, timezone: it.timezone, status: it.status, status_reason: null, reason: null, schedule_gen: it.schedule_gen, content_version: 1, vetoed: it.vetoed, scheduled: it.scheduled },
  } as EmailCardView;
};

let phase: Phase = "scheduled";
let planGate: ((n: number) => Promise<void> | null) | null = null;
let planReads = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
  calls.length = 0;
  phase = "scheduled";
  planGate = null;
  planReads = 0;
  server.answer = async (method, url) => {
    if (method === "GET" && url === PLAN) {
      const n = ++planReads;
      const snapshot = phase;
      const wait = planGate?.(n);
      if (wait) await wait;
      return { status: 200, body: planView(snapshot) };
    }
    if (method === "GET" && url === CARD) return { status: 200, body: { card: cardView(phase) } };
    if (method === "GET" && url === `${CARD}/count`) return { status: 200, body: { people: 2 } };
    if (method === "GET" && url === "/api/workspace/email-pause") return { status: 200, body: { paused: false, held: null } };
    if (method === "POST" && url === `${CARD}/approve`) {
      phase = "sent";
      return { status: 200, body: { ok: true } };
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

const planGets = () => calls.filter((c) => c.method === "GET" && c.url === PLAN).length;
const item = (id: string) => document.getElementById(`plan-${id}`) as HTMLElement | null;
const weekDay = (label: string) => screen.getAllByTestId("week-day").find((d) => d.textContent?.toUpperCase().startsWith(label)) as HTMLElement;
const settle = () => act(async () => {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
});

const mountBoth = async () => {
  render(
    <>
      <EmailComingUpBlock />
      <EmailCampaignCard rail="channel_actions" id={CARD_ID} />
    </>,
  );
  await waitFor(() => expect(item(PLAN_ID)).not.toBeNull());
  return screen.getByTestId("coming-up");
};

describe("Bug 8164: Coming up follows what the lane's email card did", () => {
  it("Send A now on the planned card moves the item out of Approved for Sat 31 with no remount and one plan read", async () => {
    const section = await mountBoth();
    expect(within(screen.getByTestId("coming-up-group-section")).getByText("Approved")).toBeDefined();
    expect(planGets()).toBe(1);

    fireEvent.click(await screen.findByRole("button", { name: "Send A now" }));

    await waitFor(() => expect(item(PLAN_ID)?.getAttribute("data-status")).toBe("sent"));
    expect(screen.getByTestId("coming-up")).toBe(section);
    expect(within(screen.getByTestId("past-section")).getByText("Halloween member note")).toBeDefined();
    expect(screen.queryByTestId("coming-up-group-section") && within(screen.getByTestId("coming-up-group-section")).queryByText("Approved")).toBeFalsy();
    expect(item(OTHER_ID)?.getAttribute("data-status")).toBe("planned");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${CARD}/approve`]);
    await settle();
    expect(planGets()).toBe(2);
  });

  it("a plan read started before the send that answers after the fresh one never puts Approved back", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    planGate = (n) => (n === 2 ? held : null);
    await mountBoth();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("zavi:email-plan-changed"));
    });
    expect(planGets()).toBe(2);

    fireEvent.click(await screen.findByRole("button", { name: "Send A now" }));
    await waitFor(() => expect(item(PLAN_ID)?.getAttribute("data-status")).toBe("sent"));
    await act(async () => {
      release();
      await held;
    });
    await settle();
    expect(item(PLAN_ID)?.getAttribute("data-status")).toBe("sent");
    expect(planGets()).toBe(3);
  });

  it("Don't send on the lane card turns Approved back into Needs approval in Coming up", async () => {
    await mountBoth();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Don.t send/ }).some((b) => !b.closest("[data-testid=coming-up]"))).toBe(true));
    fireEvent.click(screen.getAllByRole("button", { name: /Don.t send/ }).find((b) => !b.closest("[data-testid=coming-up]"))!);
    await waitFor(() => expect(item(PLAN_ID)?.getAttribute("data-status")).toBe("ready"));
    expect(within(item(PLAN_ID)!).getByText("You stopped this send")).toBeDefined();
    expect(item(OTHER_ID)?.getAttribute("data-status")).toBe("planned");
    await settle();
    expect(planGets()).toBe(2);
  });

  it("Approve A for the planned time on the lane card shows Approved in Coming up", async () => {
    phase = "ready";
    await mountBoth();
    expect(within(item(PLAN_ID)!).getByText("Needs approval")).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve A for Sat, Oct 31/ }));
    await waitFor(() => expect(item(PLAN_ID)?.getAttribute("data-status")).toBe("scheduled"));
    expect(within(item(PLAN_ID)!).getByText("Approved")).toBeDefined();
    expect(item(OTHER_ID)?.getAttribute("data-status")).toBe("planned");
    await settle();
    expect(planGets()).toBe(2);
  });
});
