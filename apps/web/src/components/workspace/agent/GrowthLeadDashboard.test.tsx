
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspace: () => ({
    openTab: () => {},
    seedComposer: () => {},
  }),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

vi.mock("./dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-ui")>();
  return {
    ...actual,
    AttentionList: () => null,
    useAgentDashboard: () => ({
      data: {
        generic: false,
        connected: true,
        funnel: {
          connected: true,
          diagnosis_source: "product_events",
          window: "last 30d",
          total_events_in_window: 5400,
          steps: [
            {
              event: "signup",
              count: 1000,
              conversion_from_top: 100,
              conversion_from_prev: null,
              drop_from_prev_pct: null,
              is_bottleneck: false,
            },
            {
              event: "activated",
              count: 400,
              conversion_from_top: 40,
              conversion_from_prev: 40,
              drop_from_prev_pct: 60,
              is_bottleneck: true,
            },
          ],
          top_of_funnel_count: 1000,
          bottleneck: {
            stage: "activated",
            from_stage: "signup",
            conversion_from_prev: 40,
            drop_pct: 60,
          },
        },
        cohorts: {
          connected: true,
          currency: "usd",
          rows: [
            {
              cohort: "Jun 19",
              signups: 118,
              revenue: 2342,
              revenue_per_signup: 19.85,
              payback_ratio: 1.41,
            },
            {
              cohort: "May 13",
              signups: 171,
              revenue: 1915,
              revenue_per_signup: 11.2,
              payback_ratio: 0.92,
            },
            {
              cohort: "Apr 1",
              signups: 170,
              revenue: 732,
              revenue_per_signup: 4.31,
              payback_ratio: 0.37,
            },
          ],
        },
        bets: [
          {
            id: "bet-1",
            kind: "budget",
            claim: "Shift $500/wk from Meta to founder-led LinkedIn",
            from_channel: "Meta",
            to_channel: "LinkedIn",
            amount_usd: 500,
            amount_qualitative: false,
            confidence: "high",
            status: "proposed",
            emitted_at: "2026-06-19T00:00:00Z",
          },
          {
            id: "bet-2",
            kind: "lifecycle",
            claim: "Add a day-3 activation email",
            from_channel: null,
            to_channel: "email",
            amount_usd: null,
            amount_qualitative: true,
            confidence: "medium",
            status: "acted",
            emitted_at: "2026-06-18T00:00:00Z",
          },
        ],
        attention: [],
      },
      loading: false,
      refreshing: false,
      error: null,
      refresh: () => {},
      newRowIds: new Set<string>(),
    }),
  };
});

import { GrowthLeadDashboard } from "./GrowthLeadDashboard";

describe("GrowthLeadDashboard — Cohort Payback Engine reskin", () => {
  const html = renderToStaticMarkup(<GrowthLeadDashboard />);

  it("renders the decision-queue header", () => {
    expect(html).toContain("Growth decision queue");
  });

  it("renders the LTV-per-signup chart section + an SVG", () => {
    expect(html).toContain("LTV per signup");
    expect(html).toContain("<svg");
    expect(html).toContain("Revenue-per-signup by cohort");
  });

  it("renders the cohorts-ranked-by-payback table with real rows", () => {
    expect(html).toContain("Cohorts ranked by payback");
    expect(html).toContain("Jun 19");
    expect(html).toContain("$19.85");
  });

  it("labels payback status with a word, never color-only (a11y)", () => {
    expect(html).toContain("profitable");
    expect(html).toContain("underwater");
  });

  it("ranks the table highest-payback first ($19.85 row before $4.31 row)", () => {
    expect(html.indexOf("$19.85")).toBeLessThan(html.indexOf("$4.31"));
  });

  it("surfaces the still-deferred per-cohort channel-mix note rather than fabricating it", () => {
    expect(html).toContain("Per-cohort channel-mix attribution");
  });

  it("renders the growth decision queue from real decision rows", () => {
    expect(html).toContain("Growth decision queue");
    expect(html).toContain("Next decision");
    expect(html).toContain("Shift $500/wk from Meta to founder-led LinkedIn");
    expect(html).toContain("Add a day-3 activation email");
    expect(html).toContain("Budget reallocation");
    expect(html).toContain("Meta");
    expect(html).toContain("LinkedIn");
    expect(html).toContain("qualitative");
  });

  it("offers approval and chat handoffs instead of a passive bet log", () => {
    expect(html).toContain("Review on the Growth page");
    expect(html).toContain("Ask why");
    expect(html).toContain("Refine");
    expect(html).toContain("On deck");
  });

  it("shows bet status as a word (a11y — never color-only)", () => {
    expect(html).toContain("proposed");
    expect(html).toContain("acted");
  });

  it("keeps the AARRR funnel as a secondary section (no on-wire data dropped)", () => {
    expect(html).toContain("Funnel (AARRR)");
    expect(html).toContain("activated");
  });
});
