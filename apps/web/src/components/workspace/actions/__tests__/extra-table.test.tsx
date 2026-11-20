// @vitest-environment jsdom

import { useEffect } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtraTable, type ExtraTableData } from "../ExtraTable";
import { extraTableData, gadsCampaignTable } from "../../agent/legacyChannelActions";
import type { GadsPayload } from "../../agent/google-ads/types";

afterEach(cleanup);

const TABLE: ExtraTableData = {
  title: "Made-up performance",
  columns: [{ label: "Thing", align: "left" }, { label: "State", align: "left" }, { label: "Spend" }, { label: "Return" }],
  rows: [
    {
      id: "r1",
      cells: [
        { text: "The good one", href: "https://example.com/r1" },
        { text: "Enabled", chip: "good" },
        { text: "$1,640", strong: true },
        { text: "5.8×", tone: "good" },
      ],
    },
    {
      id: "r2",
      cells: [
        { text: "The bad one", href: null },
        { text: "Limited", chip: "warn", title: "Limited by budget" },
        { text: "$968", strong: true },
        { text: "1.4×", tone: "bad" },
      ],
    },
    {
      id: "r3",
      cells: [
        { text: "The stopped one" },
        { text: "Paused", chip: "muted" },
        { text: "$0", tone: "dim" },
        { text: "—", tone: "dim" },
      ],
    },
  ],
  footer: [{ text: "3 things" }, { text: "ROAS 4.52×", tone: "dim" }, { text: "$2,608" }, { text: "" }],
  empty: "Nothing ran in this period.",
  caption: "Numbers as reported by nobody.",
};

const row = (id: string) => screen.getByText(TABLE.rows.find((r) => r.id === id)!.cells[0].text).closest("tr")!;

it("prints the tone it was handed, and never decides one", () => {
  render(<ExtraTable data={TABLE} />);
  const cells = (id: string) => within(row(id)).getAllByRole("cell");

  expect(cells("r1")[3].getAttribute("data-tone")).toBe("good");
  expect(cells("r1")[3].className).toContain("text-success");
  expect(cells("r2")[3].getAttribute("data-tone")).toBe("bad");
  expect(cells("r2")[3].className).toContain("text-danger");
  expect(cells("r3")[3].getAttribute("data-tone")).toBe("dim");
  expect(cells("r3")[3].className).toContain("text-inkMuted");

  expect(cells("r1")[2].getAttribute("data-tone")).toBeNull();
  expect(cells("r1")[2].className).toContain("font-semibold");
});

it("lays a label column out left and a number column out right", () => {
  render(<ExtraTable data={TABLE} />);
  const cells = within(row("r1")).getAllByRole("cell");
  expect(cells[0].className).toContain("text-left");
  expect(cells[2].className).toContain("text-right");
  expect(cells[2].className).toContain("tabular-nums");
});

it("links a row that carries a url and leaves one that does not as text", () => {
  render(<ExtraTable data={TABLE} />);
  const link = within(row("r1")).getByRole("link", { name: "The good one" });
  expect(link.getAttribute("href")).toBe("https://example.com/r1");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(within(row("r2")).queryByRole("link")).toBeNull();
});

it("carries a pill's reason, because the pill alone does not say why", () => {
  render(<ExtraTable data={TABLE} />);
  expect(screen.getByText("Limited").getAttribute("title")).toBe("Limited by budget");
  expect(screen.getByText("Enabled").className).toContain("text-success");
});

it("reads the totals line at summary weight, with a toned cell as a note beside it", () => {
  render(<ExtraTable data={TABLE} />);
  const totals = screen.getByTestId("totals-row");
  expect(within(totals).getByText("3 things")).toBeTruthy();
  const note = within(totals).getByText("ROAS 4.52×");
  expect(note.closest("td")!.className).toContain("font-normal");
});

it("must catch: a table with no rows and nothing to explain draws no section at all, not an empty message", () => {
  const { container } = render(<ExtraTable data={{ ...TABLE, rows: [], footer: undefined }} />);
  expect(container.innerHTML).toBe("");
  expect(screen.queryByTestId("extra-table")).toBeNull();
  expect(screen.queryByText("Nothing ran in this period.")).toBeNull();
});

it("a table with views draws nothing only when every view is empty", () => {
  const views = [{ id: "campaigns", label: "Campaigns", data: { columns: TABLE.columns, rows: [], empty: "None" } }, { id: "ad_sets", label: "Ad sets" }];
  const { container, rerender } = render(<ExtraTable data={{ ...TABLE, rows: [], footer: undefined, views }} />);
  expect(container.innerHTML).toBe("");
  rerender(<ExtraTable data={{ ...TABLE, footer: undefined, views }} />);
  expect(screen.getByTestId("extra-table")).toBeTruthy();
});

const campaign = (over: Partial<GadsPayload["campaigns"][number]>): GadsPayload["campaigns"][number] => ({
  id: "c",
  name: "A campaign",
  status: "ENABLED",
  limited_by_budget: false,
  spend: 0,
  conversions: 0,
  cpa: null,
  conv_value: 0,
  url: null,
  ...over,
});

const GADS = {
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-08-20", to: "2026-09-18" },
  account: { name: "Acme Plumbing", customer_id: "123-456-7890", campaign_count: 3 },
  kpis: [],
  campaigns: [
    campaign({ id: "1", name: "Emergency — broad", spend: 1640, conversions: 29, cpa: 56.55, conv_value: 9512, url: "https://ads.google.com/c/1" }),
    campaign({ id: "2", name: "Water heater — phrase", limited_by_budget: true, spend: 968, conversions: 6, cpa: 161.33, conv_value: 1355 }),
    campaign({ id: "3", name: "Drain cleaning — paused", status: "PAUSED" }),
  ],
  totals: { campaigns: 3, spend: 2608, conversions: 35, cpa: 74.51, conv_value: 10867, roas: 4.52 },
  actions: [],
  counts: { all: 0, needs_you: 0, autonomous: 0 },
} as unknown as GadsPayload;

it("maps the Google payload onto the generic table, column for column", () => {
  render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(headers).toEqual(["Campaign", "Status", "Spend", "Conv.", "CPA", "Conv. value"]);

  const live = screen.getByText("Emergency — broad").closest("tr")!;
  expect(within(live).getAllByRole("cell").map((c) => c.textContent)).toEqual([
    "Emergency — broad",
    "Enabled",
    "$1,640",
    "29",
    "$56.55",
    "$9,512",
  ]);
  expect(within(live).getByRole("link").getAttribute("href")).toBe("https://ads.google.com/c/1");
});

it("keeps a paused campaign's CPA as an em-dash, not a zero", () => {
  render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  const paused = screen.getByText("Drain cleaning — paused").closest("tr")!;
  const cells = within(paused).getAllByRole("cell").map((c) => c.textContent);
  expect(cells[2]).toBe("$0");
  expect(cells[3]).toBe("0");
  expect(cells[4]).toBe("-");
  expect(cells[4]).not.toBe("$0.00");
  expect(within(paused).getByText("Paused")).toBeTruthy();
});

it("names a capped campaign Limited, which is a state Google does not report", () => {
  render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  const capped = screen.getByText("Water heater — phrase").closest("tr")!;
  const chip = within(capped).getByText("Limited");
  expect(chip.getAttribute("title")).toBe("Limited by budget");
});

it("puts account-wide ROAS in the totals line, where the payload actually has one", () => {
  render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  const totals = screen.getByTestId("totals-row");
  expect(within(totals).getByText("3 campaigns")).toBeTruthy();
  expect(within(totals).getByText("ROAS 4.52×")).toBeTruthy();
  expect(within(totals).getByText("$2,608")).toBeTruthy();
});

it("colours no Google cell, because the payload carries no target to judge one against", () => {
  render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  const toned = screen
    .getAllByRole("row")
    .flatMap((r) => within(r).queryAllByRole("cell"))
    .filter((c) => c.getAttribute("data-tone") && c.closest("tfoot") === null);
  expect(toned).toHaveLength(0);
});

it("resolves the declared id to its own adapter", () => {
  const tables = extraTableData("campaign_table", GADS);
  expect(tables).toHaveLength(1);
  expect(tables[0].title).toBe("Campaign performance");
});

it("answers no table, rather than throwing, for a payload its adapter cannot read", () => {
  expect(extraTableData("campaign_table", { generic: true })).toEqual([]);
  expect(extraTableData("campaign_table", null)).toEqual([]);
  expect(extraTableData("campaign_table", "not an object")).toEqual([]);
  expect(extraTableData("x_tables", GADS)).toEqual([]);
  expect(extraTableData("x_tables", null)).toEqual([]);
});

it("hides the campaign section when the account simply spent nowhere", () => {
  const quiet = extraTableData("campaign_table", { ...GADS, campaigns: [], totals: null });
  expect(quiet).toHaveLength(1);
  const { container } = render(<ExtraTable data={quiet[0]} />);
  expect(container.innerHTML).toBe("");
});

it("draws NO action column for a table whose rows can do nothing", () => {
  render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  expect(screen.getAllByRole("columnheader")).toHaveLength(6);
  expect(screen.queryByTestId("extra-row-actions")).toBeNull();
  const live = screen.getByText("Emergency — broad").closest("tr")!;
  expect(within(live).getAllByRole("cell")).toHaveLength(6);
  expect(within(screen.getByTestId("totals-row")).getAllByRole("cell")).toHaveLength(6);
});

it("must catch: a table with views opens on the first view, switches rows, columns and footer on a click, and keeps each view's page when switching back", () => {
  const adSets = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, cells: [{ text: `Ad set ${i}` }, { text: "$1" }] }));
  const data: ExtraTableData = {
    title: "Campaigns and ad sets",
    columns: [{ label: "Ad set", align: "left" }, { label: "Spend" }],
    rows: adSets,
    footer: [{ text: "12 ad sets" }, { text: "$12" }],
    empty: "None",
    pageSize: 10,
    views: [
      { id: "campaigns", label: "Campaigns", data: { columns: [{ label: "Campaign", align: "left" }, { label: "Spend" }], rows: [{ id: "g1", cells: [{ text: "Spring launch" }, { text: "$12" }] }], footer: [{ text: "1 campaign" }, { text: "$12" }], empty: "No campaign", pageSize: 10 } },
      { id: "ad_sets", label: "Ad sets" },
    ],
  };
  render(<ExtraTable data={data} />);
  const tabs = within(screen.getByRole("tablist", { name: "Campaigns and ad sets view" })).getAllByRole("tab");
  expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([["Campaigns", "true"], ["Ad sets", "false"]]);
  const table = () => screen.getByRole("table");
  expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Campaign", "Spend"]);
  expect(table().textContent).toContain("Spring launch");
  expect(table().textContent).not.toContain("Ad set 0");
  expect(within(table()).getByTestId("totals-row").textContent).toContain("1 campaign");
  fireEvent.click(tabs[1]);
  expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Ad set", "Spend"]);
  expect(table().textContent).not.toContain("Spring launch");
  expect(table().textContent).toContain("Ad set 0");
  expect(table().textContent).not.toContain("Ad set 10");
  expect(within(table()).getByTestId("totals-row").textContent).toContain("12 ad sets");
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  expect(table().textContent).toContain("Ad set 10");
  const adSetTable = table();
  fireEvent.click(screen.getAllByRole("tab")[0]);
  expect(table().textContent).toContain("Spring launch");
  fireEvent.click(screen.getAllByRole("tab")[1]);
  expect(table()).toBe(adSetTable);
  expect(table().textContent).toContain("Ad set 10");
  expect(screen.getAllByTestId("sliding-indicator")).toHaveLength(1);
});

it("must catch: switching views never unmounts a view, so its images and reads are not started again", () => {
  let mounts = 0;
  function Thumb() {
    useEffect(() => { mounts += 1; }, []);
    return <span>img</span>;
  }
  const data: ExtraTableData = {
    title: "Campaigns and ad sets",
    columns: [{ label: "Ad set", align: "left" }],
    rows: [{ id: "a", cells: [{ text: "Ad set a", media: <Thumb /> }] }],
    empty: "None",
    views: [
      { id: "campaigns", label: "Campaigns", data: { columns: [{ label: "Campaign", align: "left" }], rows: [{ id: "g", cells: [{ text: "Spring launch" }] }], empty: "None" } },
      { id: "ad_sets", label: "Ad sets" },
    ],
  };
  render(<ExtraTable data={data} />);
  expect(mounts).toBe(1);
  for (let i = 0; i < 3; i++) {
    fireEvent.click(screen.getByRole("tab", { name: "Ad sets" }));
    fireEvent.click(screen.getByRole("tab", { name: "Campaigns" }));
  }
  expect(mounts).toBe(1);
});

it("a table with one view or none draws no view switch", () => {
  render(<ExtraTable data={{ title: "Campaigns", columns: [{ label: "Ad set", align: "left" }], rows: [{ id: "a", cells: [{ text: "A" }] }], empty: "None", views: [{ id: "only", label: "Only" }] }} />);
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByRole("table").textContent).toContain("A");
});

it("must catch: a table too wide for its box scrolls sideways instead of breaking headers, chips and numbers onto two lines", () => {
  render(
    <ExtraTable
      data={{
        title: "Campaigns",
        empty: "No campaigns yet",
        columns: [{ label: "Campaign", align: "left" }, { label: "Ad sets", align: "left" }, { label: "Daily budget" }, { label: "Conv. value" }],
        rows: [{ id: "r1", cells: [{ text: "LinkedIn audience - 2026-11-04" }, { text: "1 ad set", chip: "muted" }, { text: "$25 / day" }, { text: "$0" }] }],
      }}
    />,
  );
  const table = screen.getByRole("table");
  expect(table.parentElement?.className).toMatch(/overflow-x-auto/);
  for (const th of screen.getAllByRole("columnheader")) expect(th.className).toMatch(/whitespace-nowrap/);
  expect(screen.getByText("1 ad set").className).toMatch(/whitespace-nowrap/);
  const [name, , budget] = screen.getAllByRole("cell");
  expect(budget.className).toMatch(/whitespace-nowrap/);
  expect(name.className).toMatch(/min-w-table-name/);
});
