// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";

const routes: Record<string, unknown> = {};
const reads: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    reads.push(key);
    const body = routes[key] ?? { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { EmailComingUpBlock } from "../EmailComingUpBlock";
import { announceEmailCardChanged } from "@/lib/workspace/emailCardEvents";

const PLAN = "GET /api/workspace/email-plan";
const MAY_HAVE = "Zavi stopped this send. 3 people got it, and 2 more may have: their email provider never confirmed. Zavi will not send it to them again.";
const STOPPED = "Stopped after 3 people. The rest were not sent.";
const HELD_REASON = "Zavi did not hear back from the email tool about this send, so it may have gone out.";

const outcome = (over: Record<string, unknown>) => ({ status: "sent", sent: 10, total: 10, unknown: 0, may_have_sent: false, reason: null, pause_hold: null, ...over });

let n = 0;
const item = (over: Record<string, unknown>) => {
  n += 1;
  const id = `1111111${n}-1111-4111-8111-111111111111`;
  return {
    id,
    route: "zavi_list",
    list_id: `L${n}`,
    list_name: `List ${n}`,
    planned_at: "2026-10-27T16:00:00Z",
    planned_label: "Tue, Oct 27, 09:00",
    timezone: "America/Los_Angeles",
    angle: `Angle ${n}`,
    why: null,
    source: "email_agent",
    status: "sent",
    status_reason: null,
    reason: null,
    content_version: 1,
    schedule_gen: 1,
    card: { rail: "decisions", id: `2222222${n}-2222-4222-8222-222222222222` },
    vetoed: false,
    scheduled: null,
    unattended: true,
    sent_at: "2026-10-27T16:00:00Z",
    ...over,
  };
};
const view = (items: unknown[], holds: unknown[] = []) => ({ ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, autopilot_on: true, items, holds, released: [] });

const rowOf = (angle: string) => screen.getAllByTestId("coming-up-item").find((r) => within(r).queryByText(angle))!;
const chipOf = (row: HTMLElement) => within(row).getAllByTestId("email-chip")[0].textContent;

beforeEach(() => {
  n = 0;
  reads.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
});
afterEach(cleanup);

describe("Coming up names a send by its card's own outcome, never the plan item's Sent (ROI #3)", () => {
  it("a sent plan item whose card is outcome_unknown, stopped, partly sent or failed never reads Sent", async () => {
    const unknown = item({ angle: "Unknown one", card_status: outcome({ status: "outcome_unknown", sent: 3, unknown: 2, may_have_sent: true, reason: MAY_HAVE }) });
    const stopped = item({ angle: "Stopped one", card_status: outcome({ status: "stopped", sent: 3, reason: STOPPED }) });
    const partly = item({ angle: "Partly one", card_status: outcome({ status: "partially_sent", sent: 7, reason: "3 people could not be emailed." }) });
    const failedMay = item({ angle: "Maybe gone one", card_status: outcome({ status: "failed", sent: null, may_have_sent: true, reason: HELD_REASON }) });
    const plain = item({ angle: "Plain one", card: null, card_status: null });
    const unread = item({ angle: "Unread card one", card_status: null });
    const sentCard = item({ angle: "Sent card one", card_status: outcome({}) });
    routes[PLAN] = view([unknown, stopped, partly, failedMay, plain, unread, sentCard]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item")).toHaveLength(7));

    const u = rowOf("Unknown one");
    expect(chipOf(u)).toBe("Delivery unknown");
    expect(within(u).getByText(MAY_HAVE)).toBeTruthy();
    expect(within(u).queryByText(/Sent by Autopilot/)).toBeNull();
    expect(u.textContent).not.toMatch(/\bSent\b/);

    const s = rowOf("Stopped one");
    expect(chipOf(s)).toBe("Stopped");
    expect(within(s).getByText(STOPPED)).toBeTruthy();
    expect(within(s).queryByText(/Sent by Autopilot/)).toBeNull();

    expect(chipOf(rowOf("Partly one"))).toBe("Partly sent");
    expect(chipOf(rowOf("Maybe gone one"))).toBe("Delivery unknown");
    expect(rowOf("Maybe gone one").textContent).not.toMatch(/\bFailed\b/);

    expect(chipOf(rowOf("Plain one"))).toBe("Sent");
    expect(within(rowOf("Plain one")).getByText(/Sent by Autopilot/)).toBeTruthy();
    expect(chipOf(rowOf("Unread card one"))).toBe("Checking");
    expect(within(rowOf("Unread card one")).queryByText(/Sent by Autopilot/)).toBeNull();
    expect(chipOf(rowOf("Sent card one"))).toBe("Sent");
    expect(within(rowOf("Sent card one")).getByText(/Sent by Autopilot/)).toBeTruthy();

    const sentChips = screen.getAllByTestId("coming-up-item").filter((r) => chipOf(r) === "Sent");
    expect(sentChips).toHaveLength(2);
  });

  it("an upcoming item still marked sending reads Stopped once its card stopped", async () => {
    routes[PLAN] = view([item({ angle: "In flight", status: "sending", unattended: false, sent_at: null, planned_at: new Date(Date.now() + 3_600_000).toISOString(), card_status: outcome({ status: "stopped", sent: 3, reason: STOPPED }) })]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(chipOf(rowOf("In flight"))).toBe("Stopped"));
    expect(screen.queryByTestId("coming-up-week")).toBeNull();
  });

  it("a Sent row flips to Delivery unknown when another surface changes the card and the plan re-reads", async () => {
    const before = item({ angle: "Flip one", card_status: outcome({}) });
    routes[PLAN] = view([before]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(chipOf(rowOf("Flip one"))).toBe("Sent"));
    const plansBefore = reads.filter((r) => r === PLAN).length;
    routes[PLAN] = view([{ ...before, card_status: outcome({ status: "outcome_unknown", sent: 3, unknown: 2, may_have_sent: true, reason: MAY_HAVE }) }]);
    act(() => announceEmailCardChanged({ rail: "decisions", id: (before.card as { id: string }).id, source: "elsewhere" }));
    await waitFor(() => expect(chipOf(rowOf("Flip one"))).toBe("Delivery unknown"));
    expect(reads.filter((r) => r === PLAN).length).toBeGreaterThan(plansBefore);
    expect(within(rowOf("Flip one")).getByText(MAY_HAVE)).toBeTruthy();
    expect(within(rowOf("Flip one")).queryByText(/Sent by Autopilot/)).toBeNull();
  });

  it("a list on hold says the card's own reason", async () => {
    routes[PLAN] = view([], [{ rail: "decisions", card_id: "33333333-3333-4333-8333-333333333333", list_key: "zavi_list:L9", since: "2026-10-27T16:00:00Z", since_label: "Oct 27", card_status: outcome({ status: "outcome_unknown", may_have_sent: true, reason: HELD_REASON }) }]);
    render(<EmailComingUpBlock />);
    const held = await screen.findByTestId("held-send");
    expect(within(held).getByTestId("held-send-reason").textContent).toBe(HELD_REASON);
  });
});

describe("the Autopilot strip when Zavi's own sender is stopped", () => {
  it("names the stopped sender, says the list is fine, and never asks to connect a tool or add a list", async () => {
    routes[PLAN] = { ...view([]), weekly_eligible: false, weekly_block: "sender_unavailable", next_plan_label: "Mon, Nov 2" };
    const r = render(<EmailComingUpBlock />);
    const status = await screen.findByTestId("coming-up-autopilot-status");
    expect(status.textContent).toMatch(/Zavi's own sender is stopped right now/);
    expect(status.textContent).toMatch(/Nothing is wrong with your list/);
    expect(status.textContent).toMatch(/Drafts wait until the sender is back/);
    expect(r.container.textContent ?? "").not.toMatch(/Connect an email tool|add a list|Next plan|Email is paused/);
  });
});
