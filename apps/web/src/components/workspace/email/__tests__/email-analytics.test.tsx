// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { SentEmail } from "@/lib/workspace/emailResultsApi";

let reads = 0;
let limits: Array<number | undefined> = [];
let read: () => Promise<{ emails: SentEmail[]; more: boolean }> = async () => ({ emails: [], more: false });
vi.mock("@/lib/workspace/emailResultsApi", () => ({ getSentEmailsPage: (limit?: number) => {
  reads += 1;
  limits.push(limit);
  return read();
} }));

import { EmailAnalytics, emailRows, emailTotals, inWindow, loadedSince } from "../EmailAnalytics";

const DAY = 86_400_000;
const cell = (value: number | null) => ({ value, why: null });

function sent(id: string, subject: string, daysAgo: number, people: number, opens: number | null, clicks: number | null, visitors: number | null = null): SentEmail {
  return {
    card: { rail: "channel_actions", id, link: `https://x/${id}` },
    route: "zavi_list",
    sent_with: "Zavi",
    subject,
    list_name: "List",
    started_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
    finished_at: null,
    spanned: false,
    stage: "d7",
    people: { sent: people, total: people, stopped: false },
    as_of: "d7",
    delivered: cell(people),
    opens: cell(opens),
    opens_label: "Opens",
    clicks: cell(clicks),
    unsubscribes: cell(0),
    visitors: cell(visitors),
    win_line: { text: "", metric: null, threshold: null, basis: "" },
    verdict: null,
    verdict_text: "",
    d7_due_at: null,
    note: null,
  };
}

const emails = [
  sent("a", "Your first week", 3, 1000, 460, 110, 12),
  sent("b", "Win back drivers", 10, 500, 100, 39, 5),
  sent("c", "Old one", 45, 1000, 200, 100, 10),
];

describe("email analytics numbers", () => {
  it("sums the window and leaves older sends out", () => {
    const now = Date.now();
    const t = emailTotals(inWindow(emails, 30, now));
    expect(t).toMatchObject({ sent: 1500, opens: 560, delivered: 1500, clicks: 149, visitors: 17, allClicks: true, allVisitors: true });
    expect(emailTotals(inWindow(emails, 30, now, 1)).sent).toBe(1000);
  });

  it("does not count clicks or visitors as known while any email in the window is still unmeasured", () => {
    const t = emailTotals([emails[0], sent("d", "Still sending", 1, 300, null, null, null)]);
    expect(t).toMatchObject({ allClicks: false, allVisitors: false });
    expect(emailTotals([])).toMatchObject({ allClicks: false, allVisitors: false });
  });

  it("treats a complete list as covering all time and a cut list as covering back to its oldest finished send", () => {
    const at = (d: number) => new Date(Date.now() - d * DAY).toISOString();
    const list = [{ ...emails[0], finished_at: null }, { ...emails[1], finished_at: at(10) }, { ...emails[2], finished_at: at(45) }];
    expect(loadedSince(list, false)).toBe(-Infinity);
    expect(loadedSince(list, true)).toBe(Date.parse(list[2].finished_at!));
    expect(loadedSince([{ ...emails[0], finished_at: null }], true)).toBe(Infinity);
  });

  it("ranks campaigns by open rate and links each to its email card", () => {
    const rows = emailRows(emails.slice(0, 2));
    expect(rows.map((r) => r.subject)).toEqual(["Your first week", "Win back drivers"]);
    expect(rows[0].openRate).toBeCloseTo(0.46);
    expect(rows[0].link).toBe("/workspace/email-cards/channel_actions/a");
  });
});

describe("<EmailAnalytics>", () => {
  beforeEach(() => {
    reads = 0;
    limits = [];
  });
  afterEach(cleanup);

  it("shows the best campaign, the four tiles with the change on last month, and the table", async () => {
    read = async () => ({ emails, more: false });
    render(<EmailAnalytics active />);
    expect((await screen.findByTestId("email-analytics-headline")).textContent).toContain("“Your first week” is your best campaign in the last 30 days.");
    expect((screen.getByTestId("kpi-tile-sent")).textContent).toContain("1.5K");
    expect((screen.getByTestId("kpi-tile-sent")).textContent).toMatch(/50% up\s*on last month/);
    expect((screen.getByTestId("kpi-tile-clicks")).textContent).toContain("149");
    expect((screen.getByTestId("kpi-tile-open-rate")).textContent).toContain("37%");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Best")).toBeTruthy();
  });

  it("says nothing was sent instead of inventing a best campaign", async () => {
    read = async () => ({ emails: [], more: false });
    render(<EmailAnalytics active />);
    expect((await screen.findByTestId("email-analytics-headline")).textContent).toContain("Nothing sent in the last 30 days.");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps sent campaigns visible while results are pending", async () => {
    read = async () => ({ emails: [sent("pending", "Just sent", 1, 100, null, null)], more: false });
    render(<EmailAnalytics active />);
    const headline = await screen.findByTestId("email-analytics-headline");
    expect(headline.textContent).toMatch(/results.*not.*yet/i);
    expect(headline.textContent).not.toContain("Nothing sent");
    expect(screen.getByTestId("kpi-tile-sent").textContent).toContain("100");
    expect(within(screen.getByRole("table")).getByText("Just sent")).toBeTruthy();
  });

  it.each([null, 0, 5])("distinguishes unknown clicks from a measured %s", async (clicks) => {
    read = async () => ({ emails: [sent("new", "Current", 1, 100, null, clicks), sent("old", "Previous", 40, 100, 20, 10)], more: false });
    render(<EmailAnalytics active />);
    await screen.findByTestId("email-analytics-headline");
    const tile = screen.getByTestId("kpi-tile-clicks");
    expect(within(tile).getByText(clicks === null ? "–" : String(clicks))).toBeTruthy();
    if (clicks === null) expect(tile.textContent).not.toMatch(/%|up|down/);
    else expect(tile.textContent).toContain(`${(10 - clicks) * 10}% down`);
  });

  it("does not invent a click comparison when the previous count is unknown", async () => {
    read = async () => ({ emails: [sent("new", "Current", 1, 100, 20, 5), sent("old", "Previous", 40, 100, null, null)], more: false });
    render(<EmailAnalytics active />);
    await screen.findByTestId("email-analytics-headline");
    expect(screen.getByTestId("kpi-tile-clicks").textContent).not.toMatch(/%|up|down/);
  });

  it("reads the latest 200 sends and keeps the change when they reach back past the comparison window", async () => {
    read = async () => ({ emails: [...emails, { ...sent("z", "Oldest loaded", 70, 10, 1, 1), finished_at: new Date(Date.now() - 70 * DAY).toISOString() }], more: true });
    render(<EmailAnalytics active />);
    await screen.findByTestId("email-analytics-headline");
    expect(limits).toEqual([200]);
    expect(screen.getByTestId("kpi-tile-sent").textContent).toMatch(/50% up\s*on last month/);
    expect(screen.queryByTestId("email-analytics-cut")).toBeNull();
  });

  it("hides the change and says so when the loaded sends stop inside the comparison window", async () => {
    read = async () => ({ emails: emails.map((e) => ({ ...e, finished_at: e.started_at })), more: true });
    render(<EmailAnalytics active />);
    await screen.findByTestId("email-analytics-headline");
    expect(screen.getByTestId("kpi-tile-sent").textContent).toContain("1.5K");
    for (const id of ["sent", "open-rate", "clicks", "visitors"]) expect(screen.getByTestId(`kpi-tile-${id}`).textContent).not.toMatch(/% (up|down)/);
    expect(screen.getByTestId("email-analytics-cut").textContent).toContain("Based on your latest 200 sends.");
  });

  it("does not read until the tab is opened", () => {
    render(<EmailAnalytics active={false} />);
    expect(reads).toBe(0);
  });

  it("offers Try again when the read fails", async () => {
    read = async () => {
      throw new Error("Sent emails could not be loaded. Try again.");
    };
    render(<EmailAnalytics active />);
    expect((await screen.findByRole("alert")).textContent).toContain("Sent emails could not be loaded.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
