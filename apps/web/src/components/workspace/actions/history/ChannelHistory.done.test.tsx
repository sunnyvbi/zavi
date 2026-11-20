// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelClosedRow, ChannelHistoryState } from "../useChannelHistory";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { ChannelHistory } from "./ChannelHistory";
import { EMAIL_PLAN_CHANGED_EVENT } from "../../email/NewCampaignDialog";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const closedRow = (n: number, over: Partial<ChannelClosedRow> = {}): ChannelClosedRow => ({
  id: `ca-${n}`,
  run_id: "run-1",
  position: n,
  run_of: 9,
  action_type: "check",
  title: `Finished card ${n}`,
  status: "acted",
  status_at: "2026-10-16T06:31:00Z",
  note: null,
  proposed_at: "2026-10-16T06:30:46Z",
  impact: 3,
  impact_reason: null,
  score: 10,
  ...over,
});
const planned = (n: number, over: Record<string, unknown> = {}) => ({
  id: `plan-${n}`,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Paying customers",
  planned_at: "2026-10-14T16:00:00Z",
  planned_label: "Tue, Oct 14, 09:00",
  timezone: "America/Los_Angeles",
  angle: `Planned send ${n}`,
  why: null,
  source: "email_agent",
  status: "sent",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: { rail: "channel_actions", id: `card-${n}` },
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: "2026-10-14T16:00:05Z",
  ...over,
});
let planItems: unknown[] = [];
const planReads = () => apiFetch.mock.calls.filter(([u]) => String(u) === "/api/workspace/email-plan").length;
const state = (closed: ChannelClosedRow[]): ChannelHistoryState => ({ state: "ready", history: { runs: [], closed, pre_switch: [] } });
const rows = () => {
  const list = within(screen.getByRole("region", { name: "History" })).getAllByRole("listitem");
  return list.map((li) => (li.getAttribute("data-testid") === "done-planned-row" ? `plan:${li.textContent}` : `card:${li.textContent}`));
};
const openDone = () => fireEvent.click(screen.getByRole("button", { name: /^History/ }));

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => (String(url) === "/api/workspace/email-plan" ? ok({ ok: true, role: "owner", timezone: "UTC", items: planItems }) : ok({})));
});
afterEach(cleanup);

describe("Done on the email channel", () => {
  it("sent planned emails count toward the same Show more limit as finished cards", async () => {
    planItems = [1, 2, 3, 4].map((n) => planned(n));
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([1, 2, 3].map((n) => closedRow(n)))} />);
    await waitFor(() => expect(screen.getAllByTestId("done-planned-row")).toHaveLength(4));
    openDone();
    expect(rows()).toHaveLength(5);
    expect(rows().filter((r) => r.startsWith("plan:"))).toHaveLength(4);
    expect(rows().filter((r) => r.startsWith("card:"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(rows()).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("a long run of sent planned emails alone is still paged", async () => {
    planItems = [1, 2, 3, 4, 5, 6, 7].map((n) => planned(n));
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([])} />);
    await waitFor(() => expect(screen.getAllByTestId("done-planned-row")).toHaveLength(5));
    openDone();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByTestId("done-planned-row")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("a planned email whose card is already a finished card is shown once, as the card, and rejected or stale cards stay out", async () => {
    planItems = [planned(1, { card: { rail: "channel_actions", id: "ca-1" } }), planned(2)];
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([closedRow(1), closedRow(5, { status: "rejected", title: "Rejected one" }), closedRow(6, { status: "stale", title: "Stale one" })])} />);
    await waitFor(() => expect(screen.getAllByTestId("done-planned-row")).toHaveLength(1));
    openDone();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText("Planned send 1")).toBeNull();
    expect(screen.getByText("Planned send 2")).toBeTruthy();
    expect(screen.getAllByText("Finished card 1")).toHaveLength(1);
    expect(screen.queryByText("Rejected one")).toBeNull();
    expect(screen.queryByText("Stale one")).toBeNull();
  });

  it("reads the plan again when the plan changes, so a newly sent email appears without a reload", async () => {
    planItems = [planned(1), planned(2, { status: "scheduled", sent_at: null })];
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([])} />);
    await waitFor(() => expect(screen.getAllByTestId("done-planned-row")).toHaveLength(1));
    expect(planReads()).toBe(1);
    planItems = [planned(1), planned(2)];
    act(() => {
      window.dispatchEvent(new CustomEvent(EMAIL_PLAN_CHANGED_EVENT));
    });
    await waitFor(() => expect(screen.getAllByTestId("done-planned-row")).toHaveLength(2));
    expect(planReads()).toBe(2);
  });

  it("History on other channels never reads the email plan, even when the plan changes", async () => {
    render(<ChannelHistory slug="linkedin_organic" history={state([closedRow(1)])} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(EMAIL_PLAN_CHANGED_EVENT));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(planReads()).toBe(0);
    expect(screen.queryByTestId("done-planned-row")).toBeNull();
  });
});

describe("a sent email in Done opens as sent, not as marked done", () => {
  const SENT_AT = "2026-10-27T11:07:08.091Z";
  const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(SENT_AT));
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });

  it("shows the send with count, list, tool and time, and says the 1 hour numbers are not in once the hour has passed", async () => {
    planItems = [];
    const row = closedRow(1, { action_type: "send_message", title: "The new chocolate cake box is out this week", status_at: SENT_AT, sent: { count: 2, list: "upcar.ai", tool: "mailchimp", at: SENT_AT } });
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([row])} />);
    await waitFor(() => expect(planReads()).toBe(1));
    openDone();
    fireEvent.click(screen.getByRole("button", { name: /The new chocolate cake box/ }));
    const dialog = screen.getByRole("dialog", { name: "The new chocolate cake box is out this week" });
    expect(within(dialog).getByText("Sent to 2 people on the upcar.ai list via Mailchimp")).toBeTruthy();
    expect(within(dialog).getByText(when).getAttribute("dateTime")).toBe(SENT_AT);
    expect(within(dialog).getByText("The 1 hour numbers are not in yet.")).toBeTruthy();
    expect(within(dialog).queryByText(/Results come in/)).toBeNull();
    expect(within(dialog).queryByText("Marked as done")).toBeNull();
    expect(within(dialog).queryByText("Measured results are not available for this item.")).toBeNull();
  });

  const openSent = async (sent: NonNullable<ChannelClosedRow["sent"]>) => {
    planItems = [];
    const row = closedRow(1, { action_type: "send_message", title: "HAPPY 02 november", status_at: sent.at, sent });
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([row])} />);
    await waitFor(() => expect(planReads()).toBe(1));
    openDone();
    fireEvent.click(screen.getByRole("button", { name: /HAPPY 02 november/ }));
    return screen.getByRole("dialog", { name: "HAPPY 02 november" });
  };

  it("shows the stored 1 hour numbers once they exist, in the card's words, and not the waiting sentence", async () => {
    const dialog = await openSent({ count: 5, list: "upcar.ai", tool: "sendgrid", at: SENT_AT, hour_1: { delivered: 5, opens: 0, clicks: 1, bounces: 0, why: { delivered: null, opens: null, clicks: null } } });
    expect(within(dialog).getByText("After 1 hour:").parentElement?.textContent).toBe("After 1 hour: Delivered 5 · Opens 0 · Clicks 1 · Bounces 0");
    expect(within(dialog).queryByText(/Results come in/)).toBeNull();
    expect(within(dialog).queryByText("At day 7:")).toBeNull();
  });

  it("shows the 1 hour and day 7 lines once day 7 is published", async () => {
    const dialog = await openSent({ count: 5, list: "upcar.ai", tool: "sendgrid", at: SENT_AT, hour_1: { delivered: 5, opens: 0, clicks: 1 }, day_7: { delivered: 5, opens: 3, clicks: 2 } });
    expect(within(dialog).getByText("At day 7:").parentElement?.textContent).toBe("At day 7: Delivered 5 · Opens 3 · Clicks 2");
    expect(within(dialog).getByText("After 1 hour:")).toBeTruthy();
  });

  it("a read the provider failed shows its honest reason, never zeros and never Results come in", async () => {
    const why = "SendGrid could not be read";
    const dialog = await openSent({ count: 5, list: "upcar.ai", tool: "sendgrid", at: SENT_AT, hour_1: { delivered: null, opens: null, clicks: null, bounces: null, why: { delivered: why, opens: why, clicks: why } } });
    expect(within(dialog).getByText(`Delivered, Opens, Clicks: ${why}`)).toBeTruthy();
    expect(within(dialog).queryByText(/Delivered 0|Opens 0|Clicks 0/)).toBeNull();
    expect(within(dialog).queryByText(/Results come in/)).toBeNull();
  });

  it("a Zavi-list send keeps the Results come in sentence", async () => {
    const dialog = await openSent({ count: 3, list: "upcar.ai", tool: "zavi_list", at: SENT_AT });
    expect(within(dialog).getByText("Results come in 1 hour after the send and again at day 7.")).toBeTruthy();
  });

  it("a done item that was not an email send still reads as marked done with no results", async () => {
    planItems = [];
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([closedRow(2)])} />);
    await waitFor(() => expect(planReads()).toBe(1));
    openDone();
    fireEvent.click(screen.getByRole("button", { name: /Finished card 2/ }));
    const dialog = screen.getByRole("dialog", { name: "Finished card 2" });
    expect(within(dialog).getByText("Marked as done")).toBeTruthy();
    expect(within(dialog).queryByText("Measured results are not available for this item.")).toBeNull();
    expect(within(dialog).queryByText(/^Sent/)).toBeNull();
    expect(within(dialog).queryByText(/day 7/)).toBeNull();
  });
});

describe("an approved card Zavi carried out opens with the approval and the change, not marked as done", () => {
  const PROPOSED = "2026-11-03T15:58:12Z";
  const APPROVED = "2026-11-03T16:00:03Z";
  const EXECUTED = "2026-11-03T16:00:41Z";
  const open = (slug: string, row: ChannelClosedRow) => {
    planItems = [];
    render(<ChannelHistory slug={slug} doneHistory history={state([row])} />);
    openDone();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(row.title) }));
    return screen.getByRole("dialog", { name: row.title });
  };
  const steps = (dialog: HTMLElement) =>
    within(within(dialog).getByRole("region", { name: "What happened" })).getAllByRole("listitem").map((li) => ({
      label: li.querySelector("p")?.textContent,
      at: li.querySelector("time")?.getAttribute("dateTime") ?? null,
    }));
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });

  it("a LinkedIn create card the founder approved reads suggested, approved by you, created, each at its own time", () => {
    const dialog = open("linkedin_ads", closedRow(1, {
      action_type: "create_ad", title: "Review and create your LinkedIn campaign", proposed_at: PROPOSED, status_at: EXECUTED,
      executed_at: EXECUTED, approval: { by: "you", name: null, at: APPROVED },
    }));
    expect(steps(dialog)).toEqual([
      { label: "Zavi suggested it", at: PROPOSED },
      { label: "You approved it", at: APPROVED },
      { label: "Zavi created it", at: EXECUTED },
    ]);
    expect(within(dialog).queryByText("Marked as done")).toBeNull();
  });

  it("an Autopilot approval says Autopilot, and a teammate with no name reads A teammate", () => {
    const auto = open("linkedin_ads", closedRow(2, { action_type: "pause_ad", executed_at: EXECUTED, approval: { by: "autopilot", name: null, at: APPROVED } }));
    expect(steps(auto).map((s) => s.label)).toEqual(["Zavi suggested it", "Autopilot approved it", "Zavi paused it"]);
    cleanup();
    const mate = open("meta_ads", closedRow(3, { action_type: "update_ad", executed_at: EXECUTED, approval: { by: "teammate", name: null, at: APPROVED } }));
    expect(steps(mate).map((s) => s.label)).toEqual(["Zavi suggested it", "A teammate approved it", "Zavi made the change"]);
    expect(within(mate).queryByText("Marked as done")).toBeNull();
  });

  it("an executed card whose approval time could not be read still shows the change at status_at, never Marked as done", () => {
    const dialog = open("reddit_ads", closedRow(4, { action_type: "create_ad", status_at: EXECUTED, executed_at: null, approval: null }));
    expect(steps(dialog)).toEqual([
      { label: "Zavi suggested it", at: "2026-10-16T06:30:46Z" },
      { label: "Zavi created it", at: EXECUTED },
    ]);
  });

  it("a card the founder ticked by hand still reads Marked as done", () => {
    const dialog = open("linkedin_ads", closedRow(5, { action_type: "setup" }));
    expect(steps(dialog).map((s) => s.label)).toEqual(["Zavi suggested it", "Marked as done"]);
    expect(within(dialog).queryByText(/approved it/)).toBeNull();
  });

  it("a sent email that also carries an approval keeps its sent line", () => {
    const SENT_AT = "2026-10-27T11:07:08.091Z";
    const dialog = open("email_marketing", closedRow(6, {
      action_type: "send_message", title: "Cake box email", status_at: SENT_AT, executed_at: SENT_AT,
      approval: { by: "you", name: null, at: APPROVED }, sent: { count: 2, list: "upcar.ai", tool: "mailchimp", at: SENT_AT },
    }));
    expect(steps(dialog).map((s) => s.label)).toEqual(["Zavi suggested it", "Sent to 2 people on the upcar.ai list via Mailchimp"]);
  });
});
