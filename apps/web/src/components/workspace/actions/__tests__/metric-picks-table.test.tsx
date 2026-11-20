// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

const { tableFor } = vi.hoisted(() => ({
  tableFor: { current: null as null | ((id: string) => unknown[]) },
}));
vi.mock("../../agent/legacyChannelActions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../agent/legacyChannelActions")>();
  return {
    ...real,
    extraTableData: (id: string, payload: unknown, onChanged?: () => void) =>
      tableFor.current ? tableFor.current(id) : real.extraTableData(id as never, payload, onChanged),
  };
});

import { ChannelActionsLane } from "../ChannelActionsLane";
import { FIXTURES } from "./fixtures";

const kpi = (key: string, value: number, unit: string) => ({
  key,
  label: key,
  value,
  prev: null,
  delta_pct: null,
  delta_abs: null,
  delta_good: null,
  unit,
});

const PAYLOAD = {
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-08-20", to: "2026-09-18" },
  prev_period: { from: "2026-07-21", to: "2026-08-19" },
  account: null,
  kpis: [kpi("spend", 4820, "usd"), kpi("clicks", 311, "int")],
  campaigns: [],
  totals: null,
  actions: [],
  counts: { all: 0, needs_you: 0, autonomous: 0 },
};

const table = (title: string, id?: string) => ({
  ...(id ? { id } : {}),
  title,
  columns: [{ label: "Name", align: "left" as const }],
  rows: [{ id: "r1", cells: [{ text: `${title} row` }] }],
  empty: "Nothing here.",
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function route() {
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
    if (url.includes("/metrics")) return ok({ metrics: [] });
    if (url.includes("/dashboard")) return ok(PAYLOAD);
    throw new Error(`unexpected request: ${url}`);
  });
}

function lane(slug: string) {
  return render(
    <ChannelActionsLane
      slug={slug}
      legacy={<p>legacy rail</p>}
      workState="idle"
      lastRunAt={null}
      actionCount={0}
      connected
      hasConnectors
    >
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

const TWO_TABLES: PlatformSpec = {
  name: "Made-up channel",
  kpiFallback: "gads",
  metricDisplay: {
    spend: { label: "Brand mentions", selects: "t_a" },
    clicks: { label: "Relevant posts", selects: "t_b" },
  },
  extras: ["campaign_table"],
};

beforeEach(() => {
  apiFetch.mockReset();
  tableFor.current = () => [table("Table A", "t_a"), table("Table B", "t_b")];
  route();
});
afterEach(() => {
  cleanup();
  tableFor.current = null;
});

describe("a channel whose numbers pick the table", () => {
  it("shows the first number's table, with the row announced as the picker", async () => {
    spec.current = TWO_TABLES;
    const view = lane("pick-two");
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(view.queryByText("Table B")).toBeNull();

    const panel = screen.getByRole("tabpanel");
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toContain("Table A");
  });

  it("switches the table when another number is clicked", async () => {
    spec.current = TWO_TABLES;
    const view = lane("pick-switch");
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    fireEvent.click(screen.getAllByRole("tab")[1]);

    await waitFor(() => expect(view.queryByText("Table B")).not.toBeNull());
    expect(view.queryByText("Table A")).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  });

  it("activates from the keyboard, because each tab is a focusable button", async () => {
    spec.current = TWO_TABLES;
    const view = lane("pick-keys");
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    const tab = screen.getAllByRole("tab")[1] as HTMLButtonElement;
    expect(tab.tagName).toBe("BUTTON");
    expect(tab.type).toBe("button");
    tab.focus();
    expect(document.activeElement).toBe(tab);
    fireEvent.click(document.activeElement as Element);
    await waitFor(() => expect(view.queryByText("Table B")).not.toBeNull());
  });

  it("does not make a tab out of a claim on a table that read nothing", async () => {
    spec.current = TWO_TABLES;
    tableFor.current = () => [table("Table A", "t_a")];
    const view = lane("pick-one-resolved");
    await waitFor(() => expect(view.queryByText("Table A")).not.toBeNull());

    expect(screen.queryAllByRole("tab").length).toBe(0);
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });
});

describe("a channel with one table is untouched", () => {
  const ONE_TABLE: PlatformSpec = {
    name: "Google Ads",
    kpiFallback: "gads",
    metricDisplay: { spend: { label: "Spend" }, clicks: { label: "Clicks" } },
    extras: ["campaign_table"],
  };

  it("draws its table with no tabs, no tabpanel and no buttons in the row", async () => {
    spec.current = ONE_TABLE;
    tableFor.current = () => [table("Table A")];
    const view = lane("one-table");
    await waitFor(() => expect(view.queryByText("Table A")).not.toBeNull());

    expect(screen.queryAllByRole("tab").length).toBe(0);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByTestId("summary-row").getAttribute("role")).toBeNull();
    expect(view.container.querySelector('[data-metric="spend"]')?.tagName).toBe("DIV");
    expect(view.container.querySelector('[data-metric="spend"]')?.textContent).toContain("$4,820");
  });

  it("is still plain when its one number names that table", async () => {
    spec.current = { ...ONE_TABLE, metricDisplay: { spend: { selects: "t_a" } } };
    tableFor.current = () => [table("Table A", "t_a")];
    const view = lane("one-table-claimed");
    await waitFor(() => expect(view.queryByText("Table A")).not.toBeNull());
    expect(screen.queryAllByRole("tab").length).toBe(0);
  });
});

describe("a channel that asks for its tables LAST", () => {
  const ONE: PlatformSpec = { name: "Made-up channel", kpiFallback: "gads", extras: ["campaign_table"] };

  const order = (view: ReturnType<typeof lane>) => {
    const html = view.container.innerHTML;
    return html.indexOf("Table A row") - html.indexOf('data-testid="action-section"');
  };

  it("draws the table after the action list, and only there", async () => {
    tableFor.current = () => [table("Table A", "t_a")];
    spec.current = { ...ONE, tablesLast: true };
    const view = lane("tables-last");
    await waitFor(() => expect(screen.getByText("Table A row")).toBeTruthy());
    expect(screen.getAllByText("Table A row")).toHaveLength(1);
    expect(order(view)).toBeGreaterThan(0);
  });

  it("FALSIFIER: without the key the table stays above the action list", async () => {
    tableFor.current = () => [table("Table A", "t_a")];
    spec.current = ONE;
    const view = lane("tables-first");
    await waitFor(() => expect(screen.getByText("Table A row")).toBeTruthy());
    expect(order(view)).toBeLessThan(0);
  });
});
