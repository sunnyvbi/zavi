import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "./dashboard-ui";

let mockState: DashboardState<unknown>;
vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>("./dashboard-ui");
  return { ...actual, useAgentDashboard: () => mockState };
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab: () => {} }),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => children ?? null,
  LineChart: ({ children }: { children?: React.ReactNode }) => children ?? null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

import { SeoGeoDashboard } from "./SeoGeoDashboard";

function payload(over: Record<string, unknown> = {}) {
  return {
    generic: false,
    connected: true,
    site_url: "sc-domain:example.com",
    start_date: "2026-08-05",
    end_date: "2026-09-01",
    totals: { clicks: 1240, impressions: 51200, ctr: 0.0242, position: 6.3 },
    series: [
      { date: "2026-08-05", clicks: 40, impressions: 1800 },
      { date: "2026-09-01", clicks: 55, impressions: 2100 },
    ],
    top_queries: [
      { key: "best widgets", clicks: 120, impressions: 4000, ctr: 0.03, position: 4.2 },
    ],
    top_pages: [
      { key: "https://example.com/pricing?ref=x", clicks: 90, impressions: 3000, ctr: 0.03, position: 5.1 },
    ],
    site_health: null,
    ...over,
  };
}

function health(over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    site: "https://example.com",
    error_code: null,
    fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    stale: false,
    pages_analyzed: 2,
    findings: [
      {
        code: "schema_absent",
        severity: "medium",
        summary: "No structured data (Schema.org JSON-LD) was found on any page checked.",
        urls: ["https://example.com/", "https://example.com/pricing"],
      },
      {
        code: "noindex",
        severity: "blocker",
        summary: "Every page checked asks search engines not to index it.",
        urls: ["https://example.com/"],
      },
    ],
    pages: [
      {
        url: "https://example.com/",
        status: 200,
        title: "Example — widgets for teams",
        title_length: 28,
        meta_description: null,
        canonical: "https://example.com/",
        h1_count: 1,
        schema_types: [],
        noindex: true,
        visible_words: 812,
      },
      {
        url: "https://example.com/pricing",
        status: 200,
        title: null,
        title_length: null,
        meta_description: null,
        canonical: null,
        h1_count: 0,
        schema_types: ["Organization"],
        noindex: false,
        visible_words: 240,
      },
    ],
    notes: [],
    ...over,
  };
}

function stateOf(data: unknown, over: Partial<DashboardState<unknown>> = {}): DashboardState<unknown> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    refresh: () => {},
    newRowIds: new Set<string>(),
    ...over,
  };
}

beforeEach(() => {
  mockState = stateOf(payload());
});

describe("SeoGeoDashboard — Search Console lane", () => {
  it("renders KPIs, trend section, and top queries/pages", () => {
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("1,240");
    expect(html).toContain("51,200");
    expect(html).toContain("2.4%");
    expect(html).toContain("6.3");
    expect(html).toContain("28-day trend");
    expect(html).toContain("best widgets");
    expect(html).toContain("/pricing?ref=x");
    expect(html).toContain("sc-domain:example.com");
  });

  it("shows a retryable error state on load_error", () => {
    mockState = stateOf({ generic: false, connected: true, load_error: true });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Couldn&#x27;t reach Google Search Console");
    expect(html).toContain("Retry");
  });

  it("shows the no-data empty state when the window has zero impressions", () => {
    mockState = stateOf(
      payload({
        totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
        series: [],
        top_queries: [],
        top_pages: [],
      }),
    );
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("No search data yet");
    expect(html).not.toContain("28-day trend");
  });

  it("renders the loading shell while fetching", () => {
    mockState = stateOf(null, { loading: true });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Loading dashboard");
  });

  it("renders the generic placeholder for a generic payload", () => {
    mockState = stateOf({ generic: true });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("coming online");
  });
});

describe("SeoGeoDashboard — connector-free site health", () => {
  it("renders findings instead of the connect blackout when GSC is absent", () => {
    mockState = stateOf({ generic: false, connected: false, site_health: health() });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);

    expect(html).not.toContain("SEO isn&#x27;t connected yet");
    expect(html).toContain("Site health");
    expect(html).toContain("asks search engines not to index it");
    expect(html).toContain("No structured data");
    expect(html).toContain("Blocker");
    expect(html).toContain("Medium");
    expect(html).not.toContain("28-day trend");
  });

  it("ranks a blocker above a medium regardless of fixture order", () => {
    mockState = stateOf({ generic: false, connected: false, site_health: health() });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html.indexOf("not to index it")).toBeLessThan(html.indexOf("No structured data"));
  });

  it("shows the per-page fact table with its provenance disclaimer", () => {
    mockState = stateOf({ generic: false, connected: false, site_health: health() });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Pages checked");
    expect(html).toContain("Example — widgets for teams");
    expect(html).toContain("28ch");
    expect(html).toContain("Organization");
    expect(html).toContain("noindex");
    expect(html).toContain("812");
    expect(html).toContain("not how they");
  });

  it("offers Search Console as an addition, not a gate, when it is missing", () => {
    mockState = stateOf({ generic: false, connected: false, site_health: health() });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Connect Google Search Console");
    expect(html).toContain("real clicks, impressions, CTR");
  });

  it("renders both lanes when Search Console IS connected", () => {
    mockState = stateOf(payload({ site_health: health() }));
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("28-day trend");
    expect(html).toContain("Site health");
    expect(html.indexOf("28-day trend")).toBeLessThan(html.indexOf("Site health"));
    expect(html).not.toContain("Connect Google Search Console");
  });

  it("celebrates a clean audit rather than showing an empty list", () => {
    mockState = stateOf({
      generic: false,
      connected: false,
      site_health: health({ findings: [] }),
    });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("No issues");
    expect(html).toContain("Nothing here is blocking you.");
    expect(html).toContain("Pages checked");
  });

  it("asks for a site URL when there is none on file", () => {
    mockState = stateOf({
      generic: false,
      connected: false,
      site_health: health({
        status: "error",
        error_code: "seo_site_unknown",
        site: null,
        findings: [],
        pages: [],
      }),
    });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("No website on file yet");
    expect(html).toContain("Add your site URL");
    expect(html).not.toContain("Pages checked");
  });

  it("explains an unreachable site instead of a bare connect prompt", () => {
    mockState = stateOf({
      generic: false,
      connected: false,
      site_health: health({
        status: "error",
        error_code: "seo_site_unreachable",
        findings: [],
        pages: [],
      }),
    });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Couldn&#x27;t read your site");
    expect(html).toContain("https://example.com");
  });

  it("surfaces partial-crawl notes", () => {
    mockState = stateOf({
      generic: false,
      connected: false,
      site_health: health({
        notes: ["The crawl hit its time budget, so not every page was checked."],
      }),
    });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("hit its time budget");
  });

  it("flags a served-stale audit so old data never reads as a fresh check", () => {
    mockState = stateOf({
      generic: false,
      connected: false,
      site_health: health({ stale: true }),
    });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("couldn&#x27;t re-check just now");
  });

  it("keeps the full blackout only when there is genuinely nothing to show", () => {
    mockState = stateOf({ generic: false, connected: false, site_health: null });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("SEO isn&#x27;t connected yet");
    expect(html).toContain("Connect");
    expect(html).not.toContain("28-day trend");
    expect(html).not.toContain("Site health");
  });
});

describe("SeoGeoDashboard — the field and lab lanes", () => {
  const performance = {
    field: {
      state: "ok" as const,
      scope: "origin" as const,
      metrics: {
        largest_contentful_paint: { p75: 3600 },
        interaction_to_next_paint: { p75: 389 },
        cumulative_layout_shift: { p75: 0.34 },
      },
    },
    lab: {
      state: "ok" as const,
      pages: [
        {
          requested_url: "https://example.com/",
          final_url: "https://example.com/",
          strategy: "mobile",
          lighthouse_version: "13.4.1",
          fetch_time: "2026-09-14T00:00:00Z",
          categories: [
            { id: "performance", title: "Performance", score: 0.42 },
            { id: "seo", title: "SEO", score: 0.92 },
          ],
          agentic_browsing: null,
          opportunities: [
            {
              id: "mainthread-work-breakdown",
              title: "Minimise main-thread work",
              score: 0.3,
              metricSavings: [{ metric: "TBT", value: 1150, unit: "ms" as const }],
              savingsMs: null,
              savingsBytes: null,
            },
            {
              id: "layout-shifts",
              title: "Avoid large layout shifts",
              score: 0,
              metricSavings: [{ metric: "CLS", value: 0.318, unit: "score" as const }],
              savingsMs: null,
              savingsBytes: null,
            },
          ],
        },
      ],
    },
    agent_readiness: {
      checks: [
        {
          id: "llms_txt" as const,
          label: "Publishes an llms.txt file",
          state: "fail" as const,
          detail: "No /llms.txt at the site root.",
        },
        {
          id: "layout_stable" as const,
          label: "Layout stays put while loading",
          state: "unknown" as const,
          detail: "Google has no layout-shift reading for this site yet.",
        },
      ],
      passed: 0,
      applicable: 1,
    },
    fetched_at: "2026-09-14T00:00:00Z",
  };

  it("renders nothing new when the backend sent no performance field", () => {
    mockState = stateOf(payload({ site_health: health() }));
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).not.toContain("What real visitors got");
    expect(html).not.toContain("Lab run");
    expect(html).toContain("28-day trend");
    expect(html).toContain("Site health");
  });

  it("adds the vitals, the dials and the wins WITHOUT touching the other lanes", () => {
    mockState = stateOf(payload({ site_health: health(), performance }));
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("What real visitors got");
    expect(html).toContain("3.6 s");
    expect(html).toContain("Lab run");
    expect(html).toContain("Speed");
    expect(html).toContain("Biggest wins on this page");
    expect(html).toContain("1.1 s");
    expect(html).toContain("0.32");
    expect(html).not.toContain("0.32 ms");
    expect(html).toContain("Can an AI agent use the site?");
    expect(html).toContain("of 1 we could check");
    expect(html).toContain("28-day trend");
    expect(html).toContain("Site health");
    expect(html).toContain("Pages checked");
  });

  it("says it is measuring while the background read runs, without blocking the tab", () => {
    mockState = stateOf(
      payload({ site_health: health(), performance: { warming: true } }),
    );
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Measuring your site now");
    expect(html).toContain("Running the page test now");
    expect(html).not.toContain("Google has not seen enough visitors");
    expect(html).toContain("28-day trend");
    expect(html).toContain("Site health");
  });

  it("renders on a tenant with no Search Console, where the crawl leads", () => {
    mockState = stateOf({
      generic: false,
      connected: false,
      site_health: health(),
      performance: { field: { state: "no_data" as const } },
    });
    const html = renderToStaticMarkup(<SeoGeoDashboard />);
    expect(html).toContain("Google has not seen enough visitors");
    expect(html).toContain("Site health");
    expect(html).toContain("Connect Google Search Console");
  });
});
