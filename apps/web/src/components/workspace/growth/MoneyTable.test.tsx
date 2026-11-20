// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const calls: string[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string) => {
    calls.push(path);
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as unknown as Response;
  },
}));

import { AD_BUDGET_CHANGED_EVENT } from "./adBudgetEvents";
import { MoneyTable, changeLabel, countLabel, resultsDays, usd, type MoneyTableData } from "./MoneyTable";

const upcarOctober: MoneyTableData = {
  month_start: "2026-10-01",
  today: "2026-10-31",
  spend_through: "2026-10-31",
  rows: [
    { platform: "meta", name: "Meta Ads", spent_usd: 22313.56, share: 0.787, last7_usd: 5858.88, prev7_usd: 5363.17, change: 0.092, results_status: "platform", results: { count: 169, label: "purchases", cost_each_usd: 121.07, source: "Meta's own count", from: "2026-09-29", to: "2026-10-28", settling: true }, spend_read_failed: false },
    { platform: "google", name: "Google Ads", spent_usd: 5066.34, share: 0.179, last7_usd: 1594.76, prev7_usd: 1232.02, change: 0.294, results_status: "platform", results: { count: 115.96, label: "conversions", cost_each_usd: 39.85, source: "Google's own count", from: "2026-09-29", to: "2026-10-28", settling: true }, spend_read_failed: false },
    { platform: "reddit", name: "Reddit Ads", spent_usd: 877.4, share: 0.031, last7_usd: 297.63, prev7_usd: 186.19, change: 0.599, results_status: "not_synced", results: null, spend_read_failed: false },
    { platform: "tiktok", name: "TikTok Ads", spent_usd: 50, share: 0.002, last7_usd: 0, prev7_usd: 0, change: null, results_status: "not_synced", results: null, spend_read_failed: false },
    { platform: "chatgpt", name: "ChatGPT Ads", spent_usd: 40.18, share: 0.001, last7_usd: 0, prev7_usd: 0, change: null, results_status: "not_synced", results: null, spend_read_failed: false },
    { platform: "linkedin", name: "LinkedIn Ads", spent_usd: 0, share: 0, last7_usd: 0, prev7_usd: 0, change: null, results_status: "not_synced", results: null, spend_read_failed: false },
  ],
  total: { spent_usd: 28347.48, last7_usd: 7751.27, prev7_usd: 6781.38, change: 0.143 },
  budget: { status: "active", month_cap_usd: 28400, monthly_usd: 28400, spent_usd: 28347.48 },
  results_read_at: "2026-10-30T06:15:05.630Z",
};

beforeEach(() => {
  calls.length = 0;
  reply = { status: 200, body: upcarOctober };
});
afterEach(cleanup);

describe("MoneyTable", () => {
  it("shows each channel's spend, share, 7-day change, results and cost each, and the total against the budget", async () => {
    render(<MoneyTable />);
    const table = await screen.findByTestId("money-table");
    expect(calls).toEqual(["/api/workspace/ad-budget/channels"]);
    expect(within(table).getByText("Where your ad money goes")).toBeTruthy();
    expect(within(table).getByText("October so far")).toBeTruthy();
    expect(screen.getByTestId("money-table-summary").textContent).toBe("$28,347.48 spent · budget: $28,347.48 of $28,400.00 used · last 7 days $7,751.27, +14% on the week before");

    const meta = screen.getByTestId("money-row-meta");
    expect(meta.textContent).toContain("Meta Ads");
    expect(meta.textContent).toContain("$22,313.56");
    expect(meta.textContent).toContain("79%");
    expect(meta.textContent).toContain("+9%");
    expect(meta.textContent).toContain("169 purchases");
    expect(meta.textContent).toContain("Meta's own count");
    expect(meta.textContent).toContain("$121.07");

    const google = screen.getByTestId("money-row-google");
    expect(google.textContent).toContain("115.96 conversions");
    expect(google.textContent).toContain("Google's own count");
    expect(google.textContent).toContain("$39.85");

    for (const p of ["reddit", "tiktok", "chatgpt", "linkedin"]) {
      expect(screen.getByTestId(`money-row-${p}`).textContent).toContain("not synced yet");
    }
    expect(screen.getByTestId("money-row-reddit").textContent).toContain("$877.40");
    expect(screen.getByTestId("money-row-chatgpt").textContent).toContain("$40.18");

    const total = screen.getByTestId("money-row-total");
    expect(total.textContent).toContain("$28,347.48");
    expect(screen.getByTestId("money-budget-line").textContent).toBe("budget $28,347.48 of $28,400.00");
    expect(table.textContent).toContain("Results are each platform's own count, not your bookings, for Sep 29 to Oct 28.");
    expect(table.textContent).toContain("The newest days are still settling, so those counts may rise.");
  });

  it("compares the budget with its own count, and says when there is no budget", async () => {
    reply = { status: 200, body: { ...upcarOctober, budget: { ...upcarOctober.budget!, spent_usd: 20000 } } };
    render(<MoneyTable />);
    expect((await screen.findByTestId("money-budget-line")).textContent).toBe("budget $20,000.00 of $28,400.00");
    expect(screen.getByTestId("money-table-summary").textContent).toContain("budget: $20,000.00 of $28,400.00 used");
    cleanup();
    reply = { status: 200, body: { ...upcarOctober, budget: null } };
    render(<MoneyTable />);
    expect((await screen.findByTestId("money-table-summary")).textContent).toContain("spent · no monthly ad budget set");
    expect(screen.getByTestId("money-row-total").textContent).toContain("no budget set");
  });

  it("renders nothing for a company with no ad spend and no budget", async () => {
    reply = { status: 200, body: { ...upcarOctober, rows: [], total: { spent_usd: 0, last7_usd: 0, prev7_usd: 0, change: null }, budget: null } };
    const { container } = render(<MoneyTable />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.innerHTML).toBe("");
  });

  it("on the CGO page (alwaysShow) keeps the section with an empty line instead of hiding", async () => {
    reply = { status: 200, body: { ...upcarOctober, rows: [], total: { spent_usd: 0, last7_usd: 0, prev7_usd: 0, change: null }, budget: null } };
    render(<MoneyTable alwaysShow />);
    const section = await screen.findByTestId("money-table-none");
    expect(section.textContent).toContain("Where your ad money goes");
    expect(section.textContent).toContain("No ad spend this month.");
  });

  it("with a budget but no spend read yet, says so instead of hiding", async () => {
    reply = { status: 200, body: { ...upcarOctober, rows: [], total: { spent_usd: 0, last7_usd: 0, prev7_usd: 0, change: null } } };
    render(<MoneyTable />);
    expect((await screen.findByTestId("money-table-empty")).textContent).toContain("No ad spend read yet this month, against a $28,400.00 budget.");
  });

  it("keeps the last numbers on a failed re-read but says they may be out of date", async () => {
    render(<MoneyTable />);
    await screen.findByTestId("money-table");
    reply = { status: 503, body: {} };
    await act(async () => {
      window.dispatchEvent(new Event(AD_BUDGET_CHANGED_EVENT));
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't refresh. These numbers may be out of date.");
    expect(screen.getByTestId("money-table")).toBeTruthy();
  });

  it("a platform whose spend read failed shows no 7-day change and says why", async () => {
    const rows = upcarOctober.rows.map((r) => (r.platform === "google" ? { ...r, change: null, spend_read_failed: true } : r));
    reply = { status: 200, body: { ...upcarOctober, rows, total: { ...upcarOctober.total, change: null } } };
    render(<MoneyTable />);
    expect((await screen.findByTestId("money-row-google")).textContent).toContain("couldn't read");
    expect(screen.getByTestId("money-table").textContent).toContain("Some spend could not be read on the last check");
  });

  it("a failed Meta/Google results read says it could not be read", async () => {
    const rows = upcarOctober.rows.map((r) => (r.platform === "meta" ? { ...r, results: null, results_status: "read_failed" as const } : r));
    reply = { status: 200, body: { ...upcarOctober, rows } };
    render(<MoneyTable />);
    expect((await screen.findByTestId("money-row-meta")).textContent).toContain("couldn't read");
    expect(screen.getByTestId("money-table").textContent).toContain("Meta or Google results could not be read just now.");
  });

  it("says so when the read fails, and Try again re-reads", async () => {
    reply = { status: 503, body: { error: { code: "ad_spend_unavailable" } } };
    render(<MoneyTable />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load where your ad money goes.");
    reply = { status: 200, body: upcarOctober };
    fireEvent.click(within(alert).getByText("Try again"));
    await screen.findByTestId("money-table");
  });

  it("re-reads after the ad budget is set up, edited or stopped", async () => {
    render(<MoneyTable />);
    await screen.findByTestId("money-table");
    reply = { status: 200, body: { ...upcarOctober, budget: { ...upcarOctober.budget!, month_cap_usd: 30000 } } };
    await act(async () => {
      window.dispatchEvent(new Event(AD_BUDGET_CHANGED_EVENT));
    });
    await waitFor(() => expect(screen.getByTestId("money-budget-line").textContent).toContain("of $30,000.00"));
    expect(calls.length).toBe(2);
  });
});

describe("resultsDays", () => {
  it("shares one range when they match and names each platform's own when they do not", () => {
    expect(resultsDays(upcarOctober.rows)).toBe("Sep 29 to Oct 28");
    const rows = upcarOctober.rows.map((r) => (r.platform === "google" && r.results ? { ...r, results: { ...r.results, from: "2026-10-01", to: "2026-10-30" } } : r));
    expect(resultsDays(rows)).toBe("Meta Sep 29 to Oct 28, Google Oct 1 to Oct 30");
    expect(resultsDays([])).toBeNull();
  });
});

describe("format helpers", () => {
  it("formats money and the 7-day change", () => {
    expect(usd(22313.56)).toBe("$22,313.56");
    expect(usd(40.18)).toBe("$40.18");
    expect(usd(50)).toBe("$50.00");
    expect(countLabel(115.96)).toBe("115.96");
    expect(countLabel(169)).toBe("169");
    expect(changeLabel(0.092, 1)).toBe("+9%");
    expect(changeLabel(-0.5, 1)).toBe("-50%");
    expect(changeLabel(null, 10)).toBe("new");
    expect(changeLabel(null, 0)).toBe("—");
  });
});
