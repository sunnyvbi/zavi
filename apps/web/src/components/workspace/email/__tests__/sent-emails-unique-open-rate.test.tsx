// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    const r = routes[`GET ${url}`] ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("@/app/connectors/GoogleAnalyticsConnectButton", () => ({ startGoogleAnalyticsConnect: vi.fn(async () => undefined) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { SentEmailsBlock, totals } from "../SentEmailsBlock";
import type { SentEmail } from "@/lib/workspace/emailResultsApi";

const cell = (value: number | null, why: string | null = null) => ({ value, why });
let seq = 0;
const row = (over: Partial<SentEmail> = {}): SentEmail => {
  seq += 1;
  return {
    card: { rail: "channel_actions", id: `card-${seq}`, link: "" },
    route: "mailchimp",
    sent_with: "Mailchimp",
    subject: `Email ${seq}`,
    list_name: "Newsletter",
    started_at: "2026-10-12T15:00:00Z",
    finished_at: "2026-10-12T15:00:00Z",
    spanned: false,
    stage: "d7",
    people: { sent: 100, total: null, stopped: false },
    as_of: "d7",
    delivered: cell(100),
    opens: cell(40),
    opens_label: "Opens",
    opens_unique: true,
    clicks: cell(8),
    unsubscribes: cell(0),
    visitors: cell(5),
    win_line: { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, basis: "median" },
    verdict: "beat",
    verdict_text: "Beat the win line",
    d7_due_at: null,
    note: null,
    ...over,
  };
};

const zavi = (over: Partial<SentEmail> = {}) =>
  row({
    card: { rail: "decisions", id: `z-${(seq += 1)}`, link: "" },
    route: "zavi_list",
    sent_with: "Zavi",
    subject: "Zavi list send",
    people: { sent: 10, total: null, stopped: false },
    delivered: cell(10),
    opens: cell(25),
    opens_label: "Opens (all)",
    opens_unique: false,
    clicks: cell(null, "Click tracking is off for Zavi's sender: see Visitors"),
    ...over,
  });

const serve = (emails: SentEmail[]) => {
  routes["GET /api/email-results"] = { status: 200, body: { emails, more: false } };
};
const stat = (id: string) => screen.getByTestId(`${id}-value`).textContent;
const sub = (id: string) => screen.getByTestId(`${id}-sub`).textContent;
const rowOf = (subject: string) => screen.getByRole("link", { name: subject }).closest("tr") as HTMLElement;
const openCell = (subject: string) => rowOf(subject).querySelectorAll("td")[3] as HTMLElement;
const percents = (text: string) => [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
const openSurfaces = () => [
  screen.getByTestId("stat-open-value"),
  screen.getByTestId("stat-cto-value"),
  ...screen.getAllByTestId("row-sent").map((tr) => tr.querySelectorAll("td")[3] as HTMLElement),
  ...(screen.queryByTestId("campaign-filter") ? within(screen.getByTestId("campaign-filter")).getAllByRole("checkbox", { hidden: true }).map((c) => c.closest("label") as HTMLElement) : []),
];
const openPercents = () => openSurfaces().flatMap((el) => percents(el.textContent ?? ""));

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-plan"] = {
    status: 200,
    body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: null, items: [], holds: [], released: [] },
  };
});
afterEach(cleanup);

describe("Open rate on Compare results: Zavi's all-opens never become a rate", () => {
  it("10 delivered and 25 human opens from 4 people next to a Mailchimp send: the row shows the count as Opens (all), the overall Open rate is Mailchimp's unique rate alone", async () => {
    serve([zavi(), row({ subject: "Mailchimp send" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");

    const zCell = openCell("Zavi list send");
    expect(zCell.textContent).not.toMatch(/%/);
    expect(within(zCell).getByTestId("opens-all").textContent).toMatch(/^25 Opens \(all\)/);
    expect(within(zCell).queryByTestId("open-bar")).toBeNull();
    expect(openCell("Mailchimp send").textContent).toBe("40.0%");

    expect(stat("stat-open")).toBe("40.0%");
    expect(sub("stat-open")).toBe("40 opens");
    expect(stat("stat-cto")).toBe("20.0%");

    const filter = screen.getByTestId("campaign-filter");
    expect(within(filter).getByText("25 Opens (all)")).toBeTruthy();

    expect(screen.getByTestId("email-performance").textContent).not.toMatch(/250\.0%|59\.1%|65 opens/);
    expect(openPercents().sort()).toEqual([20, 40, 40, 40].sort());
    for (const bar of screen.queryAllByTestId("open-bar")) expect(parseFloat((bar as HTMLElement).style.width)).toBeLessThanOrEqual(100);
  });

  it("an older payload with no opens_unique still treats a Zavi-list row as all-opens", async () => {
    const z = zavi({ subject: "Old payload send" });
    delete (z as Partial<SentEmail>).opens_unique;
    serve([z, row({ subject: "Mailchimp send" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(openCell("Old payload send").textContent).not.toMatch(/%/);
    expect(stat("stat-open")).toBe("40.0%");
  });

  it("only Zavi-list sends: no Open rate at all", async () => {
    serve([zavi(), zavi({ subject: "Second Zavi send", opens: cell(31) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(stat("stat-open")).toBe("–");
    expect(stat("stat-cto")).toBe("–");
    expect(openPercents()).toEqual([]);
  });

  it("a tool reporting more opens than delivered is held at 100% on the row, the bar and the overall rate", async () => {
    serve([row({ subject: "Klaviyo send", route: "klaviyo", sent_with: "Klaviyo", delivered: cell(10), opens: cell(12), clicks: cell(1) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(openCell("Klaviyo send").textContent).toBe("100.0%");
    expect(stat("stat-open")).toBe("100.0%");
    expect(openPercents().filter((p) => p > 100)).toEqual([]);
    for (const bar of screen.getAllByTestId("open-bar")) expect((bar as HTMLElement).style.width).toBe("100%");
  });

  it("totals: the Zavi row is out of the open rate on both sides and out of the opens count under it", () => {
    const t = totals([zavi(), row()]);
    expect(t.openRate).toBe(0.4);
    expect(t.opens).toBe(40);
    expect(t.clickToOpen).toBe(0.2);
    expect(totals([zavi()]).openRate).toBeNull();
    expect(totals([row({ delivered: cell(10), opens: cell(30) })]).openRate).toBe(1);
  });
});

describe("tile subtitles pluralise by count", () => {
  const cases: Array<[number, number, string, string]> = [
    [1, 1, "1 open", "1 click"],
    [0, 0, "0 opens", "0 clicks"],
    [2, 2, "2 opens", "2 clicks"],
  ];
  for (const [o, c, openSub, clickSub] of cases) {
    it(`${o} opens and ${c} clicks read "${openSub}" and "${clickSub}"`, async () => {
      serve([row({ delivered: cell(100), opens: cell(o), clicks: cell(c) })]);
      render(<SentEmailsBlock />);
      await screen.findByTestId("stat-strip");
      expect(sub("stat-open")).toBe(openSub);
      expect(sub("stat-click")).toBe(clickSub);
    });
  }
});

describe("People emailed counts only campaigns with numbers; snapshot line states the timing", () => {
  const waitingRow = (subject: string) => row({ subject, people: { sent: null, total: null, stopped: false }, as_of: null, stage: "h1_due", delivered: cell(null, "Waiting"), opens: cell(null), clicks: cell(null) });
  it("2 of 3 campaigns when one has no numbers yet, 3 campaigns when all do", async () => {
    serve([row({ subject: "A" }), row({ subject: "B" }), waitingRow("C")]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(sub("stat-people")).toBe("2 of 3 campaigns");
    cleanup();
    serve([row({ subject: "A" }), row({ subject: "B" }), row({ subject: "C" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(sub("stat-people")).toBe("3 campaigns");
  });
  it("snapshot line per stage, mixed, and hidden with no numbers", async () => {
    serve([row({ subject: "A", as_of: "h1", stage: "h1" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.getByTestId("snapshot-line").textContent).toBe("Numbers are from 1 hour after each send. Next update at day 7.");
    cleanup();
    serve([row({ subject: "A", as_of: "d7" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.getByTestId("snapshot-line").textContent).toBe("Numbers are from 7 days after each send.");
    cleanup();
    serve([row({ subject: "A", as_of: "d7" }), row({ subject: "B", as_of: "h1", stage: "h1" })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.getByTestId("snapshot-line").textContent).toBe("Numbers are from 1 hour or 7 days after each send. The 1-hour ones update at day 7.");
    cleanup();
    serve([waitingRow("W")]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(screen.queryByTestId("snapshot-line")).toBeNull();
  });
});
