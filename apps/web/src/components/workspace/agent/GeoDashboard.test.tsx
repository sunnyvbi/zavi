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

import { GeoDashboard } from "./GeoDashboard";

function geo(over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    site: "https://example.com",
    error_code: null,
    fetched_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    stale: false,
    notes: [],
    pages_analyzed: 2,
    score: {
      total: 58,
      bands: [
        {
          key: "citability",
          label: "Passage citability",
          weight: 25,
          score: 40,
          note: "Is there a self-contained answer, near the top?",
        },
        {
          key: "technical",
          label: "Technical accessibility",
          weight: 20,
          score: 80,
          note: "Content survives a JavaScript-free fetch.",
        },
      ],
    },
    crawlers: [
      {
        name: "GPTBot",
        owner: "OpenAI",
        obeys_robots: true,
        recommended: true,
        state: "blocked",
        directive: "Disallow: /",
        from_wildcard: false,
      },
      {
        name: "PerplexityBot",
        owner: "Perplexity",
        obeys_robots: true,
        recommended: true,
        state: "allowed",
        directive: null,
        from_wildcard: false,
      },
      {
        name: "Google-Extended",
        owner: "Google",
        obeys_robots: true,
        recommended: false,
        state: "blocked",
        directive: "Disallow: /",
        from_wildcard: true,
        caveat: "Blocking it does NOT remove you from AI Overviews.",
      },
    ],
    llms_txt: false,
    findings: [
      {
        code: "no_specific_figures",
        severity: "medium",
        summary: "2 page(s) state no specific figure.",
        urls: ["https://example.com/", "https://example.com/pricing"],
      },
      {
        code: "ai_crawler_blocked",
        severity: "blocker",
        summary: "robots.txt blocks GPTBot from the whole site.",
        urls: ["/robots.txt"],
      },
    ],
    pages: [
      {
        url: "https://example.com/",
        visible_words: 820,
        server_rendered: true,
        lead_passage_words: 148,
        lead_in_band: true,
        question_headings: 2,
        heading_count: 5,
        figure_sentences: 0,
        has_author: false,
        age_days: 42,
        schema_types: ["Organization"],
      },
      {
        url: "https://example.com/app",
        visible_words: 11,
        server_rendered: false,
        lead_passage_words: null,
        lead_in_band: false,
        question_headings: 0,
        heading_count: 0,
        figure_sentences: 0,
        has_author: false,
        age_days: null,
        schema_types: [],
      },
    ],
    not_checked: [
      "Whether you are actually cited in AI Overviews, AI Mode, ChatGPT or Perplexity. No API from anyone returns that.",
      "Off-site entity presence (Wikipedia, Reddit, YouTube, LinkedIn).",
    ],
    ...over,
  };
}

function state(data: unknown): DashboardState<unknown> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    refresh: () => {},
    newRowIds: new Set<string>(),
  };
}

const render = () => renderToStaticMarkup(<GeoDashboard />);

beforeEach(() => {
  mockState = state({ generic: false, geo: geo() });
});

describe("GeoDashboard — the connector-free contract", () => {
  it("renders the full panel with nothing connected", () => {
    const html = render();
    expect(html).toContain("AI-search readiness");
    expect(html).toContain("58");
    expect(html).toContain("AI crawler access");
  });

  it("NEVER offers a Connect state, because there is nothing to connect", () => {
    const html = render();
    expect(html).not.toMatch(/isn&#x27;t connected yet|isn't connected yet/);
    expect(html).not.toMatch(/Connect the source/);
  });

  it("labels the score as a heuristic where the number is, not in a footnote", () => {
    const html = render();
    expect(html).toMatch(/Our own heuristic, not a Google signal/);
    expect(html).toMatch(/how citable this site is, never how often it is actually cited/);
  });

  it("lists what it could not check as part of the report", () => {
    const html = render();
    expect(html).toContain("What this can");
    expect(html).toContain("No API from anyone returns that");
  });
});

describe("GeoDashboard — findings and crawlers", () => {
  it("sorts findings blocker-first regardless of payload order", () => {
    const html = render();
    expect(html.indexOf("robots.txt blocks GPTBot")).toBeLessThan(
      html.indexOf("state no specific figure"),
    );
  });

  it("quotes the robots.txt directive a verdict was read from", () => {
    const html = render();
    expect(html).toContain("Disallow: /");
    expect(html).toContain("via User-agent: *");
  });

  it("says allowed-by-default rather than implying a rule exists", () => {
    expect(render()).toContain("No rule names it");
  });

  it("carries the Google-Extended caveat next to its Blocked pill", () => {
    expect(render()).toContain("does NOT remove you from AI Overviews");
  });

  it("reports llms.txt absence as a non-issue, not a fix", () => {
    const html = render();
    expect(html).toContain("does not affect citation");
    expect(html).toMatch(/Search\s*ignores/);
  });

  it("marks a JS-only page in the page table", () => {
    expect(render()).toContain("JS-only");
  });
});

describe("GeoDashboard — degraded states", () => {
  it("asks for a site URL when there is none on file — never for a connector", () => {
    mockState = state({
      generic: false,
      geo: geo({ status: "error", error_code: "seo_site_unknown", site: null }),
    });
    const html = render();
    expect(html).toContain("No website on file yet");
    expect(html).toContain("Add your site URL");
    expect(html).toMatch(/there isn&#x27;t one to connect|there isn't one to connect/);
  });

  it("distinguishes an unreachable site from a missing URL", () => {
    mockState = state({
      generic: false,
      geo: geo({ status: "error", error_code: "seo_site_unreachable" }),
    });
    const html = render();
    expect(html).toContain("Couldn");
    expect(html).toContain("https://example.com");
    expect(html).toContain("Retry");
  });

  it("falls back to the generic placeholder when the payload has no geo lane", () => {
    mockState = state({ generic: false, geo: null });
    expect(render()).toContain("No website on file yet");
  });

  it("says nothing is blocking when the crawl found no issues", () => {
    mockState = state({ generic: false, geo: geo({ findings: [] }) });
    const html = render();
    expect(html).toContain("Nothing blocking a citation");
    expect(html).toMatch(/readiness, not proof of a citation/);
  });

  it("flags a stale served audit rather than passing it off as current", () => {
    mockState = state({ generic: false, geo: geo({ stale: true }) });
    expect(render()).toContain("couldn");
  });
});

describe("GeoDashboard — provenance", () => {
  it("states no AI-visibility, citation or traffic number anywhere on the panel", () => {
    const html = render();
    for (const banned of [
      "share of voice",
      "citations per",
      "AI traffic",
      "AI referrals",
      "appear in",
      "impressions",
      "click-through",
    ]) {
      expect(html.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("GeoDashboard — coverage is as loud as the score", () => {
  it("says how many pages the score rests on, next to the score", () => {
    const html = render();
    expect(html).toMatch(/Read 2 pages/);
    expect(html).toMatch(/this score does not include/);
  });

  it("counts one page in the singular", () => {
    mockState = state({ generic: false, geo: geo({ pages_analyzed: 1 }) });
    expect(render()).toMatch(/Read 1 page\./);
  });

  it("links the coverage line to the section that lists the gaps", () => {
    const html = render();
    expect(html).toContain('href="#geo-not-checked"');
    expect(html).toContain('id="geo-not-checked"');
  });

  it("prints Not measured rather than 0 when no page could be read", () => {
    mockState = state({
      generic: false,
      geo: geo({
        pages_analyzed: 0,
        score: { total: 0, bands: [] },
      }),
    });
    const html = render();
    expect(html).toContain("Not measured");
    expect(html).toMatch(/it did not take them/);
    expect(html).not.toContain("/ 100");
  });

  it("drops the band breakdown when there is no coverage behind it", () => {
    mockState = state({
      generic: false,
      geo: geo({ pages_analyzed: 0 }),
    });
    expect(render()).not.toContain("Passage citability");
  });

  it("does not call a zero-coverage panel clean in the findings section", () => {
    mockState = state({
      generic: false,
      geo: geo({ pages_analyzed: 0, findings: [], score: { total: 0, bands: [] } }),
    });
    const html = render();
    expect(html).toContain("Nothing was checked yet");
    expect(html).toMatch(/not\s+a clean bill of health/);
    expect(html).not.toContain("Nothing blocking a citation");
  });

  it("still reports a clean result when pages WERE read and found nothing", () => {
    mockState = state({ generic: false, geo: geo({ findings: [] }) });
    const html = render();
    expect(html).toContain("Nothing blocking a citation");
    expect(html).not.toContain("Nothing was checked yet");
  });

  it("treats a stringy page count as no coverage rather than coercing it", () => {
    mockState = state({
      generic: false,
      geo: geo({ pages_analyzed: "2" as unknown as number }),
    });
    expect(render()).toContain("Not measured");
  });
});
