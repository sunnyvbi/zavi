// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelClosedRow, ChannelHistoryState, PreSwitchRow } from "../useChannelHistory";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { ChannelHistory } from "./ChannelHistory";
import { historyKind } from "./historyPresentation";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const closedRow = (id: string, over: Partial<ChannelClosedRow> = {}): ChannelClosedRow => ({
  id,
  run_id: "run-1",
  position: 1,
  run_of: 3,
  action_type: "send_message",
  title: `Card ${id}`,
  status: "acted",
  status_at: "2026-10-18T06:31:00Z",
  note: null,
  proposed_at: "2026-10-18T06:30:46Z",
  impact: null,
  impact_reason: null,
  score: null,
  ...over,
});
const sentPlan = (cardId: string, listName: string) => ({
  id: `plan-${cardId}`,
  route: "mailchimp",
  list_id: "L1",
  list_name: listName,
  planned_at: "2026-10-18T16:00:00Z",
  planned_label: "Sat, Oct 18, 09:00",
  timezone: "UTC",
  angle: "Planned",
  why: null,
  source: "email_agent",
  status: "sent",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: { rail: "decisions", id: cardId },
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: "2026-10-18T16:00:05Z",
});
let planItems: unknown[] = [];
const state = (closed: ChannelClosedRow[], pre_switch: PreSwitchRow[] = []): ChannelHistoryState => ({ state: "ready", history: { runs: [], closed, pre_switch } });
const rowFor = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => (String(url) === "/api/workspace/email-plan" ? ok({ ok: true, role: "owner", timezone: "UTC", items: planItems }) : ok({})));
});
afterEach(cleanup);

describe("history row kind label", () => {
  it("names a finished email send by its list on the email channel's Done list and in its detail header, and never shows the word item", async () => {
    planItems = [sentPlan("dec-1", "Newsletter")];
    render(<ChannelHistory slug="email_marketing" doneHistory history={state([
      closedRow("dec-1", { title: "Send the October newsletter to the Newsletter list" }),
      closedRow("dec-2", { title: "Fresh from the oven this week" }),
      closedRow("ca-3", { action_type: "fix", title: "Publish a DMARC record on the domain you will send from" }),
      closedRow("ca-4", { action_type: "other", title: "Add a waitlist signup form" }),
    ])} />);
    fireEvent.click(screen.getByRole("button", { name: /^History/ }));
    await waitFor(() => expect(rowFor("Send the October newsletter to the Newsletter list").textContent).toContain("Email to Newsletter · Oct 18"));
    expect(rowFor("Fresh from the oven this week").textContent).toContain("Email · Oct 18");
    expect(rowFor("Publish a DMARC record on the domain you will send from").textContent).toContain("Fix · Oct 18");
    expect(rowFor("Add a waitlist signup form").textContent).toContain("Action · Oct 18");
    const region = screen.getByRole("region", { name: "History" });
    for (const li of within(region).getAllByRole("listitem")) {
      expect(li.textContent).not.toMatch(/\bitem\b/);
      expect(li.textContent).not.toMatch(/_/);
    }
    fireEvent.click(within(rowFor("Send the October newsletter to the Newsletter list")).getByRole("button"));
    const dialog = await screen.findByRole("dialog");
    const header = dialog.querySelector("header")!.textContent;
    expect(header).toContain("DoneEmail to Newsletter · Oct 18");
    expect(header).not.toMatch(/\bitem\b/);
  });

  it("names a finished email send by its list in the email channel's ordinary History view too", async () => {
    planItems = [sentPlan("dec-1", "Newsletter")];
    render(<ChannelHistory slug="email_marketing" history={state([
      closedRow("dec-1", { title: "Send the October newsletter to the Newsletter list" }),
      closedRow("dec-2", { title: "Fresh from the oven this week", status: "rejected" }),
    ])} />);
    fireEvent.click(screen.getByRole("button", { name: /^History/ }));
    await waitFor(() => expect(rowFor("Send the October newsletter to the Newsletter list").textContent).toContain("Email to Newsletter · Oct 18"));
    expect(rowFor("Fresh from the oven this week").textContent).toContain("Email · Oct 18");
    expect(screen.queryByTestId("done-planned-row")).toBeNull();
    expect(apiFetch.mock.calls.filter(([url]) => String(url) === "/api/workspace/email-plan")).toHaveLength(1);
  });

  it("does not read the email plan on a channel other than email", async () => {
    planItems = [sentPlan("dec-1", "Newsletter")];
    render(<ChannelHistory slug="linkedin_organic" history={state([closedRow("dec-1", { title: "Post the October update" })])} />);
    fireEvent.click(screen.getByRole("button", { name: /^History/ }));
    await waitFor(() => expect(rowFor("Post the October update").textContent).toContain("Message · Oct 18"));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("labels each source and channel with a founder-facing word", () => {
    const action = (action_type: ChannelClosedRow["action_type"]) => ({ source: "action" as const, row: closedRow("x", { action_type }) });
    expect(historyKind(action("send_message"), { email: true, listName: "Regulars" })).toBe("Email to Regulars");
    expect(historyKind(action("send_message"), { email: true })).toBe("Email");
    expect(historyKind(action("send_message"))).toBe("Message");
    expect(historyKind(action("create_ad"))).toBe("New ad");
    expect(historyKind(action("pause_ad"))).toBe("Pause ad");
    expect(historyKind(action("other"))).toBe("Action");
    expect(historyKind({ source: "previous", row: { run_id: null, title: "Old", position: 1, of: 1, status: "archived", emitted_at: null, archived_at: null, source: "decision" } })).toBe("Earlier item");
  });
});
