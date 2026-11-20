// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./PostPreview", () => ({
  PostPreview: ({ channel }: { channel: string }) => <div data-testid="post-preview">{channel}</div>,
}));
const chartSize = vi.hoisted(() => ({ on: false }));
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const { cloneElement, isValidElement } = await vi.importActual<typeof import("react")>("react");
  (actual.Bar as unknown as { defaultProps: Record<string, unknown> }).defaultProps.isAnimationActive = false;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<any> }) => (
      <div style={{ width: 400, height: 200 }}>
        {chartSize.on && isValidElement(children)
          ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, { width: 400, height: 200 })
          : children}
      </div>
    ),
  };
});

import { barFill, CHART_COLORS, UiBlockArtifact, UiBlockSkeleton, UiBlockView } from "./UiBlockArtifact";
import { dismissReport } from "./uiBlockData";

const blockJson = (b: unknown) => {
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ signed_url: "https://signed/x" }) });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => b })));
};

beforeEach(() => apiFetch.mockReset());

describe("UiBlockView", () => {
  it("table: columns + rows, null as a dash, numbers right-aligned", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "table", title: "Top posts", columns: ["Post", "Clicks"], rows: [["Launch", 42], ["Teaser", null]] }} />,
    );
    expect(within(container).getByText("Top posts")).toBeTruthy();
    expect(within(container).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Post", "Clicks"]);
    expect(within(container).getByText("-")).toBeTruthy();
    expect(within(container).getByText("42").className).toMatch(/text-right/);
  });

  it("chart: accessible words-only list mirrors the series", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "chart", title: "Signups", variant: "bar", series: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }] }} />,
    );
    expect(within(container).getByRole("img", { name: /bar chart: Signups/ })).toBeTruthy();
    expect(within(container).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Mon: 3", "Tue: 5"]);
  });

  it("posts: one PostPreview per post", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "posts", title: "Drafts", posts: [{ channel: "linkedin", payload: { text: "a" } }, { channel: "reddit", payload: { text: "b" } }] }} />,
    );
    expect(within(container).getAllByTestId("post-preview").map((p) => p.textContent)).toEqual(["linkedin", "reddit"]);
  });
});

describe("UiBlockView — new kinds", () => {
  it("pie/donut/funnel charts render with the words-only fallback", () => {
    for (const variant of ["pie", "donut", "funnel", "area"] as const) {
      const { container } = render(
        <UiBlockView block={{ kind: "chart", title: `T-${variant}`, variant, series: [{ label: "A", value: 1 }, { label: "B", value: 3 }] }} />,
      );
      expect(within(container).getByRole("img", { name: `${variant} chart: T-${variant}` })).toBeTruthy();
      expect(within(container).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["A: 1", "B: 3"]);
    }
  });

  it("kpi cards show value and delta", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "kpi", title: "Labor Day", items: [{ label: "Spend", value: "$141", delta: "+5%", tone: "up" }, { label: "Leads", value: 152 }] }} />,
    );
    expect(within(container).getByText("$141")).toBeTruthy();
    expect(within(container).getByText("+5%")).toBeTruthy();
    expect(within(container).getByText("152")).toBeTruthy();
  });

  it("html renders in an EMPTY sandbox with the no-network CSP prepended, never as a URL", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "html", title: "Funnel", html: "<svg><circle r='4'/></svg>", height: 300 }} />,
    );
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("src")).toBeNull();
    expect(f.getAttribute("srcdoc")).toMatch(/Content-Security-Policy/);
    expect(f.getAttribute("srcdoc")).toMatch(/default-src 'none'/);
    expect(f.getAttribute("srcdoc")).toContain("<circle");
    expect(f.style.height).toBe("300px");
  });
});

describe("HtmlCard — scripts allowed (backend-marked)", () => {
  it("uses sandbox=allow-scripts and a CSP that closes every network directive", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "html", title: "Live", html: "<div id='a'></div><script>1</script>", scripts: true }} />,
    );
    const f = container.querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    const csp = f.getAttribute("srcdoc")!;
    expect(csp).toMatch(/script-src 'unsafe-inline'/);
    for (const d of ["connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'"]) expect(csp).toContain(d);
    expect(csp).toContain("<script>1</script>");
  });

  it("a static card (no scripts flag) keeps the EMPTY sandbox even if html contains a script tag", () => {
    const { container } = render(<UiBlockView block={{ kind: "html", title: "S", html: "<script>1</script>" }} />);
    expect(container.querySelector("iframe")!.getAttribute("sandbox")).toBe("");
  });
});

describe("UiBlockArtifact", () => {
  it("signs, fetches, parses and renders the block", async () => {
    blockJson({ kind: "table", title: "T", columns: ["a"], rows: [["x"]] });
    const { container } = render(<UiBlockArtifact artifact={{ id: "art-1", filename: "ui-block-1.json" }} fallback={<span>chip</span>} />);
    expect(await within(container).findByText("T")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/run-artifacts/art-1/url",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("draws a chart and a KPI card that carry the new provenance fields", async () => {
    const receipt = { source: "stripe", metric_id: "net_revenue", window: { since: "2026-09-01", until: "2026-09-02" }, tz: "UTC", currency: "USD" };
    blockJson({
      kind: "chart",
      title: "Net revenue",
      variant: "line",
      series: [{ label: "2026-09-01", value: 10 }, { label: "2026-09-02", value: 12 }],
      compare: [{ label: "2026-08-30", value: 9 }],
      goal: 15,
      result_id: "m_0123456789",
      verified: true,
      receipt,
      as_of: "2026-09-03T00:00:00.000Z",
      window: receipt.window,
    });
    const chart = render(<UiBlockArtifact artifact={{ id: "art-9", filename: "ui-block-9.json" }} fallback={<span>chip</span>} />);
    expect(await within(chart.container).findByText("Net revenue")).toBeTruthy();
    expect(within(chart.container).queryByText("chip")).toBeNull();
    cleanup();
    const { container } = render(
      <UiBlockView
        block={{ kind: "kpi", title: "Sept", verified: false, items: [{ label: "Revenue", value: 12, verified: true, result_id: "m_0123456789", receipt }, { label: "Typed", value: "$5K", verified: false }] }}
      />,
    );
    expect(within(container).getByText("12")).toBeTruthy();
    expect(within(container).getByText("$5K")).toBeTruthy();
  });

  it("reuses a list URL without signing again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          kind: "table",
          title: "From list URL",
          columns: ["a"],
          rows: [["x"]],
        }),
      })),
    );
    const { container } = render(
      <UiBlockArtifact
        artifact={{
          id: "art-list",
          filename: "ui-block-list.json",
          preview_url: "https://signed/from-list",
        }}
        fallback={<span>chip</span>}
      />,
    );
    expect(await within(container).findByText("From list URL")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "https://signed/from-list",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("retries a transient signing failure after the list URL expires", async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ signed_url: "https://signed/fresh-ui-block" }),
      });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            kind: "table",
            title: "Recovered block",
            columns: ["a"],
            rows: [["x"]],
          }),
        }),
    );

    const { container } = render(
      <UiBlockArtifact
        artifact={{
          id: "art-retry",
          filename: "ui-block-retry.json",
          preview_url: "https://signed/expired-ui-block",
        }}
        fallback={<span>chip</span>}
      />,
    );

    expect(
      await within(container).findByText("Recovered block", {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("renders the fallback chip when the JSON is not a block we know", async () => {
    blockJson({ kind: "iframe", src: "https://evil" });
    const { container } = render(<UiBlockArtifact artifact={{ id: "art-2", filename: "ui-block-2.json" }} fallback={<span>chip</span>} />);
    await waitFor(() => expect(within(container).getByText("chip")).toBeTruthy());
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("UiBlockSkeleton", () => {
  it("names the card being drawn and carries the agent's title", () => {
    const { container } = render(<UiBlockSkeleton kind="chart" title="Signups per day" />);
    expect(within(container).getByRole("status", { name: "Drawing a chart: Signups per day" })).toBeTruthy();
    const { container: t } = render(<UiBlockSkeleton kind="table" title={null} />);
    expect(within(t).getByRole("status", { name: "Building a table" })).toBeTruthy();
  });
});

describe("UiBlockView — week plan labels + link cells", () => {
  it("posts: renders the label line above each card", () => {
    const { container } = render(
      <UiBlockView
        block={{
          kind: "posts",
          title: "Week 1",
          posts: [
            { channel: "x", payload: { text: "a" }, label: "Mon · Founder story · single post" },
            { channel: "x", payload: { text: "b" } },
          ],
        }}
      />,
    );
    expect(within(container).getByText("Mon · Founder story · single post")).toBeTruthy();
    expect(within(container).getAllByTestId("post-preview")).toHaveLength(2);
  });

  it("table: an https cell is a new-tab link, other strings stay text", () => {
    const { container } = render(
      <UiBlockView
        block={{
          kind: "table",
          title: "Last batch",
          columns: ["Post", "Impressions", "Link"],
          rows: [["Launch", 1200, "https://x.com/i/web/status/1"]],
        }}
      />,
    );
    const a = within(container).getByRole("link", { name: "open ↗" });
    expect(a.getAttribute("href")).toBe("https://x.com/i/web/status/1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toMatch(/noopener/);
    expect(within(container).getByText("Launch")).toBeTruthy();
  });
});

describe("chart colors (#38)", () => {
  beforeEach(() => {
    chartSize.on = true;
  });
  afterEach(() => {
    chartSize.on = false;
  });

  it("colors bars by sign only when the series crosses zero", () => {
    expect(barFill(18.8, true)).toBe(CHART_COLORS.positive);
    expect(barFill(-2.9, true)).toBe(CHART_COLORS.negative);
    expect(barFill(0, true)).toBe(CHART_COLORS.positive);
    expect(barFill(18.8, false)).toBe(CHART_COLORS.series);
  });

  it("never draws structure in a fixed ink that vanishes in dark mode", () => {
    for (const key of ["ink", "muted", "rule", "surface"] as const) {
      expect(CHART_COLORS[key].startsWith("rgb(var(--c-")).toBe(true);
    }
  });

  it("bar chart with negatives keeps the words-only list and signed values", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "chart", title: "YoY", variant: "bar", unit: "%", series: [{ label: "2024", value: 1.2 }, { label: "2025", value: -2.9 }] }} />,
    );
    expect(within(container).getByRole("img", { name: /bar chart: YoY/ })).toBeTruthy();
    expect(within(container).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["2024: 1.2%", "2025: -2.9%"]);
  });

  it("renders the bars green/red by sign with a zero line and no fixed ink", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "chart", title: "YoY", variant: "bar", unit: "%", series: [{ label: "2024", value: 1.2 }, { label: "2025", value: -2.9 }] }} />,
    );
    const html = container.innerHTML;
    expect(container.querySelector("svg")).toBeTruthy();
    expect(html).toContain(CHART_COLORS.positive);
    expect(html).toContain(CHART_COLORS.negative);
    expect(container.querySelector(".recharts-reference-line")).toBeTruthy();
    expect(html).not.toContain("#1f1f1f");
  });

  it("an all-positive bar chart uses the single series blue and no zero line", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "chart", title: "Signups", variant: "bar", series: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }] }} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.innerHTML).toContain(CHART_COLORS.series);
    expect(container.innerHTML).not.toContain(CHART_COLORS.negative);
    expect(container.querySelector(".recharts-reference-line")).toBeNull();
  });
});

describe("chart colors the agent asked for (#39)", () => {
  beforeEach(() => {
    chartSize.on = true;
  });
  afterEach(() => {
    chartSize.on = false;
  });

  it("uses a requested series color over the default blue", () => {
    expect(barFill(5, false, { series: "#8b5cf6" })).toBe("#8b5cf6");
  });

  it("uses requested positive/negative colors when the series crosses zero", () => {
    const colors = { positive: "#00ff00", negative: "#ff0000" };
    expect(barFill(1.2, true, colors)).toBe("#00ff00");
    expect(barFill(-2.9, true, colors)).toBe("#ff0000");
  });

  it("honors a positive/negative request even when nothing is negative", () => {
    expect(barFill(5, false, { positive: "#00ff00" })).toBe("#00ff00");
  });

  it("falls back per-field, so a partial request keeps the other default", () => {
    expect(barFill(-1, true, { positive: "#00ff00" })).toBe(CHART_COLORS.negative);
    expect(barFill(1, true, { negative: "#ff0000" })).toBe(CHART_COLORS.positive);
    expect(barFill(1, false, {})).toBe(CHART_COLORS.series);
  });

  it("draws the requested colors into the chart without changing the values", () => {
    const { container } = render(
      <UiBlockView
        block={{
          kind: "chart",
          title: "YoY",
          variant: "bar",
          unit: "%",
          series: [{ label: "2024", value: 1.2 }, { label: "2025", value: -2.9 }],
          colors: { positive: "#00ff00", negative: "#ff0000" },
        }}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain("#00ff00");
    expect(html).toContain("#ff0000");
    expect(html).not.toContain(CHART_COLORS.positive);
    expect(within(container).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["2024: 1.2%", "2025: -2.9%"]);
  });

  it("applies a requested series color to a line chart", () => {
    const { container } = render(
      <UiBlockView
        block={{ kind: "chart", title: "Trend", variant: "line", series: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }], colors: { series: "#8b5cf6" } }}
      />,
    );
    expect(container.innerHTML).toContain("#8b5cf6");
  });
});

describe("HtmlCard — a card a script was going to draw (#39)", () => {
  const blankBlock = {
    kind: "html" as const,
    title: "Tesla Revenue — Year-over-Year Growth",
    html:
      '<!DOCTYPE html><html><body><div>Tesla Revenue</div>' +
      '<svg id="c" width="580" height="410"></svg></body></html>',
    height: 460,
  };

  it("says why it is empty instead of rendering a blank frame", () => {
    const { container } = render(<UiBlockView block={blankBlock} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toMatch(/needed a script to draw itself/i);
    expect(container.textContent).toMatch(/ask for it as a chart/i);
  });

  it("still renders a card that actually drew something", () => {
    const { container } = render(
      <UiBlockView
        block={{
          kind: "html",
          title: "Funnel",
          html: '<svg width="100" height="50"><rect width="20" height="40" fill="#3b82f6"/></svg>',
        }}
      />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("leaves a scripts-enabled workspace alone — the script is still there to draw", () => {
    const { container } = render(<UiBlockView block={{ ...blankBlock, scripts: true }} />);
    expect(container.querySelector("iframe")).toBeTruthy();
  });
});

describe("UiBlockArtifact — Open analysis", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const table = { kind: "table", title: "Sign-ups per month", columns: ["Month", "Sign-ups"], rows: [["July", 1587]] };

  it("offers Open analysis on a data card and hands back its title", async () => {
    blockJson(table);
    const onOpen = vi.fn();
    const { findByRole } = render(
      <UiBlockArtifact artifact={{ id: "a1", filename: "ui-block-1.json" }} fallback={null} onOpenAnalysis={onOpen} />,
    );
    (await findByRole("button", { name: "Open report" })).click();
    expect(onOpen).toHaveBeenCalledWith("Sign-ups per month");
  });

  it("has no button where no pane can dock", async () => {
    blockJson(table);
    const { findByText, queryByRole } = render(
      <UiBlockArtifact artifact={{ id: "a2", filename: "ui-block-1.json" }} fallback={null} />,
    );
    await findByText("Sign-ups per month");
    expect(queryByRole("button", { name: "Open report" })).toBeNull();
  });

  it("does not offer it on a posts card", async () => {
    blockJson({ kind: "posts", title: "Drafts", posts: [{ channel: "x", payload: { text: "hi" } }] });
    const { findByText, queryByRole } = render(
      <UiBlockArtifact artifact={{ id: "a3", filename: "ui-block-1.json" }} fallback={null} onOpenAnalysis={vi.fn()} />,
    );
    await findByText("Drafts");
    expect(queryByRole("button", { name: "Open report" })).toBeNull();
  });

  it("expanded chart shows its numbers as a visible table", () => {
    const { container } = render(
      <UiBlockView
        block={{ kind: "chart", title: "Bookings", variant: "bar", series: [{ label: "Jul", value: 120 }] }}
        frame={{ expanded: true }}
      />,
    );
    const cells = within(container).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(["Jul", "120"]);
  });
});

describe("TableCard — number-looking text", () => {
  it("right-aligns '1,587' and '11.3%' like numbers, not labels", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "table", title: "t", columns: ["Month", "Sign-ups", "Rate"], rows: [["July", "1,587", "11.3%"]] }} />,
    );
    expect(within(container).getByText("1,587").className).toMatch(/text-right/);
    expect(within(container).getByText("11.3%").className).toMatch(/text-right/);
    expect(within(container).getByText("July").className).not.toMatch(/text-right/);
    cleanup();
  });
});

describe("TableCard — footnote and header alignment", () => {
  it("right-aligns a number column's header and shows the note", () => {
    const { container } = render(
      <UiBlockView block={{ kind: "table", title: "t", columns: ["Month", "Sign-ups"], rows: [["September*", "1,853"]], note: "*Sep 1-25 only." }} />,
    );
    const [month, signups] = within(container).getAllByRole("columnheader");
    expect(signups.className).toMatch(/text-right/);
    expect(month.className).not.toMatch(/text-right/);
    expect(within(container).getByText("*Sep 1-25 only.")).toBeTruthy();
    cleanup();
  });
});

describe("UiBlockArtifact — opens its report by itself until closed", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const table = { kind: "table", title: "Sign-ups per month", columns: ["Month", "Sign-ups"], rows: [["July", 1587]] };

  it("opens again after a remount, and not after the viewer closed it", async () => {
    blockJson(table);
    const onOpen = vi.fn();
    const first = render(
      <UiBlockArtifact artifact={{ id: "auto-1", filename: "f" }} fallback={null} onOpenAnalysis={onOpen} autoOpen />,
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = render(<UiBlockArtifact artifact={{ id: "auto-1", filename: "f" }} fallback={null} onOpenAnalysis={onOpen} autoOpen />);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
    second.unmount();
    dismissReport("auto-1");
    render(<UiBlockArtifact artifact={{ id: "auto-1", filename: "f" }} fallback={null} onOpenAnalysis={onOpen} autoOpen />);
    await new Promise((r) => setTimeout(r, 20));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("opens for a teammate link even if closed before and not auto", async () => {
    blockJson(table);
    dismissReport("linked-1");
    window.history.replaceState(null, "", "/workspace/t?report=linked-1");
    const onOpen = vi.fn();
    render(<UiBlockArtifact artifact={{ id: "linked-1", filename: "f" }} fallback={null} onOpenAnalysis={onOpen} />);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    window.history.replaceState(null, "", "/");
  });

  it("does not open by itself unless asked", async () => {
    blockJson(table);
    const onOpen = vi.fn();
    const { findByText } = render(
      <UiBlockArtifact artifact={{ id: "auto-2", filename: "f" }} fallback={null} onOpenAnalysis={onOpen} />,
    );
    await findByText("Sign-ups per month");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("provenance on chart and KPI cards (data-analyst PR 4)", () => {
  afterEach(cleanup);
  const receipt = {
    source: "stripe",
    metric_id: "net_revenue",
    definition: "Charges minus refunds and fees.",
    window: { since: "2026-09-01", until: "2026-09-03" },
    tz: "America/Los_Angeles",
    currency: "USD",
    fetched_at: "2026-09-04T16:12:00.000Z",
  };

  it("a verified chart shows source, as of, window, compare and goal toggles, and a receipt chip", () => {
    const { container } = render(
      <UiBlockView
        block={{
          kind: "chart",
          title: "Daily net revenue",
          variant: "line",
          unit: "$",
          series: [
            { label: "2026-09-01", value: 1200 },
            { label: "2026-09-02", value: 1400 },
            { label: "2026-09-03", value: 1500 },
          ],
          compare: [
            { label: "2026-08-01", value: 1100 },
            { label: "2026-08-02", value: 1300 },
            { label: "2026-08-03", value: 1350 },
          ],
          goal: 1500,
          verified: true,
          result_id: "m_0123456789",
          receipt,
          as_of: receipt.fetched_at,
          window: receipt.window,
        }}
      />,
    );
    const prov = within(container).getByTestId("chart-provenance");
    expect(prov.textContent).toContain("Stripe");
    expect(prov.textContent).toContain("As of");
    expect(prov.textContent).toContain("Sep 1-3, America/Los_Angeles");
    expect(within(container).getByText(/Compared with Aug 1-3/)).toBeTruthy();
    expect(within(container).getByText(/Goal \$1,500, typed by Zavi/)).toBeTruthy();
    expect(within(container).getByTestId("receipt-chip").textContent).toContain("Stripe");
  });

  it("a chart the model typed is marked unverified, and a pre-PR-3 chart carries neither", () => {
    const typed = render(
      <UiBlockView block={{ kind: "chart", title: "Typed", variant: "bar", series: [{ label: "a", value: 1 }], verified: false }} />,
    );
    expect(within(typed.container).getByTestId("unverified-chip")).toBeTruthy();
    cleanup();
    const legacy = render(<UiBlockView block={{ kind: "chart", title: "Old", variant: "bar", series: [{ label: "a", value: 1 }] }} />);
    expect(within(legacy.container).queryByTestId("unverified-chip")).toBeNull();
    expect(within(legacy.container).queryByTestId("receipt-chip")).toBeNull();
    expect(within(legacy.container).queryByTestId("chart-provenance")).toBeNull();
  });

  it("KPI items carry their own chip; an ad spend delta stays neutral grey", () => {
    const { container } = render(
      <UiBlockView
        block={{
          kind: "kpi",
          title: "Last week",
          verified: false,
          items: [
            { label: "Revenue", value: 10640, delta: "+1.5% vs prior period", tone: "up", verified: true, result_id: "m_0123456789", receipt },
            { label: "Ad spend", value: 6240, delta: "+12% vs prior period", tone: "up", verified: true, result_id: "m_0123456780", receipt: { ...receipt, metric_id: "meta_ad_spend", source: "meta_ads" } },
            { label: "Typed", value: "$5K", verified: false },
          ],
        }}
      />,
    );
    expect(within(container).getAllByTestId("receipt-chip")).toHaveLength(2);
    expect(within(container).getByTestId("unverified-chip")).toBeTruthy();
    expect(within(container).getByText("+12% vs prior period").className).toContain("text-inkMuted");
    expect(within(container).getByText("+1.5% vs prior period").className).not.toContain("text-inkMuted");
  });
});
