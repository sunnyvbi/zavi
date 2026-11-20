
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "./dashboard-ui";

let mockState: DashboardState<unknown>;
vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>(
    "./dashboard-ui",
  );
  return {
    ...actual,
    useAgentDashboard: () => mockState,
  };
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

import { ResearchDashboard, trustLine } from "./ResearchDashboard";

const DAY = 24 * 60 * 60 * 1000;

function answeredRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    run_id: "r1",
    status: "answered",
    query: "Tear down Turo pricing & plans",
    template: "competitor-teardown",
    generated_at: new Date(Date.now() - 2 * DAY).toISOString(),
    sources_count: 14,
    validation_mix: {
      validated: 2,
      inferred: 1,
      assumption: 0,
      high_risk: 1,
      total: 4,
    },
    has_pdf: true,
    artifact: { id: "a1", filename: "turo.pdf" },
    report: {
      kind: "report",
      title: "Turo — pricing & plans",
      template: "competitor-teardown",
      subtitle: "5 players · 14 sources",
      query: "Tear down Turo pricing & plans",
      blocks: [
        {
          type: "exec_summary",
          bottom_line: "Turo is consolidating premium positioning[1].",
          prose_md: "Pricing[1] and positioning[2] both moved up.",
        },
        {
          type: "competitive_table",
          rows: [
            {
              brand: "Turo",
              price: "15-40% host fee",
              positioning: "premium",
              gap: "operator tooling thin",
            },
          ],
        },
        {
          type: "recommendations",
          items: [
            {
              index: 1,
              label: "Do this first",
              title: "Lean into host economics",
              body_md: "Quantify the gap in outreach copy.",
            },
          ],
        },
        {
          type: "risks",
          items: [{ tone: "warn", title: "Single-tier move", body_md: "Don't over-generalize." }],
        },
      ],
      lenses: [
        {
          lens: "pricing",
          label: "Pricing",
          state: "done",
          takeaways: ["fee is 15-40%"],
          provenance: { fetched_urls: ["turo.com"], fetch_errors: 0, poisoned: false },
        },
      ],
      sources: [
        {
          n: 1,
          title: "Turo pricing page",
          url: "https://turo.com/pricing",
          accessed_at: "2 days ago",
          source_type: "official",
          capture_status: "rendered",
        },
      ],
      validation: [
        { tier: "validated", text: "fee is 15-40%" },
        { tier: "validated", text: "plans confirmed" },
        { tier: "inferred", text: "positioning premium" },
        { tier: "high-risk", text: "stale figure" },
      ],
      failed_lenses: [],
      generated_at: new Date(Date.now() - 2 * DAY).toISOString(),
    },
    questions: null,
    ...over,
  };
}

function needsRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    run_id: "r-needs",
    status: "needs_you",
    query: "Should we add a delivery option?",
    template: "freeform",
    generated_at: new Date(Date.now() - 1 * DAY).toISOString(),
    sources_count: 0,
    validation_mix: { validated: 0, inferred: 0, assumption: 0, high_risk: 0, total: 0 },
    has_pdf: false,
    artifact: null,
    report: null,
    questions: [
      { question: "Delivery for which product line?", why: "changes the competitive set" },
      { question: "Deliver the car, or in-person handoff?", why: "different ops" },
    ],
    ...over,
  };
}

function runningRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    run_id: "r-running",
    status: "running",
    query: "Compare Getaround vs Turo host economics",
    template: "competitor-teardown",
    generated_at: new Date(Date.now() - 60 * 1000).toISOString(),
    sources_count: 0,
    validation_mix: { validated: 0, inferred: 0, assumption: 0, high_risk: 0, total: 0 },
    has_pdf: false,
    artifact: null,
    report: null,
    questions: null,
    ...over,
  };
}

function payload(over: Partial<Record<string, unknown>> = {}) {
  return {
    generic: false,
    kpis: {
      reports_produced: 37,
      sources_cited: 412,
      pdfs_generated: 29,
      last_researched: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    requests: [answeredRow()],
    ...over,
  };
}

function stateOf(data: unknown): DashboardState<unknown> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    refresh: () => {},
    newRowIds: new Set<string>(),
  };
}

beforeEach(() => {
  mockState = stateOf(payload());
});

describe("ResearchDashboard — Research Inbox", () => {
  it("renders KPI values from the wire", () => {
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("Reports produced");
    expect(html).toContain("37");
    expect(html).toContain("412");
  });

  it("an answered request default-expands to show trust line, so-what, a found-block, and numbered recommendations", () => {
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("Tear down Turo pricing &amp; plans");
    expect(html).toContain("From your analyst");
    expect(html).toContain("Mostly validated");
    expect(html).toContain("So what: bottom line");
    expect(html).toContain("Turo is consolidating premium positioning");
    expect(html).toContain("What the research found");
    expect(html).toContain("Competitive landscape");
    expect(html).toContain("operator tooling thin");
    expect(html).toContain("What to do next");
    expect(html).toContain("Lean into host economics");
    expect(html).toContain("Sources (1)");
    expect(html).toContain("How I checked");
  });

  it("a needs_you request shows the questions + answer-in-chat", () => {
    mockState = stateOf(payload({ requests: [needsRow()] }));
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("Needs you · 1");
    expect(html).toContain("Should we add a delivery option?");
    expect(html).toContain("Delivery for which product line?");
    expect(html).toContain("Answer in chat to run this");
  });

  it("a running request shows the researching line", () => {
    mockState = stateOf(payload({ requests: [runningRow()] }));
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("Researching… checking angles");
    expect(html).toContain("All clear");
  });

  it("the feed banner is amber 'Needs you · N' when any clarification is pending", () => {
    mockState = stateOf(payload({ requests: [answeredRow(), needsRow()] }));
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("Needs you · 1");
  });

  it("rows are real <button> disclosures with aria-expanded; status is not color-only", () => {
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("aria-controls=");
    expect(html).toContain("Answered");
    expect(html).toContain("✓");
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label=\"Validation mix:");
  });

  it("shows the empty state when there are no requests", () => {
    mockState = stateOf(payload({ requests: [] }));
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("No research yet");
  });

  it("shows the generic fallback when payload is generic", () => {
    mockState = stateOf(payload({ generic: true }));
    const html = renderToStaticMarkup(<ResearchDashboard />);
    expect(html).toContain("No research yet");
  });
});

describe("trustLine — deterministic spoken trust sentence (no LLM)", () => {
  const mix = (over: Partial<Record<string, number>> = {}) => ({
    validated: 0,
    inferred: 0,
    assumption: 0,
    high_risk: 0,
    total: 0,
    ...over,
  });

  it("validated-heavy → 'Mostly validated…'", () => {
    const line = trustLine(
      mix({ validated: 3, inferred: 1, total: 4 }),
      [],
      false,
    );
    expect(line).toContain("Mostly validated");
    expect(line).toContain("75%");
  });

  it("failed_lenses > 0 → includes the failed-angle caveat", () => {
    const line = trustLine(
      mix({ validated: 3, total: 4, inferred: 1 }),
      ["releases"],
      false,
    );
    expect(line).toContain("research angle");
    expect(line).toContain("releases");
  });

  it("stale → includes the age caveat", () => {
    const line = trustLine(mix({ validated: 4, total: 4 }), [], true);
    expect(line).toContain("over a month old");
  });

  it("weak-heavy → reads with caution and surfaces high-risk count", () => {
    const line = trustLine(
      mix({ assumption: 2, high_risk: 1, total: 3 }),
      [],
      false,
    );
    expect(line).toContain("Read with caution");
    expect(line).toContain("high-risk");
  });

  it("0% validated but not weak (mostly inferred) → 'Lightly sourced', never the contradictory 'Partly validated — 0%'", () => {
    const line = trustLine(mix({ inferred: 4, total: 4 }), [], false);
    expect(line).toContain("Lightly sourced");
    expect(line).not.toContain("Partly validated");
    expect(line).not.toMatch(/0% of claims are well-sourced/);
  });

  it("low-but-nonzero validated → 'Lightly sourced — only N%'", () => {
    const line = trustLine(
      mix({ validated: 1, inferred: 3, total: 4 }),
      [],
      false,
    );
    expect(line).toContain("Lightly sourced");
    expect(line).toContain("25%");
  });
});
