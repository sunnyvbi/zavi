// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtraTable, type ExtraTableData } from "../ExtraTable";
import { gadsCampaignTable } from "../../agent/legacyChannelActions";
import { toast } from "@/components/ui/toast";
import type { GadsPayload } from "../../agent/google-ads/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await Promise.resolve(); });

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
  ],
  totals: { campaigns: 1, spend: 1640, conversions: 29, cpa: 56.55, conv_value: 9512, roas: 5.8 },
  actions: [],
  counts: { all: 0, needs_you: 0, autonomous: 0 },
} as unknown as GadsPayload;

it("keeps campaign values and the destination link when a row has no detail", () => {
  const { container } = render(<ExtraTable data={gadsCampaignTable(GADS)} />);
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(1);
  expect(Array.from(rows[0].querySelectorAll("td")).map((cell) => cell.textContent)).toEqual(["Emergency — broad", "Enabled", "$1,640", "29", "$56.55", "$9,512"]);
  expect(screen.getByRole("link", { name: "Emergency — broad" }).getAttribute("href")).toBe("https://ads.google.com/c/1");
  expect(screen.queryByTestId("extra-row-detail")).toBeNull();
  expect(screen.queryByTestId("extra-row-actions")).toBeNull();
  expect(screen.getAllByRole("columnheader")).toHaveLength(6);
});

const DRAFT = "Two winters ago I had the same problem.\nHere is what actually worked.";

const withDetail = (onDone: () => Promise<unknown>): ExtraTableData => ({
  title: "Reply opportunities",
  columns: [{ label: "Thread", align: "left" }, { label: "Status", align: "left" }],
  rows: [
    {
      id: "t1",
      cells: [{ text: "Anyone used a tool like this?" }, { text: "Drafted", chip: "muted" }],
      detail: {
        title: "Drafted reply · edit it on Reddit before you post",
        text: DRAFT,
        openLabel: "Show draft",
        closeLabel: "Hide draft",
        actions: [{ label: "Mark as posted", busyLabel: "Saving…", onClick: onDone }],
      },
    },
  ],
  empty: "Nothing here.",
  actionsLabel: "Reply",
});

it("keeps the draft behind one press, then prints it in full", () => {
  render(<ExtraTable data={withDetail(async () => {})} />);
  expect(screen.queryByText(DRAFT)).toBeNull();

  const toggle = screen.getByRole("button", { name: /Show draft/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);

  const region = screen.getByRole("region", { name: "Drafted reply · edit it on Reddit before you post" });
  const body = within(region).getByText(DRAFT, { normalizer: (s) => s });
  expect(body.textContent).toBe(DRAFT);
  expect(body.className).toContain("whitespace-pre-wrap");
  expect(screen.getByRole("button", { name: /Hide draft/ }).getAttribute("aria-controls")).toBe(region.id);

  fireEvent.click(screen.getByRole("button", { name: /Hide draft/ }));
  expect(screen.queryByText(DRAFT)).toBeNull();
});

it("fires the row's own Done verb from inside the draft", async () => {
  const done = vi.fn().mockResolvedValue(undefined);
  render(<ExtraTable data={withDetail(done)} />);
  fireEvent.click(screen.getByRole("button", { name: /Show draft/ }));
  fireEvent.click(screen.getByRole("button", { name: "Mark as posted" }));
  expect(done).toHaveBeenCalledTimes(1);
  await flush();
});

it("says why a Done that failed did nothing, in a pop-up rather than settling quietly", async () => {
  const shown = vi.spyOn(toast, "add").mockReturnValue("t");
  const done = vi.fn().mockRejectedValue(new Error("Couldn't save that. Try again in a moment."));
  render(<ExtraTable data={withDetail(done)} />);
  fireEvent.click(screen.getByRole("button", { name: /Show draft/ }));
  fireEvent.click(screen.getByRole("button", { name: "Mark as posted" }));
  await flush();
  expect(shown).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Couldn't save that. Try again in a moment." }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("prints what a press that succeeded has to say, where the press has nothing else to show", async () => {
  const post = vi.fn().mockResolvedValue("Reply copied. Opening the thread…");
  const data = withDetail(async () => {});
  data.rows[0].detail!.actions = [{ label: "Post", onClick: post }];
  render(<ExtraTable data={data} />);
  fireEvent.click(screen.getByRole("button", { name: /Show draft/ }));
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  await flush();
  expect(screen.getByRole("status").textContent).toBe("Reply copied. Opening the thread…");
});

const OPTIONS = [
  { value: "allowed", label: "Allowed" },
  { value: "unclear", label: "Limited" },
  { value: "banned", label: "Not allowed" },
];

const withSelect = (value: string | null, onChange: (v: string | null) => Promise<unknown>): ExtraTableData => ({
  title: "Relevant subreddits",
  columns: [{ label: "Subreddit", align: "left" }, { label: "Self-promo", align: "left" }],
  rows: [
    {
      id: "r/smallbusiness",
      cells: [
        { text: "r/smallbusiness" },
        {
          text: value ? OPTIONS.find((o) => o.value === value)!.label : "Check rules",
          select: {
            value,
            unsetLabel: "Check rules",
            options: OPTIONS,
            label: "Self-promo in r/smallbusiness (your reading of its rules)",
            onChange,
          },
        },
      ],
    },
  ],
  empty: "Nothing here.",
});

it("leaves an unchecked subreddit unset, and never falls back to the first option", () => {
  render(<ExtraTable data={withSelect(null, async () => {})} />);
  const select = screen.getByRole("combobox", {
    name: "Self-promo in r/smallbusiness (your reading of its rules)",
  }) as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(select.options[0].value).toBe("");
  expect(select.options[0].textContent).toBe("Check rules");
  expect(select.value).not.toBe("allowed");
});

it("can be set back to unset, and sends null rather than an empty string", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<ExtraTable data={withSelect("banned", onChange)} />);
  const select = screen.getByRole("combobox", { name: /Self-promo/ }) as HTMLSelectElement;
  expect(select.value).toBe("banned");
  fireEvent.change(select, { target: { value: "" } });
  await flush();
  expect(onChange).toHaveBeenCalledWith(null);
});

it("puts the old verdict back when the save is refused, and says who can do it", async () => {
  const onChange = vi.fn().mockRejectedValue(new Error("Only an owner or an admin can change this."));
  render(<ExtraTable data={withSelect("allowed", onChange)} />);
  const select = screen.getByRole("combobox", { name: /Self-promo/ }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "banned" } });
  await flush();
  expect(select.value).toBe("allowed");
  expect(screen.getByRole("alert").textContent).toBe("Only an owner or an admin can change this.");
});

const TAIL: ExtraTableData = {
  title: "Relevant subreddits",
  columns: [{ label: "Subreddit", align: "left" }, { label: "Relevance", align: "left" }],
  rows: [
    { id: "a", cells: [{ text: "r/keeper" }, { text: "High", meter: { value: 82, name: "Relevance" } }] },
    { id: "b", cells: [{ text: "r/quiet" }, { text: "Low", meter: { value: 12, name: "Relevance" } }], tail: true },
    { id: "c", cells: [{ text: "r/quieter" }, { text: "Low", meter: { value: 9, name: "Relevance" } }], tail: true },
  ],
  empty: "No subreddits scored yet.",
  tailToggle: {
    show: (n) => `Show ${n} low-relevance ${n === 1 ? "subreddit" : "subreddits"}`,
    hide: "Hide low-relevance subreddits",
    noneAbove: "No subreddit scored Medium or higher yet.",
  },
};

it("hides the low-scoring tail behind a toggle that says how much is down there", () => {
  render(<ExtraTable data={TAIL} />);
  expect(screen.queryByText("r/quiet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 low-relevance subreddits" }));
  expect(screen.getByText("r/quiet")).toBeTruthy();
  expect(screen.getByText("r/quieter")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide low-relevance subreddits" }));
  expect(screen.queryByText("r/quiet")).toBeNull();
});

it("says every row is in the tail, rather than saying there are none", () => {
  render(<ExtraTable data={{ ...TAIL, rows: TAIL.rows.map((r) => ({ ...r, tail: true })) }} />);
  expect(screen.getByTestId("extra-table-tail-only").textContent).toBe("No subreddit scored Medium or higher yet.");
  expect(screen.queryByTestId("extra-table-empty")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 3 low-relevance subreddits" }));
  expect(screen.getByText("r/keeper")).toBeTruthy();
});

it("ignores `tail` on a table with no way to get those rows back", () => {
  const { tailToggle, ...noWayBack } = TAIL;
  void tailToggle;
  render(<ExtraTable data={noWayBack} />);
  expect(screen.getByText("r/quiet")).toBeTruthy();
  expect(screen.getByText("r/quieter")).toBeTruthy();
});

it("draws a score as a meter a screen reader can read, and no meter where there is no score", () => {
  render(<ExtraTable data={TAIL} />);
  const meter = screen.getByRole("meter", { name: "Relevance" });
  expect(meter.getAttribute("aria-valuenow")).toBe("82");
  expect(meter.getAttribute("aria-valuemax")).toBe("100");

  cleanup();
  render(
    <ExtraTable
      data={{ ...TAIL, rows: [{ id: "a", cells: [{ text: "r/unscored" }, { text: "—", tone: "dim" }] }] }}
    />,
  );
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getByText("—")).toBeTruthy();
});

it("keeps the terms behind a cell out of a column of their own, and reachable", () => {
  render(
    <ExtraTable
      data={{
        ...TAIL,
        rows: [
          {
            id: "a",
            cells: [
              { text: "A thread" },
              {
                text: "High",
                meter: { value: 82, name: "Relevance" },
                terms: {
                  items: ["booking software", "small fleet"],
                  name: "Matched keywords",
                  heading: "Matched keywords · 2",
                  buttonLabel: "Show 2 matched keywords",
                },
              },
            ],
          },
        ],
      }}
    />,
  );
  expect(screen.queryByText("booking software")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 matched keywords" }));
  const pop = screen.getByRole("dialog", { name: "Matched keywords" });
  expect(within(pop).getByText("booking software")).toBeTruthy();
  expect(within(pop).getByText("small fleet")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
