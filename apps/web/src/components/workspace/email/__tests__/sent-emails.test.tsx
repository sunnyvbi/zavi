// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

const routes: Record<string, { status: number; body: unknown }> = {};
const calls: string[] = [];
const holds: Record<string, Promise<void>> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    calls.push(url);
    const gate = holds[`GET ${url}`];
    if (gate) await gate;
    const r = routes[`GET ${url}`] ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
const ga = vi.hoisted(() => ({ connect: vi.fn(async () => undefined) }));
vi.mock("@/app/connectors/GoogleAnalyticsConnectButton", () => ({ startGoogleAnalyticsConnect: ga.connect }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { SentEmailsBlock, sentFollowUps, totals } from "../SentEmailsBlock";
import { announceEmailCardChanged } from "@/lib/workspace/emailCardEvents";
import { CHANNEL_HISTORY_CHANGED_EVENT } from "../../actions/useChannelHistory";
import { EmailPager } from "../EmailPager";
import { ChannelOverviewPanels } from "../EmailSettingsPanels";
import { EMAIL_PLAN_CHANGED_EVENT } from "../NewCampaignDialog";
import { PLATFORMS, platformFor } from "../../actions/platforms";
import { showsAccountSnapshot } from "../../actions/platformSpec";
import type { SentEmail } from "@/lib/workspace/emailResultsApi";

const cell = (value: number | null, why: string | null = null, action?: "connect_ga") => ({ value, why, ...(action ? { action } : {}) });
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
let seq = 0;
const row = (over: Partial<SentEmail> = {}): SentEmail => {
  seq += 1;
  return {
    card: { rail: "channel_actions", id: `card-${seq}`, link: "" },
    route: "sendgrid",
    sent_with: "SendGrid",
    subject: `Email ${seq}`,
    list_name: "Newsletter",
    started_at: "2026-10-12T15:00:00Z",
    finished_at: "2026-10-12T15:00:00Z",
    spanned: false,
    stage: "d7",
    people: { sent: 200, total: null, stopped: false },
    as_of: "d7",
    delivered: cell(200),
    opens: cell(100),
    opens_label: "Opens",
    clicks: cell(20),
    unsubscribes: cell(1),
    visitors: cell(10),
    win_line: { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, basis: "median" },
    verdict: "beat",
    verdict_text: "Beat the win line",
    d7_due_at: null,
    note: null,
    ...over,
  };
};
const plan = (over: Record<string, unknown> = {}) => ({
  id: `plan-${(seq += 1)}`,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Paying customers",
  planned_at: "2026-10-21T16:00:00Z",
  planned_label: "Wed, Oct 21, 09:00",
  timezone: "America/Los_Angeles",
  angle: "Holiday hours",
  why: null,
  source: "email_agent",
  status: "planned",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: null,
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: null,
  ...over,
});
const serve = (emails: SentEmail[], status = 200, more = false) => {
  routes["GET /api/email-results"] = { status, body: status < 400 ? { emails, more } : { error: { message: "Sent emails could not be loaded. Try again." } } };
};
const servePlan = (items: unknown[], status = 200) => {
  routes["GET /api/workspace/email-plan"] = {
    status,
    body: status < 400 ? { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: null, items, holds: [], released: [] } : { error: { message: "down" } },
  };
};
const serveGa = (connected: boolean) => {
  routes["GET /api/connectors"] = { status: 200, body: { connectors: connected ? [{ slug: "google_analytics" }] : [{ slug: "slack" }] } };
};
const stat = (id: string) => screen.getByTestId(`${id}-value`).textContent;
const sub = (id: string) => screen.getByTestId(`${id}-sub`).textContent;
const loaded = () => screen.findByTestId("stat-strip");

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  for (const k of Object.keys(holds)) delete holds[k];
  calls.length = 0;
  ga.connect.mockClear();
  servePlan([]);
  serveGa(true);
});
afterEach(cleanup);

describe("How your emails are doing: stat strip", () => {
  it("when the server holds older sends than it returned, All time says the totals cover only the recent ones", async () => {
    serve([row({ people: { sent: 200, total: null, stopped: false } })], 200, true);
    render(<SentEmailsBlock />);
    await loaded();
    expect(screen.getByTestId("sent-emails-capped").textContent).toBe(
      "Only your most recent sent emails are shown here, and these totals count only them. Older emails are not included.",
    );
  });

  it("no capped note when every send is in the list", async () => {
    serve([row({ people: { sent: 200, total: null, stopped: false } })]);
    render(<SentEmailsBlock />);
    await loaded();
    expect(screen.queryByTestId("sent-emails-capped")).toBeNull();
  });

  it("sums people, opens, clicks; open and click rate are out of DELIVERED; visits share only pairs rows where both are known", async () => {
    serve([
      row({ people: { sent: 200, total: null, stopped: false }, delivered: cell(200), opens: cell(100), clicks: cell(20), visitors: cell(10) }),
      row({ people: { sent: 120, total: null, stopped: false }, delivered: cell(100), opens: cell(20), clicks: cell(4), visitors: cell(null, "GA had no data") }),
    ]);
    render(<SentEmailsBlock />);
    await loaded();
    expect(stat("stat-people")).toBe("320");
    expect(sub("stat-people")).toBe("2 campaigns");
    expect(stat("stat-open")).toBe("40.0%");
    expect(sub("stat-open")).toBe("120 opens");
    expect(stat("stat-click")).toBe("8.0%");
    expect(sub("stat-click")).toBe("24 clicks");
    expect(stat("stat-visits")).toBe("10");
    expect(sub("stat-visits")).toBe("5.0% of people emailed");
    expect(stat("stat-cto")).toBe("20.0%");
  });

  it("a number Zavi does not have is a dash, never 0; delivered unknown makes the rate a dash rather than falling back to people", async () => {
    serve([
      row({
        people: { sent: null, total: null, stopped: false },
        delivered: cell(null, "SendGrid does not report this"),
        opens: cell(50),
        clicks: cell(null, "Not reported"),
        visitors: cell(null, "GA had no data"),
      }),
    ]);
    render(<SentEmailsBlock />);
    await loaded();
    expect(stat("stat-people")).toBe("–");
    expect(stat("stat-open")).toBe("–");
    expect(stat("stat-click")).toBe("–");
    expect(stat("stat-visits")).toBe("–");
    expect(stat("stat-cto")).toBe("–");
    expect(sub("stat-open")).toBe("");
    expect(sub("stat-click")).toBe("");
    expect(sub("stat-visits")).toBe("");
    expect(sub("stat-cto")).toBe("");
    expect(sub("stat-people")).toBe("");
    expect(screen.getByTestId("email-performance").textContent).not.toMatch(/Not reported yet|out of delivered emails|reached your site/);
    const strip = screen.getByTestId("stat-strip").textContent ?? "";
    expect(strip).not.toMatch(/(^|[^\d.])0(\.0%)?([^\d.%]|$)/);
    expect(screen.getAllByText("SendGrid does not report this").length).toBeGreaterThan(0);
  });

  it("a real 0 stays 0", async () => {
    serve([row({ clicks: cell(0), visitors: cell(0) })]);
    render(<SentEmailsBlock />);
    await loaded();
    expect(stat("stat-click")).toBe("0.0%");
    expect(stat("stat-cto")).toBe("0.0%");
    expect(stat("stat-visits")).toBe("0");
  });

  it("totals pure function: row with delivered unknown is left out of the open rate on both sides", () => {
    const t = totals([row({ delivered: cell(100), opens: cell(50) }), row({ delivered: cell(null), opens: cell(1000) })]);
    expect(t.openRate).toBe(0.5);
    expect(t.opens).toBe(1050);
    expect(totals([]).people).toBeNull();
  });
});

describe("loading", () => {
  it("while the results read is pending, a skeleton shaped like the block shows five stat placeholders, and it is gone once rows land", async () => {
    let release = () => {};
    holds["GET /api/email-results"] = new Promise<void>((done) => {
      release = done;
    });
    serve([row({ subject: "Landed send" })]);
    render(<SentEmailsBlock />);
    const loading = await screen.findByTestId("sent-emails-loading");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(within(loading).getByText("Loading your email results")).toBeTruthy();
    expect(within(loading).getAllByTestId("sent-emails-loading-stat")).toHaveLength(5);
    expect(screen.queryByTestId("stat-strip")).toBeNull();
    release();
    expect(await screen.findByRole("link", { name: "Landed send" })).toBeTruthy();
    expect(screen.queryByTestId("sent-emails-loading")).toBeNull();
    expect(screen.getAllByTestId(/^stat-[a-z]+$/).filter((el) => el.getAttribute("data-testid") !== "stat-strip")).toHaveLength(5);
  });
});

describe("campaign filter and pages of ten", () => {
  it("the campaign filter: unticking a campaign changes the strip, footer and label; Select all brings every campaign back; a click outside or Escape closes it", async () => {
    serve([
      row({ subject: "Big send", people: { sent: 300, total: null, stopped: false }, delivered: cell(300), opens: cell(150), clicks: cell(30), visitors: cell(12) }),
      row({ subject: "Small send", people: { sent: 100, total: null, stopped: false }, delivered: cell(100), opens: cell(10), clicks: cell(1), visitors: cell(3) }),
    ]);
    render(<SentEmailsBlock />);
    await loaded();
    const filter = screen.getByTestId("campaign-filter") as HTMLDetailsElement;
    expect(within(filter).getByText("All sent campaigns · 2")).toBeTruthy();
    expect(within(screen.getByTestId("campaign-table-box")).queryAllByRole("checkbox", { hidden: true })).toHaveLength(0);
    expect(stat("stat-people")).toBe("400");
    fireEvent.click(within(filter).getByRole("checkbox", { name: /Small send/, hidden: true }));
    expect(stat("stat-people")).toBe("300");
    expect(stat("stat-open")).toBe("50.0%");
    expect(within(filter).getByText("1 of 2 sent campaigns")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Small send" })).toBeNull();
    expect(screen.getAllByTestId("row-sent")).toHaveLength(1);
    fireEvent.click(within(filter).getByRole("checkbox", { name: "Count every sent campaign", hidden: true }));
    expect(stat("stat-people")).toBe("400");
    expect(screen.getByRole("link", { name: "Small send" })).toBeTruthy();
    expect(screen.getAllByTestId("row-sent")).toHaveLength(2);
    filter.open = true;
    fireEvent.pointerDown(within(filter).getByRole("checkbox", { name: /Big send/ }));
    expect(filter.open).toBe(true);
    fireEvent.pointerDown(screen.getByTestId("stat-strip"));
    expect(filter.open).toBe(false);
    filter.open = true;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(filter.open).toBe(false);
  });

  const untick = (...names: string[]) => {
    const filter = within(screen.getByTestId("campaign-filter"));
    for (const name of names) fireEvent.click(filter.getByRole("checkbox", { name: new RegExp(`^${name} `), hidden: true }));
  };
  const sentNames = () => screen.getAllByTestId("row-sent").map((r) => within(r).getAllByRole("link")[0].textContent);
  const twelve = () => Array.from({ length: 12 }, (_, k) => row({ subject: `Send ${k + 1}`, people: { sent: 10 * (k + 1), total: null, stopped: false } }));

  it("unticking down to two of twelve campaigns leaves exactly those two rows, drops the pager and keeps the scheduled row", async () => {
    serve(twelve());
    servePlan([plan({ angle: "Planned one", status: "scheduled" })]);
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("1\u201310 of 13");
    untick(...Array.from({ length: 10 }, (_, k) => `Send ${k + 3}`));
    expect(sentNames().sort()).toEqual(["Send 1", "Send 2"]);
    expect(screen.getAllByTestId("row-scheduled")).toHaveLength(1);
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    expect(stat("stat-people")).toBe("30");
    expect(within(screen.getByTestId("campaign-filter")).getByText("2 of 12 sent campaigns")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Sent/ }));
    expect(screen.getAllByTestId("row-sent")).toHaveLength(2);
    expect(screen.queryByTestId("row-scheduled")).toBeNull();
  });

  it("ticked campaigns that still need two pages page by the filtered count", async () => {
    serve(twelve());
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    untick("Send 1");
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("1\u201310 of 11");
    expect(screen.getAllByTestId("row-sent")).toHaveLength(10);
    untick("Send 2");
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    expect(screen.getAllByTestId("row-sent")).toHaveLength(10);
  });

  it("unticking all shows a message instead of rows, keeps the picker, and ticking one brings its row back", async () => {
    serve(twelve());
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    const filter = () => within(screen.getByTestId("campaign-filter"));
    fireEvent.click(filter().getByRole("checkbox", { name: "Count every sent campaign", hidden: true }));
    expect(screen.getByTestId("sent-emails-none-selected").textContent).toBe("No campaigns selected.");
    expect(screen.queryByTestId("sent-emails-range-empty")).toBeNull();
    expect(screen.queryByTestId("campaign-table-box")).toBeNull();
    expect(screen.queryByTestId("row-sent")).toBeNull();
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    expect(stat("stat-people")).toBe("\u2013");
    expect(filter().getByText("0 of 12 sent campaigns")).toBeTruthy();
    untick("Send 5");
    expect(screen.queryByTestId("sent-emails-none-selected")).toBeNull();
    expect(sentNames()).toEqual(["Send 5"]);
    expect(stat("stat-people")).toBe("50");
  });

  it("on page two, unticking until page two no longer exists lands on a valid page with the right range", async () => {
    serve(Array.from({ length: 14 }, (_, k) => row({ subject: `Send ${k + 1}` })));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    fireEvent.click(within(screen.getByTestId("campaign-pager")).getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("11\u201314 of 14");
    untick("Send 1", "Send 2", "Send 3", "Send 4");
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    expect(screen.getAllByTestId("row-sent")).toHaveLength(10);
    expect(sentNames()).not.toContain("Send 1");
  });

  it("one sent campaign shows no filter, since there is nothing to choose between", async () => {
    serve([row({ subject: "Only send" })]);
    render(<SentEmailsBlock />);
    await loaded();
    expect(screen.queryByTestId("campaign-filter")).toBeNull();
  });

  it("more than ten rows page by ten: range text, previous and next, no totals row on any page, and a tab change goes back to page one", async () => {
    serve(Array.from({ length: 12 }, (_, k) => row({ subject: `Send ${k + 1}`, people: { sent: 10, total: null, stopped: false } })));
    servePlan([plan({ angle: "Planned one", status: "scheduled" })]);
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    const pager = screen.getByTestId("campaign-pager");
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("1–10 of 13");
    expect(screen.getAllByTestId("row-sent")).toHaveLength(10);
    expect(screen.queryByTestId("totals-row")).toBeNull();
    expect((within(pager).getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("11–13 of 13");
    expect(screen.getAllByTestId("row-sent")).toHaveLength(2);
    expect(screen.getByTestId("row-scheduled")).toBeTruthy();
    expect((within(pager).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Sent/ }));
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("1–10 of 12");
    expect(screen.getByRole("link", { name: "Send 1" })).toBeTruthy();
  });

  it("eleven sent emails: page two holds one row labelled '11 of 11', drawn by the same pager People and Suppressed use", async () => {
    serve(Array.from({ length: 11 }, (_, k) => row({ subject: `Send ${k + 1}` })));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    const pager = screen.getByTestId("campaign-pager");
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("campaign-pager-range").textContent).toBe("11 of 11");
    expect(screen.getAllByTestId("row-sent")).toHaveLength(1);
    const shape = (el: Element): unknown => ({
      tag: el.tagName,
      cls: el.getAttribute("class"),
      label: el.tagName === "BUTTON" ? el.textContent : undefined,
      disabled: (el as HTMLButtonElement).disabled,
      kids: [...el.children].map(shape),
    });
    const box = document.createElement("div");
    document.body.appendChild(box);
    render(<EmailPager label="ref" testId="ref-pager" range="11 of 11" canPrev canNext={false} onPrev={() => undefined} onNext={() => undefined} />, { container: box });
    expect(shape(screen.getByTestId("campaign-pager"))).toEqual(shape(screen.getByTestId("ref-pager")));
    expect(screen.getByTestId("campaign-pager").getAttribute("class")).toContain("justify-end");
    expect(screen.queryByText(/Page \d/)).toBeNull();
  });

  it("ten rows or fewer show no pager", async () => {
    serve(Array.from({ length: 10 }, (_, k) => row({ subject: `Send ${k + 1}` })));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 10" });
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    expect(screen.queryByTestId("totals-row")).toBeNull();
  });
});

describe("tabs, rows and pills", () => {
  it("All shows sent, scheduled and draft rows with their pills; each tab filters; done, skipped and vetoed plan items stay out", async () => {
    serve([row({ subject: "Launch week", finished_at: "2026-10-12T15:00:00Z" })]);
    servePlan([
      plan({ angle: "Holiday hours", status: "scheduled", planned_at: "2026-10-28T16:00:00Z", list_name: "All users" }),
      plan({ angle: "Win back lapsed", status: "ready", card: { rail: "channel_actions", id: "draft-1" }, list_name: "Lapsed" }),
      plan({ angle: "Already sent", status: "sent" }),
      plan({ angle: "Skipped one", status: "skipped" }),
      plan({ angle: "Vetoed one", status: "skipped", vetoed: true }),
    ]);
    render(<SentEmailsBlock />);
    await screen.findByText("Holiday hours");
    const pills = screen.getAllByTestId("status-pill").map((p) => [p.getAttribute("data-tone"), p.textContent]);
    expect(pills).toEqual([
      ["sent", "Sent"],
      ["scheduled", "Scheduled"],
      ["draft", "Draft"],
    ]);
    expect(screen.getAllByTestId("campaign-meta").map((m) => m.textContent)).toEqual(["Newsletter · Oct 12", "All users · Oct 28", "Lapsed"]);
    expect(screen.queryByRole("columnheader", { name: "List" })).toBeNull();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Campaign", "Status", "Emailed", "Open rate", "Click rate", "Site visits"]);
    expect(screen.queryByText("Already sent")).toBeNull();
    expect(screen.queryByText("Skipped one")).toBeNull();
    expect(screen.queryByText("Vetoed one")).toBeNull();
    expect((screen.getByRole("link", { name: "Win back lapsed" }) as HTMLAnchorElement).getAttribute("href")).toBe("/workspace/email-cards/channel_actions/draft-1");
    const draftRow = screen.getByTestId("row-draft");
    expect(within(draftRow).getByTestId("plan-results").textContent).toBe("–Results show after you approve and send it");
    expect(within(draftRow).getByText("Results show after you approve and send it").className).toContain("sr-only");
    expect(within(screen.getByTestId("row-scheduled")).getByText("Results show after it sends").className).toContain("sr-only");

    const segmented = screen.getByRole("group", { name: "Show" });
    expect(segmented.className).toContain("bg-creamDeep");
    expect(segmented.className).not.toMatch(/\bborder\b/);
    const segments = within(segmented).getAllByRole("button");
    expect(segments.map((c) => c.textContent)).toEqual(["All3", "Sent1", "Scheduled1", "Drafts1"]);
    expect(segments.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(segments[0].className).toContain("bg-white");
    expect(segments[1].className).not.toContain("bg-white");
    expect(screen.getByTestId("tab-count-all").className).toContain("text-inkMuted");
    expect(screen.getByTestId("tab-count-sent").className).toContain("text-inkLight");

    fireEvent.click(screen.getByRole("button", { name: "Sent 1" }));
    expect(screen.getAllByTestId("row-sent")).toHaveLength(1);
    expect(screen.queryByTestId("row-scheduled")).toBeNull();
    expect(screen.queryByTestId("row-draft")).toBeNull();
    expect(screen.queryByTestId("totals-row")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Scheduled 1" }));
    expect(screen.getAllByTestId("row-scheduled")).toHaveLength(1);
    expect(screen.queryByTestId("row-sent")).toBeNull();
    expect(screen.queryByTestId("totals-row")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Drafts/ }));
    expect(screen.getAllByTestId("row-draft")).toHaveLength(1);
    expect(screen.queryByTestId("row-scheduled")).toBeNull();
    expect(screen.getByRole("button", { name: "Drafts 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All 3" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Drafts 1" }).className).toContain("bg-white");
    expect(screen.getByTestId("tab-count-drafts").className).toContain("text-inkMuted");
  });

  it("no Drafts tab without draft rows; scheduled rows do not move the totals", async () => {
    serve([row({ people: { sent: 50, total: null, stopped: false } })]);
    servePlan([plan({ status: "scheduled" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("row-scheduled");
    expect(screen.queryByRole("button", { name: /^Drafts/ })).toBeNull();
    expect(stat("stat-people")).toBe("50");
  });

  it("a plan saved from New campaign shows up without a reload", async () => {
    serve([row()]);
    render(<SentEmailsBlock />);
    await loaded();
    expect(screen.queryByTestId("row-scheduled")).toBeNull();
    servePlan([plan({ angle: "Fresh plan" })]);
    window.dispatchEvent(new CustomEvent(EMAIL_PLAN_CHANGED_EVENT));
    expect(await screen.findByText("Fresh plan")).toBeTruthy();
  });

  it("the plan failing keeps the sent results and offers Try again", async () => {
    serve([row({ people: { sent: 75, total: null, stopped: false } })]);
    servePlan([], 500);
    render(<SentEmailsBlock />);
    expect(await screen.findByText(/Scheduled emails could not be loaded/)).toBeTruthy();
    expect(stat("stat-people")).toBe("75");
    servePlan([plan({ angle: "Back again" })]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Back again")).toBeTruthy();
  });

  it("the subject opens the email card; only the list and date sit under it, no win line, verdict or timing note", async () => {
    serve([row({ subject: "Launch week at Brightloop", card: { rail: "decisions", id: "abc", link: "" }, as_of: "h1", stage: "h1", spanned: true, verdict: null, verdict_text: "Due Oct 19" })]);
    render(<SentEmailsBlock />);
    const link = (await screen.findByRole("link", { name: "Launch week at Brightloop" })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/workspace/email-cards/decisions/abc");
    const cell = link.closest("td") as HTMLElement;
    expect(cell.textContent).not.toMatch(/Win line|visit your site|Due Oct 19/);
    expect(screen.queryByTestId("win-line")).toBeNull();
    expect(cell.textContent).not.toMatch(/1 hour after sending finished|At 1 hour/);
    expect(within(cell).getByTestId("campaign-meta").textContent).toBe("Newsletter · Oct 12");
  });

  it("each sent row shows its sender as a square logo, not a line of text; planned rows get a neutral tile", async () => {
    serve([
      row({ subject: "Via Mailchimp", route: "mailchimp", sent_with: "Mailchimp", card: { rail: "decisions", id: "m1", link: "" } }),
      row({ subject: "Via Zavi", route: "zavi_list", sent_with: "Zavi", card: { rail: "decisions", id: "z1", link: "" } }),
    ]);
    servePlan([plan({ angle: "Next week", status: "scheduled" })]);
    render(<SentEmailsBlock />);
    await screen.findByText("Next week");
    const rows = screen.getAllByTestId("row-sent");
    const logos = rows.map((r) => within(r).getByTestId("sender-logo"));
    expect(logos.map((l) => l.getAttribute("data-route"))).toEqual(["mailchimp", "zavi_list"]);
    expect(logos.map((l) => l.querySelector("img")?.getAttribute("src"))).toEqual(["/logos/mailchimp-icon.svg", "/zavi-icon.svg"]);
    expect(logos.map((l) => l.textContent)).toEqual(["Sent with Mailchimp", "Sent with Zavi"]);
    for (const r of rows) {
      const visible = Array.from(r.querySelectorAll("p")).map((p) => p.textContent);
      expect(visible).not.toContain("Mailchimp");
      expect(visible).not.toContain("Zavi");
    }
    expect(within(screen.getByTestId("row-scheduled")).getByTestId("plan-tile")).toBeTruthy();
  });

  it("a send still going says Sending; a stopped send shows how far it got", async () => {
    serve([
      row({ subject: "Going", stage: "sending", as_of: null, verdict: null, verdict_text: "Sending, 340 of 900 so far", people: { sent: 340, total: 900, stopped: false } }),
      row({ subject: "Stopped", people: { sent: 340, total: 900, stopped: true } }),
      row({ subject: "Held", stage: "paused", as_of: null, verdict: null, people: { sent: 120, total: 900, stopped: false } }),
    ]);
    render(<SentEmailsBlock />);
    await loaded();
    const tones = screen.getAllByTestId("status-pill").map((p) => [p.getAttribute("data-tone"), p.textContent]);
    expect(tones).toEqual([
      ["sending", "Sending"],
      ["sent", "Sent"],
      ["paused", "Paused"],
    ]);
    const paused = screen.getAllByTestId("status-pill")[2];
    expect(paused.className).toContain("text-marigoldDeep");
    expect(paused.className).not.toContain("#a96a0c");
    expect(paused.className).not.toContain("text-success");
    expect(screen.getByText("340 of 900")).toBeTruthy();
  });

  it("GA not connected: the filter row button starts the connection and the Site visits tile is gone", async () => {
    serveGa(false);
    serve([row({ visitors: cell(null, "Connect Google Analytics", "connect_ga") })]);
    render(<SentEmailsBlock />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Analytics" }));
    await waitFor(() => expect(ga.connect).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("stat-visits")).toBeNull();
  });

  it("empty and error states", async () => {
    serve([]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("sent-emails-empty");
    cleanup();
    serve([], 500);
    render(<SentEmailsBlock />);
    expect(await screen.findByText("Sent emails could not be loaded. Try again.")).toBeTruthy();
  });

  it("nothing sent but one planned: the table shows it instead of the empty line", async () => {
    serve([]);
    servePlan([plan({ angle: "First one" })]);
    render(<SentEmailsBlock />);
    expect(await screen.findByText("First one")).toBeTruthy();
    expect(screen.queryByTestId("sent-emails-empty")).toBeNull();
    expect(stat("stat-people")).toBe("–");
  });
});

describe("a missing number is only a dash", () => {
  it("row cells and stat cards show a bare dash with no reason text on screen; the reason stays for screen readers only", async () => {
    serve([
      row({
        subject: "Unread",
        people: { sent: 3, total: null, stopped: false },
        delivered: cell(null, "No delivery report from the sender yet"),
        opens: cell(null, "Not read yet"),
        clicks: cell(null, "Click tracking is off for Zavi's sender: see Visitors"),
        visitors: cell(null, "Due Oct 24"),
      }),
    ]);
    render(<SentEmailsBlock />);
    await loaded();
    const block = screen.getByTestId("email-performance");
    const visible = Array.from(block.querySelectorAll("*"))
      .filter((el) => el.children.length === 0 && !/(^|\s)sr-only(\s|$)/.test(el.getAttribute("class") ?? ""))
      .map((el) => el.textContent ?? "")
      .join(" ");
    for (const reason of ["No delivery report", "Not read yet", "Click tracking is off", "Due Oct 24", "Not reported"]) {
      expect(visible).not.toContain(reason);
    }
    for (const id of ["stat-open", "stat-click", "stat-visits", "stat-cto"]) {
      expect(stat(id)).toBe("–");
      expect(sub(id)).toBe("");
    }
    const missing = screen.getAllByTestId("missing");
    expect(missing).toHaveLength(3);
    for (const m of missing) {
      expect(m.querySelector('[aria-hidden="true"]')?.textContent).toBe("–");
      expect(m.querySelector(".sr-only")?.textContent?.length).toBeGreaterThan(0);
    }
    for (const el of screen.getAllByText("Click tracking is off for Zavi's sender: see Visitors")) expect(el.className).toContain("sr-only");
  });

  it("stat cards sit in one even grid: two columns on a phone, three in the drawer, five when wide, and a label can never stretch a card", async () => {
    serve([row()]);
    render(<SentEmailsBlock />);
    await loaded();
    const strip = screen.getByTestId("stat-strip");
    expect(strip.className).toMatch(/(^|\s)grid(\s|$)/);
    expect(strip.className).toContain("grid-cols-2");
    expect(strip.className).toContain("[@container(min-width:480px)]:grid-cols-3");
    expect(strip.className).toContain("[@container(min-width:840px)]:grid-cols-5");
    for (const card of Array.from(strip.children)) expect(card.className).toContain("min-w-0");
    expect(screen.getByTestId("stat-people-label").querySelector("span")?.className).toContain("truncate");
  });
});

describe("loading: each part as soon as its own data lands", () => {
  it("results with nothing sent wait for the plan read instead of flashing Nothing sent yet, then show the planned email", async () => {
    let release = () => {};
    holds["GET /api/workspace/email-plan"] = new Promise<void>((done) => {
      release = done;
    });
    serve([]);
    servePlan([plan({ angle: "First planned email" })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(calls).toContain("/api/email-results"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("sent-emails-empty")).toBeNull();
    expect(screen.getByTestId("sent-emails-loading")).toBeTruthy();
    release();
    expect(await screen.findByText("First planned email")).toBeTruthy();
    expect(screen.queryByTestId("sent-emails-empty")).toBeNull();
    expect(screen.queryByTestId("sent-emails-loading")).toBeNull();
  });

  it("sent results render while the plan read is still out, and the plan rows join later", async () => {
    let release = () => {};
    holds["GET /api/workspace/email-plan"] = new Promise<void>((done) => {
      release = done;
    });
    serve([row({ subject: "Already out" })]);
    servePlan([plan({ angle: "Next one" })]);
    render(<SentEmailsBlock />);
    expect(await screen.findByRole("link", { name: "Already out" })).toBeTruthy();
    expect(screen.queryByText("Next one")).toBeNull();
    release();
    expect(await screen.findByText("Next one")).toBeTruthy();
  });

  it("a plan read that fails still ends the wait: nothing sent shows the empty line with Try again", async () => {
    serve([]);
    servePlan([], 500);
    render(<SentEmailsBlock />);
    expect(await screen.findByTestId("sent-emails-empty")).toBeTruthy();
    expect(screen.queryByTestId("sent-emails-loading")).toBeNull();
    expect(screen.getByText(/Scheduled emails could not be loaded/)).toBeTruthy();
    servePlan([plan({ angle: "Back again" })]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Back again")).toBeTruthy();
  });

  it("the skeleton is light: outlined cards in the same grid as the strip, no filled blocks, no tabs or filter placeholders, three table rows", async () => {
    let release = () => {};
    holds["GET /api/email-results"] = new Promise<void>((done) => {
      release = done;
    });
    serve([row()]);
    render(<SentEmailsBlock />);
    const loading = await screen.findByTestId("sent-emails-loading");
    const cards = within(loading).getAllByTestId("sent-emails-loading-stat");
    const skeletonGrid = cards[0].parentElement!.className;
    for (const c of cards) {
      expect(c.className).toContain("border");
      expect(c.className).not.toMatch(/(^|\s)bg-/);
    }
    expect(within(loading).getAllByTestId("sent-emails-loading-row")).toHaveLength(3);
    expect(loading.querySelector('[role="group"]')).toBeNull();
    expect(Array.from(loading.querySelectorAll(".animate-pulse")).every((el) => (el.getAttribute("class") ?? "").includes("motion-reduce:animate-none"))).toBe(true);
    release();
    await loaded();
    expect(screen.getByTestId("stat-strip").className).toBe(skeletonGrid);
  });
});

describe("design details", () => {
  it("the date range is a custom select: native arrow off, room on the right, and a chevron that never takes clicks", async () => {
    serve([row()]);
    render(<SentEmailsBlock />);
    await loaded();
    const select = screen.getByLabelText("Date range") as HTMLSelectElement;
    const cls = select.className.split(/\s+/);
    expect(cls).toContain("appearance-none");
    expect(cls).toContain("pr-8");
    expect(cls.some((c) => /^px-/.test(c))).toBe(false);
    const chevron = screen.getByTestId("range-chevron");
    expect(chevron.tagName.toLowerCase()).toBe("svg");
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    const chevronCls = (chevron.getAttribute("class") ?? "").split(/\s+/);
    expect(chevronCls).toContain("pointer-events-none");
    expect(chevronCls).toContain("absolute");
    expect(chevron.parentElement).toBe(select.parentElement);
    expect(screen.getByTestId("range-select").className).toContain("relative");
    fireEvent.change(select, { target: { value: "30" } });
    expect(select.value).toBe("30");
  });
});

describe("plan rows say what they are", () => {
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

  it("only an approved email counts as Scheduled; planned, drafting and a Don't send draft are Drafts with their own pill", async () => {
    serve([row({ subject: "Launch week", finished_at: inDays(-2) })]);
    servePlan([
      plan({ angle: "Approved", status: "scheduled", planned_at: inDays(3) }),
      plan({ angle: "Not drafted", status: "planned", planned_at: inDays(4) }),
      plan({ angle: "Being drafted", status: "drafting", planned_at: inDays(1) }),
      plan({ angle: "Do not send", status: "ready", vetoed: true, planned_at: inDays(2), card: { rail: "channel_actions", id: "kept" } }),
      plan({ angle: "Vetoed and gone", status: "skipped", vetoed: true, planned_at: inDays(-1) }),
    ]);
    render(<SentEmailsBlock />);
    await screen.findByText("Not drafted");
    expect(screen.getByTestId("tab-count-all").textContent).toBe("5");
    expect(screen.getByTestId("tab-count-scheduled").textContent).toBe("1");
    expect(screen.getByTestId("tab-count-drafts").textContent).toBe("3");
    expect(screen.getAllByTestId("status-pill").map((p) => p.textContent)).toEqual(["Sent", "Scheduled", "Planned", "Drafting", "Draft"]);
    expect(within(screen.getByText("Not drafted").closest("tr") as HTMLElement).queryByText("Scheduled")).toBeNull();
    expect((screen.getByRole("link", { name: "Do not send" }) as HTMLAnchorElement).getAttribute("href")).toBe("/workspace/email-cards/channel_actions/kept");
    expect(screen.queryByText("Vetoed and gone")).toBeNull();
  });

  it("the date range counts plan rows too: an upcoming email is not in Last 7 days, one planned inside it is", async () => {
    serve([row({ subject: "Recent", finished_at: inDays(-2) }), row({ subject: "Old", finished_at: inDays(-20) })]);
    servePlan([
      plan({ angle: "Upcoming", status: "scheduled", planned_at: inDays(3) }),
      plan({ angle: "Inside the week", status: "ready", planned_at: inDays(-3), card: { rail: "channel_actions", id: "inside" } }),
      plan({ angle: "Before the week", status: "ready", planned_at: inDays(-9), card: { rail: "channel_actions", id: "before" } }),
    ]);
    render(<SentEmailsBlock />);
    await screen.findByText("Upcoming");
    expect(screen.getByTestId("tab-count-all").textContent).toBe("5");
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "7" } });
    expect(screen.getByTestId("tab-count-all").textContent).toBe("2");
    expect(screen.queryByText("Upcoming")).toBeNull();
    expect(screen.queryByText("Before the week")).toBeNull();
    expect(screen.getByText("Inside the week")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "30" } });
    expect(screen.getByTestId("tab-count-all").textContent).toBe("4");
  });
});

describe("no hover effects", () => {
  it("no element inside the block carries a hover: class, with every state on screen", async () => {
    serveGa(false);
    serve([row({ visitors: cell(null, "Connect Google Analytics", "connect_ga") }), row()]);
    servePlan([plan({ status: "scheduled" }), plan({ status: "ready", card: { rail: "channel_actions", id: "d" } })]);
    const { container } = render(<SentEmailsBlock />);
    await screen.findByTestId("row-draft");
    looksLikeButton(screen.getByRole("button", { name: "Connect Google Analytics" }));
    const hovered = Array.from(container.querySelectorAll("*")).filter((el) => el.tagName !== "BUTTON" && /(^|\s)(group-)?hover:/.test(el.getAttribute("class") ?? ""));
    expect(hovered).toEqual([]);
    cleanup();
    serve([], 500);
    const err = render(<SentEmailsBlock />);
    looksLikeButton(await screen.findByRole("button", { name: "Retry" }));
    expect(Array.from(err.container.querySelectorAll("*")).filter((el) => el.tagName !== "BUTTON" && /hover:/.test(el.getAttribute("class") ?? ""))).toEqual([]);
  });
});

describe("wiring", () => {
  it("the email channel's overview panel id mounts the new block", async () => {
    serve([]);
    render(<ChannelOverviewPanels panels={["email_sent_emails"]} />);
    expect(await screen.findByText("How your emails are doing")).toBeTruthy();
    expect(screen.getByTestId("email-performance")).toBeTruthy();
  });

  it("only email and Pinterest hide the generic account snapshot; every other channel keeps it", () => {
    expect(showsAccountSnapshot(platformFor("email_marketing"))).toBe(false);
    expect(showsAccountSnapshot(platformFor("reddit_organic"))).toBe(true);
    expect(showsAccountSnapshot(platformFor("not_a_channel"))).toBe(true);
    const hidden = Object.entries(PLATFORMS).filter(([, p]) => !showsAccountSnapshot(p)).map(([slug]) => slug);
    expect(hidden.sort()).toEqual(["email_marketing", "pinterest_organic"]);
  });
});

describe("switching tabs or pages does not replay an entrance", () => {
  it("the table box keeps its tallest height across pages of one tab, and fits a tab with fewer rows instead of leaving empty space under it", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === "campaign-table-box" ? 40 * this.querySelectorAll("tbody tr").length : 0;
      },
    });
    try {
      serve(Array.from({ length: 12 }, (_, i) => row({ subject: `Send ${i + 1}`, finished_at: daysAgo(i + 1) })));
      servePlan([
        plan({ angle: "Holiday hours", status: "scheduled", planned_at: "2026-10-28T16:00:00Z" }),
        plan({ angle: "Win back lapsed", status: "ready", card: { rail: "channel_actions", id: "draft-1" } }),
      ]);
      render(<SentEmailsBlock />);
      await screen.findByRole("link", { name: "Send 1" });
      const box = screen.getByTestId("campaign-table-box");
      expect(box.style.minHeight).toBe("400px");

      fireEvent.click(screen.getByRole("button", { name: "All 14" }));
      fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
      expect(box.querySelectorAll("tbody tr")).toHaveLength(4);
      expect(box.style.minHeight).toBe("400px");

      fireEvent.click(screen.getByRole("button", { name: "Scheduled 1" }));
      expect(box.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(box.style.minHeight).toBe("");

      fireEvent.click(screen.getByRole("button", { name: "Sent 12" }));
      expect(box.querySelectorAll("tbody tr")).toHaveLength(10);
      fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
      expect(box.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(box.style.minHeight).toBe("400px");

      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "7" } });
      expect(box.style.minHeight).not.toBe("400px");
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    }
  });

  it("rows that stay on screen keep their DOM node and nothing in the table animates in again", async () => {
    serve(Array.from({ length: 12 }, (_, i) => row({ subject: `Send ${i + 1}`, finished_at: daysAgo(i + 1) })));
    servePlan([
      plan({ angle: "Holiday hours", status: "scheduled", planned_at: "2026-10-28T16:00:00Z" }),
      plan({ angle: "Win back lapsed", status: "ready", card: { rail: "channel_actions", id: "draft-1" } }),
    ]);
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    const box = screen.getByTestId("campaign-table-box");
    const body = box.querySelector("tbody") as HTMLElement;
    const first = screen.getByRole("link", { name: "Send 1" }).closest("tr");
    const animated = () => Array.from(box.querySelectorAll("tbody, tbody *")).filter((el) => /\banimate-/.test(el.getAttribute("class") ?? ""));
    expect(animated()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Sent 12" }));
    expect(box.querySelector("tbody")).toBe(body);
    expect(screen.getByRole("link", { name: "Send 1" }).closest("tr")).toBe(first);
    expect(animated()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    expect(box.querySelector("tbody")).toBe(body);
    expect(animated()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Scheduled 1" }));
    expect(box.querySelector("tbody")).toBe(body);
    expect(animated()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "All 14" }));
    expect(box.querySelector("tbody")).toBe(body);
    expect(animated()).toEqual([]);
  });
});

describe("a send that lands after Approve", () => {
  const sentReads = () => calls.filter((u) => u === "/api/email-results").length;
  const before = sentFollowUps.ms;
  const history = vi.fn();
  beforeEach(() => {
    sentFollowUps.ms = [60];
    history.mockClear();
    window.addEventListener(CHANNEL_HISTORY_CHANGED_EVENT, history);
  });
  afterEach(() => {
    sentFollowUps.ms = before;
    window.removeEventListener(CHANNEL_HISTORY_CHANGED_EVENT, history);
  });

  it("the new row and the Done list update with no reload, even when the read right after Approve still misses the send", async () => {
    serve([row({ subject: "Earlier send" })]);
    render(<SentEmailsBlock />);
    await screen.findByText("Earlier send");
    const reads = sentReads();
    announceEmailCardChanged({ rail: "channel_actions", id: "card-new", source: "test" });
    await waitFor(() => expect(sentReads()).toBeGreaterThan(reads));
    expect(screen.queryAllByText("Diwali offer")).toHaveLength(0);
    history.mockClear();
    serve([row({ subject: "Diwali offer" }), row({ subject: "Earlier send" })]);
    expect((await screen.findAllByText("Diwali offer")).length).toBeGreaterThan(0);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("leaving the page cancels the waiting reads and tells nobody to refresh", async () => {
    serve([row({ subject: "Earlier send" })]);
    const { unmount } = render(<SentEmailsBlock />);
    await screen.findByText("Earlier send");
    announceEmailCardChanged({ rail: "channel_actions", id: "card-new", source: "test" });
    unmount();
    history.mockClear();
    await new Promise((r) => setTimeout(r, 120));
    expect(history).not.toHaveBeenCalled();
  });
});

describe("the first hour after a send", () => {
  const WAIT = "First numbers around 3:45 PM";
  const waiting = (over: Partial<SentEmail> = {}) =>
    row({ stage: "h1_due", as_of: null, delivery: "unconfirmed", people: { sent: null, total: 40, stopped: false }, delivered: cell(null, WAIT), opens: cell(null, WAIT), clicks: cell(null, WAIT), unsubscribes: cell(null, WAIT), visitors: cell(null, "Due Oct 28"), finished_at: daysAgo(0), started_at: daysAgo(0), ...over });

  it("each tile and the row say when numbers arrive, and no cell claims the sender did not report", async () => {
    serve([waiting(), waiting()]);
    render(<SentEmailsBlock />);
    const tiles = await screen.findByTestId("stat-strip");
    for (const id of ["stat-people", "stat-open", "stat-click", "stat-cto"]) {
      expect(within(tiles).getByTestId(`${id}-value`).textContent).toBe("–");
      expect(within(tiles).getByTestId(`${id}-sub`).textContent).toBe(WAIT);
    }
    expect(within(tiles).getByTestId("stat-visits-sub").textContent).toBe("");
    expect(screen.getAllByTestId("first-numbers").map((p) => p.textContent)).toEqual([WAIT, WAIT]);
    const page = screen.getByTestId("email-performance");
    expect(page.textContent).not.toContain("Not reported by the sender");
    const hovers = Array.from(page.querySelectorAll('[data-testid="missing"]')).map((m) => m.getAttribute("title"));
    expect(hovers).toContain(WAIT);
    expect(hovers).not.toContain("Not reported by the sender");
  });

  it("a campaign with real numbers keeps its tile values, and its row has no wait line", async () => {
    serve([waiting(), row()]);
    render(<SentEmailsBlock />);
    expect((await screen.findByTestId("stat-people-value")).textContent).toBe("200");
    expect(screen.getByTestId("stat-people-sub").textContent).toBe("1 of 2 campaigns");
    expect(screen.getAllByTestId("first-numbers")).toHaveLength(1);
  });

  it("unticking the only waiting campaign drops the wait line from the tiles", async () => {
    const w = waiting({ subject: "Waiting one" });
    serve([w, waiting({ subject: "Other", stage: "h1", delivered: cell(null, "SendGrid does not report this"), opens: cell(null, "SendGrid does not report this"), clicks: cell(null, "SendGrid does not report this"), unsubscribes: cell(null, null) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.getByTestId("stat-open-sub").textContent).toBe(WAIT);
    fireEvent.click(within(screen.getByTestId("campaign-filter")).getAllByRole("checkbox")[1]);
    expect(screen.getByTestId("stat-open-sub").textContent).toBe("");
  });

  it("after the first hour a SendGrid row with no count still says the sender did not report", async () => {
    serve([row({ stage: "h1", people: { sent: null, total: 40, stopped: false }, delivered: cell(null, "SendGrid does not report this") })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.queryByTestId("first-numbers")).toBeNull();
  });
});

describe("date ranges and the campaign filter", () => {
  const useRange = (v: string) => fireEvent.change(screen.getByLabelText("Date range"), { target: { value: v } });

  it("a campaign unticked in All time can be ticked back in a range that holds only it", async () => {
    serve([row({ subject: "Recent", finished_at: daysAgo(1) }), row({ subject: "Old", finished_at: daysAgo(20) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    fireEvent.click(within(screen.getByTestId("campaign-filter")).getAllByRole("checkbox")[1]);
    useRange("7");
    expect(screen.getByTestId("stat-people-value").textContent).toBe("–");
    const picker = within(screen.getByTestId("campaign-filter"));
    expect(picker.getByText("0 of 1 sent campaigns")).toBeTruthy();
    fireEvent.click(picker.getAllByRole("checkbox")[1]);
    expect(screen.getByTestId("stat-people-value").textContent).toBe("200");
  });

  it("one sent campaign, nothing unticked: no picker", async () => {
    serve([row()]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.queryByTestId("campaign-filter")).toBeNull();
  });

  it("a range with nothing in it says so instead of showing an empty table, and a wider range brings the table back", async () => {
    serve([row({ finished_at: daysAgo(20) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    useRange("7");
    expect(screen.getByTestId("sent-emails-range-empty").textContent).toBe("Nothing sent in this date range.");
    expect(screen.queryByTestId("campaign-table-box")).toBeNull();
    expect(screen.queryByTestId("sent-emails-empty")).toBeNull();
    useRange("30");
    expect(screen.queryByTestId("sent-emails-range-empty")).toBeNull();
    expect(screen.getByTestId("campaign-table-box")).toBeTruthy();
  });

  it("a planned email in the range is enough to show the table", async () => {
    serve([row({ finished_at: daysAgo(20) })]);
    servePlan([plan({ status: "scheduled", planned_at: new Date(Date.now() - 86_400_000).toISOString() })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("row-scheduled");
    useRange("7");
    expect(screen.queryByTestId("sent-emails-range-empty")).toBeNull();
  });
});

describe("sizes and colours", () => {
  it("the status pill stays on the type scale", async () => {
    serve([row({ stage: "paused" })]);
    render(<SentEmailsBlock />);
    const pill = await screen.findByTestId("status-pill");
    expect(pill.className).toContain("text-[11px]");
    expect(pill.className).not.toContain("11.5px");
  });
});

describe("Compare results table and tiles stay free of repeats", () => {
  it("Connect Google Analytics appears once, in the filter row, and no row carries it", async () => {
    serveGa(false);
    const gaCell = () => cell(null, "Connect Google Analytics", "connect_ga");
    serve([row({ subject: "One", visitors: gaCell() }), row({ subject: "Two", visitors: gaCell() }), row({ subject: "Three", visitors: gaCell() })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    const buttons = screen.getAllByRole("button", { name: "Connect Google Analytics" });
    expect(buttons).toHaveLength(1);
    expect(screen.getByTestId("sent-emails-actions").contains(buttons[0])).toBe(true);
    for (const tr of screen.getAllByTestId("row-sent")) {
      expect(within(tr).queryByRole("button", { name: "Connect Google Analytics" })).toBeNull();
      expect(tr.querySelectorAll("td")).toHaveLength(5);
    }
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(ga.connect).toHaveBeenCalledTimes(1));
  });

  it("no Connect button when visits are known or the reason is not a connection", async () => {
    serve([row({ visitors: cell(5) }), row({ visitors: cell(null, "GA had no data") })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.queryByRole("button", { name: "Connect Google Analytics" })).toBeNull();
  });

  it("no Total row, in a table of any size", async () => {
    serve([row({ subject: "A" }), row({ subject: "B" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.queryByTestId("totals-row")).toBeNull();
    expect(screen.queryByTestId("total-people")).toBeNull();
    expect(document.querySelector("tfoot")).toBeNull();
    expect(within(screen.getByTestId("campaign-table-box")).queryByText("Total")).toBeNull();
  });

  it("stat tiles carry no icon and Click-to-open has no clicks ÷ opens note", async () => {
    serve([row(), row({ subject: "Other" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    for (const id of ["stat-people", "stat-open", "stat-click", "stat-visits", "stat-cto"]) {
      expect(screen.getByTestId(id).querySelector("svg")).toBeNull();
      expect(screen.queryByTestId(`${id}-icon`)).toBeNull();
    }
    expect(stat("stat-cto")).toBe("20.0%");
    expect(sub("stat-cto")).toBe("");
    expect(screen.getByTestId("stat-strip").textContent).not.toContain("÷");
  });

  describe.each(["mailchimp", "klaviyo", "sendgrid", "zavi_list"] as const)("unsubscribes under a %s campaign", (route) => {
    it("1 shows a muted line in the campaign cell; 0 and null add nothing; no column is added", async () => {
      serve([row({ route, subject: "One", unsubscribes: cell(1) }), row({ route, subject: "Zero", unsubscribes: cell(0) }), row({ route, subject: "Unknown", unsubscribes: cell(null, "Not read yet") })]);
      render(<SentEmailsBlock />);
      await loaded();
      const [one, zero, unknown] = screen.getAllByTestId("row-sent");
      const line = within(one).getByTestId("campaign-unsubscribed");
      expect(line.textContent).toBe("1 unsubscribed");
      expect(line.className).toBe(within(one).getByTestId("campaign-meta").className);
      expect(line.closest("td")).toBe(within(one).getByTestId("campaign-meta").closest("td"));
      expect(within(zero).queryByTestId("campaign-unsubscribed")).toBeNull();
      expect(within(unknown).queryByTestId("campaign-unsubscribed")).toBeNull();
      expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Unsubscribes");
    });
  });

  it("the cell's reason stays with the number: the Zavi note and the carried 1-hour note", async () => {
    const note = "Someone on two of your sends that week counts on both";
    const carried = "From the 1-hour check: day 7 could not be read";
    serve([row({ route: "zavi_list", unsubscribes: cell(1200, note) }), row({ route: "klaviyo", unsubscribes: cell(2, carried) })]);
    render(<SentEmailsBlock />);
    await loaded();
    const [zavi, klaviyo] = screen.getAllByTestId("campaign-unsubscribed");
    expect(zavi.textContent).toBe(`1,200 unsubscribed (${note})`);
    expect(zavi.getAttribute("title")).toBe(note);
    expect(klaviyo.getAttribute("title")).toBe(carried);
  });

  it("the block uses no off-scale 11.5 or 12.5 px text and no raw hex amber", async () => {
    serve([row({ stage: "paused", subject: "Held" }), row()]);
    servePlan([plan({ status: "scheduled" })]);
    const { container } = render(<SentEmailsBlock />);
    await screen.findByTestId("row-scheduled");
    const html = container.innerHTML;
    expect(html).not.toMatch(/\[1[12]\.5px\]/);
    expect(html).not.toContain("#a96a0c");
  });
});
