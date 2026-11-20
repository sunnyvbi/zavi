// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { MetricRows } from "./ChannelMetricRows";
import { platformFor } from "../actions/platforms";
import { MetricCard } from "./MetricCard";
import { linkedinAdsKpis } from "../agent/linkedinAdsTables";
import { SummaryRow, defaultPerRow } from "./SummaryRow";
import { formatMetricValue, metricDelta } from "./format";

afterEach(cleanup);

function m(over: Partial<ChannelMetric> & { key: string; value: number }): ChannelMetric {
  return { unit: "count", window_kind: "7d", day: "2026-09-17", grounded: true, prev_value: null, prev_day: null, ...over };
}

describe("metricDelta", () => {
  it("is a percent change against the previous run", () => {
    expect(metricDelta(m({ key: "impressions", value: 24800, prev_value: 20000 }))).toEqual({ text: "+24%", direction: "up", good: true });
  });

  it("moves in points for percentages", () => {
    expect(metricDelta(m({ key: "engagement_rate", value: 2.8, unit: "pct", prev_value: 2.4 }))?.text).toBe("+0.4pp");
  });

  it("treats a cost drop as good and prints dollars", () => {
    expect(metricDelta(m({ key: "cpa", value: 54.51, unit: "usd", prev_value: 57.61 }))).toEqual({ text: "-$3.10", direction: "down", good: true });
  });

  it("is absolute when the previous value was zero, and null with nothing to compare", () => {
    expect(metricDelta(m({ key: "new_follows", value: 12, prev_value: 0 }))?.text).toBe("+12");
    expect(metricDelta(m({ key: "new_follows", value: 12 }))).toBeNull();
    expect(metricDelta(m({ key: "new_follows", value: 12, prev_value: 12 }))).toBeNull();
  });
});

describe("formatMetricValue", () => {
  it("formats by unit", () => {
    expect(formatMetricValue({ value: 24800, unit: "count" })).toBe("24.8K");
    expect(formatMetricValue({ value: 18420, unit: "usd" })).toBe("$18,420");
    expect(formatMetricValue({ value: 54.51, unit: "usd" })).toBe("$54.51");
    expect(formatMetricValue({ value: 2.8, unit: "pct" })).toBe("2.8%");
    expect(formatMetricValue({ value: 3.456, unit: "ratio" })).toBe("3.46×");
  });
});

describe("MetricCard", () => {
  it("shows value and delta, and no unverified label when grounded", () => {
    render(<MetricCard metric={m({ key: "profile_visits", value: 186, prev_value: 166 })} />);
    expect(screen.getByText("Profile visits")).toBeTruthy();
    expect(screen.getByText("186")).toBeTruthy();
    const delta = screen.getByTestId("delta-profile_visits");
    expect(delta.textContent).toBe("+12%");
    expect(delta.getAttribute("data-good")).toBe("true");
    expect(screen.queryByTestId("metric-unverified")).toBeNull();
  });

  it("labels an ungrounded number unverified", () => {
    render(<MetricCard metric={m({ key: "link_clicks", value: 40, grounded: false })} />);
    expect(screen.getByTestId("metric-unverified").textContent).toBe("unverified");
  });

  it("LinkedIn Ads account tiles print unverified on an ungrounded number, like the other ad channels", () => {
    const metrics = [
      m({ key: "spend", value: 0, unit: "usd", grounded: true }),
      m({ key: "cpc", value: 1.2, unit: "usd", grounded: false }),
      m({ key: "ctr", value: 0.4, unit: "pct", grounded: false, prev_value: 0.2 }),
      m({ key: "cost_per_conversion", value: 0, unit: "usd", grounded: false, unmeasured: "No conversions yet" }),
    ];
    const { container } = render(<MetricRows slug="linkedin_ads" metrics={metrics} platform={platformFor("linkedin_ads")} plan={null} onPlanSaved={vi.fn()} />);
    expect(container.textContent?.match(/unverified/gi)).toHaveLength(2);
    expect(container.textContent).toContain("$1.20");
    expect(container.textContent).toContain("No conversions yet");
  });

  it("an empty LinkedIn Ads account shows a bare dash on its ratio tiles, with no caption and no unverified tag, while a real ungrounded number on another channel still is unverified", () => {
    const empty = linkedinAdsKpis({ platform: "linkedin_ads", connected: true, error_code: null, window_days: 30, period: { from: "2026-10-04", to: "2026-11-02" }, account: { name: "Acme", account_count: 1, campaign_count: 1, active_count: 0, currency: "USD" }, totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null }, campaigns: [] });
    expect(empty).toHaveLength(6);
    const { container } = render(<MetricRows slug="linkedin_ads" metrics={empty} platform={platformFor("linkedin_ads")} plan={null} onPlanSaved={vi.fn()} />);
    expect(container.textContent).not.toMatch(/unverified/i);
    expect(screen.queryByTestId("metric-unverified")).toBeNull();
    expect(container.textContent).not.toMatch(/in this period/i);
    for (const key of ["cpl", "cpc"]) {
      const tile = container.querySelector(`[data-metric="${key}"]`);
      expect(tile).not.toBeNull();
      expect(tile?.textContent).toContain("-");
      expect(tile?.textContent).not.toMatch(/unverified|previous run|no earlier run/i);
    }
    cleanup();
    for (const variant of ["compact", "detail", "account"] as const) {
      const { container: one, unmount } = render(<MetricCard variant={variant} metric={m({ key: "cpc", value: Number.NaN, unit: "usd", grounded: false, unmeasured: "No clicks in this period" })} />);
      expect(one.textContent).not.toMatch(/unverified/i);
      expect(one.textContent).toContain("No clicks in this period");
      unmount();
      const { container: real, unmount: off } = render(<MetricCard variant={variant} metric={m({ key: "cpc", value: 1.2, unit: "usd", grounded: false })} />);
      expect(real.textContent).toMatch(/unverified/i);
      off();
    }
    const { container: meta } = render(<MetricRows slug="meta_ads" metrics={[m({ key: "spend", value: 10, unit: "usd" }), m({ key: "cpc", value: 1.2, unit: "usd", grounded: false }), m({ key: "ctr", value: Number.NaN, unit: "pct", grounded: false, unmeasured: "No impressions in this period" })]} platform={platformFor("meta_ads")} plan={null} onPlanSaved={vi.fn()} />);
    expect(meta.textContent?.match(/unverified/gi)).toHaveLength(1);
  });

  it.each([["meta_ads"], ["google_ads"]])("%s account tiles still print unverified on an ungrounded number", (slug) => {
    const metrics = [
      m({ key: "spend", value: 10, unit: "usd", grounded: true }),
      m({ key: "cpc", value: 1.2, unit: "usd", grounded: false }),
    ];
    const { container } = render(<MetricRows slug={slug} metrics={metrics} platform={platformFor(slug)} plan={null} onPlanSaved={vi.fn()} />);
    expect(container.textContent?.match(/unverified/gi)).toHaveLength(1);
  });

  it("detail variant shows a chip and the previous run", () => {
    render(<MetricCard variant="detail" metric={m({ key: "spend", value: 18420, unit: "usd", prev_value: 16446, prev_day: "2026-09-10" })} />);
    expect(screen.getByTestId("delta-spend").textContent).toBe("▲ 12%");
    expect(screen.getByText(/Previous run \(Sep 10\): \$16,446/)).toBeTruthy();
  });

  it("detail variant honours the adapter's tone and note", () => {
    render(
      <MetricCard
        variant="detail"
        metric={m({ key: "roas", value: 0.76, unit: "ratio", prev_value: 0.3, tone: "bad", note: "$0.76 back per $1 spent" })}
      />,
    );
    expect(screen.getByTestId("value-roas").className).toContain("text-danger");
    expect(screen.getByText("$0.76 back per $1 spent")).toBeTruthy();
    expect(screen.getByTestId("delta-roas")).toBeTruthy();
  });

  it("compact variant keeps the change beside a toned value", () => {
    render(<MetricCard metric={m({ key: "roas", value: 0.76, unit: "ratio", prev_value: 0.3, tone: "bad", note: "$0.76 back per $1 spent" })} />);
    expect(screen.getByTestId("value-roas").className).toContain("text-danger");
    expect(screen.getByTestId("delta-roas").textContent).toBe("+153.3%");
    expect(screen.getByText("$0.76 back per $1 spent")).toBeTruthy();
  });

  it("detail variant without a tone stays in plain ink", () => {
    render(<MetricCard variant="detail" metric={m({ key: "spend", value: 18420, unit: "usd" })} />);
    expect(screen.getByTestId("value-spend").className).toContain("text-ink");
  });
});

describe("SummaryRow", () => {
  it("picks columns from the count", () => {
    expect([3, 4, 5, 6, 7, 8].map(defaultPerRow)).toEqual([3, 4, 5, 6, 8, 8]);
  });

  it("renders one card per metric, and the spend variant draws pacing as a bar", () => {
    const metrics = [
      m({ key: "spend", value: 18420, unit: "usd", prev_value: 16446 }),
      m({ key: "cpa", value: 54.51, unit: "usd", prev_value: 57.61 }),
      m({ key: "pacing", value: 94, unit: "pct" }),
    ];
    render(<SummaryRow metrics={metrics} variant="spend" display={{ cpa: { label: "Cost per conversion" } }} />);
    expect(screen.getByTestId("summary-row").getAttribute("data-variant")).toBe("spend");
    expect(screen.getByText("Cost per conversion")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("94");
  });

  it("the pacing card draws its note and colours the value and bar by tone", () => {
    const metrics = [m({ key: "pacing", value: 140, unit: "pct", tone: "bad", note: "$1,050 of $1,500 · day 15 of 30" })];
    render(<SummaryRow metrics={metrics} variant="spend" display={{ pacing: { label: "Plan pace" } }} />);
    const tile = document.querySelector('[data-metric="pacing"]')!;
    expect(tile.textContent).toContain("Plan pace");
    expect(tile.textContent).toContain("$1,050 of $1,500 · day 15 of 30");
    expect(tile.textContent).not.toContain("of plan");
    expect(screen.getByTestId("value-pacing").className).toContain("text-danger");
    expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).className).toContain("bg-danger");
  });

  it("renders nothing without metrics", () => {
    const { container } = render(<SummaryRow metrics={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("SummaryRow selection", () => {
  const TWO = [
    m({ key: "brand_mentions", value: 24 }),
    m({ key: "relevant_posts", value: 8 }),
  ];
  const BOTH_SELECT = {
    brand_mentions: { label: "Brand mentions", selects: "table_a" },
    relevant_posts: { label: "Relevant posts", selects: "table_b" },
  };
  const sel = (over: Partial<Parameters<typeof SummaryRow>[0]["selection"]> = {}) => ({
    selectedKey: undefined,
    onSelect: vi.fn(),
    panelId: "panel",
    ...over,
  });

  it("is a plain grid of divs when no selection is handed down", () => {
    const { container } = render(<SummaryRow metrics={TWO} display={BOTH_SELECT} />);
    expect(screen.getByTestId("summary-row").getAttribute("role")).toBeNull();
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelector('[data-metric="brand_mentions"]')?.tagName).toBe("DIV");
  });

  it("stays a plain grid when only some of its numbers name a table", () => {
    const { container } = render(
      <SummaryRow
        metrics={TWO}
        display={{ brand_mentions: { selects: "table_a" } }}
        selection={sel()}
      />,
    );
    expect(screen.getByTestId("summary-row").getAttribute("role")).toBeNull();
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("stays a plain grid with a single number, because one choice is not a choice", () => {
    const { container } = render(
      <SummaryRow metrics={[TWO[0]]} display={BOTH_SELECT} selection={sel()} />,
    );
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("becomes a tablist, defaults to the first number, and announces which is showing", () => {
    render(<SummaryRow metrics={TWO} display={BOTH_SELECT} selection={sel()} />);
    expect(screen.getByTestId("summary-row").getAttribute("role")).toBe("tablist");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[0].getAttribute("aria-controls")).toBe("panel");
  });

  it("honours the key it is handed, and reports the key that was clicked", () => {
    const onSelect = vi.fn();
    render(
      <SummaryRow
        metrics={TWO}
        display={BOTH_SELECT}
        selection={sel({ selectedKey: "relevant_posts", onSelect })}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[0]);
    expect(onSelect).toHaveBeenCalledWith("brand_mentions");
  });

  it("falls back to the first number when the key it is handed is not in this row", () => {
    render(
      <SummaryRow metrics={TWO} display={BOTH_SELECT} selection={sel({ selectedKey: "gone" })} />,
    );
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("gives each tab a focusable native button", () => {
    render(<SummaryRow metrics={TWO} display={BOTH_SELECT} selection={sel()} />);
    const tab = screen.getAllByRole("tab")[1] as HTMLButtonElement;
    expect(tab.tagName).toBe("BUTTON");
    expect(tab.type).toBe("button");
    expect(tab.tabIndex).toBe(0);
    tab.focus();
    expect(document.activeElement).toBe(tab);
  });

  it("does not turn the spend variant into a picker", () => {
    const { container } = render(
      <SummaryRow
        metrics={[m({ key: "spend", value: 1, unit: "usd" }), m({ key: "cpa", value: 2, unit: "usd" })]}
        variant="spend"
        display={{ spend: { selects: "table_a" }, cpa: { selects: "table_b" } }}
        selection={sel()}
      />,
    );
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
  });
});

describe("the shared advertising overview layout", () => {
  it.each(["meta_ads", "google_ads", "youtube_ads", "tiktok_ads", "linkedin_ads", "reddit_ads", "x_ads", "chatgpt_ads"])("%s uses the centered overview metric style", (slug) => {
    render(<MetricRows slug={slug} platform={platformFor(slug)} metrics={[m({ key: "spend", value: 820, unit: "usd" }), m({ key: "conversions", value: 87 }), m({ key: "clicks", value: 200 })]} plan={null} onPlanSaved={vi.fn()} />);
    const row = screen.getByTestId("summary-row");
    expect(row.dataset.variant).toBe("account");
    expect(row.className).toContain("grid-cols-1");
    expect(row.className).toContain("sm:grid-cols-2");
    expect(row.className).toContain("xl:grid-cols-3");
    expect(row.querySelectorAll("[data-metric]")).toHaveLength(3);
    expect(row.querySelectorAll("svg")).toHaveLength(3);
    expect(screen.getByTestId("value-spend").closest("[data-metric]")?.querySelector(".lucide-circle-dollar-sign")).not.toBeNull();
    expect(screen.getByTestId("value-spend").textContent).toContain("820");
    expect(screen.getByTestId("value-clicks").closest("[data-metric]")?.className).toContain("bg-bone/60");
  });

  it("keeps table selection available on account metric tiles", () => {
    const onSelect = vi.fn();
    render(<SummaryRow variant="account" metrics={[m({ key: "spend", value: 20 }), m({ key: "clicks", value: 30 })]} display={{ spend: { label: "Spend", selects: "campaigns" }, clicks: { label: "Clicks", selects: "ads" } }} selection={{ selectedKey: "spend", onSelect, panelId: "campaign-details" }} />);
    fireEvent.click(screen.getByRole("tab", { name: /Clicks/ }));
    expect(onSelect).toHaveBeenCalledWith("clicks");
    expect(screen.getByRole("tab", { name: /Spend/ }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("account metric reference typography", () => {
  it.each(["light", "dark"])("keeps borders while showing stacked labels and large values in %s mode", (theme) => {
    render(<div className={theme}><MetricCard variant="account" metric={m({ key: "roas", value: 2.71, unit: "ratio", tone: "good", note: "$2.71 back per $1 spent" })} label="ROAS" /></div>);
    const value = screen.getByTestId("value-roas");
    expect(value.className).toContain("text-metric-value");
    expect(value.className).toContain("font-bold");
    expect(value.className).toContain("text-success");
    expect(value.parentElement?.className).toContain("text-left");
    const tile = value.closest("[data-metric]");
    expect(tile?.className).toContain("flex-col");
    expect(tile?.className).toContain("border-rule");
    expect(tile?.className).toContain("rounded-2xl");
    expect(screen.getByText("ROAS").parentElement?.className).toContain("font-semibold");
    expect(screen.getByText("$2.71 back per $1 spent").className).toContain("text-inkMuted");
  });

  it("uses the existing warning tone for ROAS when supplied", () => {
    render(<MetricCard variant="account" metric={m({ key: "roas", value: 0.8, tone: "warn", unit: "ratio" })} />);
    expect(screen.getByTestId("value-roas").className).toContain("text-warn");
  });
});
