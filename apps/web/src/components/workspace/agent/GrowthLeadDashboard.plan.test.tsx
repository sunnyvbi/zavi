
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

vi.mock("./ConstraintCard", () => ({ ConstraintCard: () => null }));

const h = vi.hoisted(() => ({ plan: null as unknown }));

vi.mock("./dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-ui")>();
  return {
    ...actual,
    AttentionList: () => null,
    useAgentDashboard: () => ({
      data: {
        generic: false,
        connected: true,
        current_growth_plan: h.plan,
        funnel: {
          connected: false,
          diagnosis_source: null,
          window: null,
          total_events_in_window: null,
          steps: [],
          top_of_funnel_count: null,
          bottleneck: null,
        },
        cohorts: { connected: false, currency: null, rows: [] },
        bets: [],
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

describe("GrowthLeadDashboard — Current growth plan panel (slice 4)", () => {
  it("renders a populated leaky_loop plan: do-this-first, then, later, exec tags", () => {
    h.plan = {
      stage: "leaky_loop",
      now: { action: "Fix the activation drop with a day-3 email", exec: "yes" },
      next: [
        { action: "Add an onboarding checklist", exec: "manual" },
        { action: "Connect Stripe for cohort payback", exec: "needs-connector" },
      ],
      later: ["Referral loop", "Paid retargeting test"],
      updated_at: "2026-07-13T10:00:00Z",
    };
    const html = renderToStaticMarkup(<GrowthLeadDashboard />);
    expect(html).toContain("This week");
    expect(html).toContain("growth plan");
    expect(html).toContain("Do this first");
    expect(html).toContain("Fix the activation drop with a day-3 email");
    expect(html).toContain("Working loop, with leaks");
    expect(html).toContain("Add an onboarding checklist");
    expect(html).toContain("Zavi can do this");
    expect(html).toContain("Needs a connector");
    expect(html).toContain("You do this");
    expect(html).toContain("Later (2)");
  });

  it("renders the data_not_ready state as a 'connect your data' framing, not a fake stage", () => {
    h.plan = {
      stage: "data_not_ready",
      now: {
        action:
          "Get a real funnel signal first — instrument your product events or connect your operator DB.",
        exec: "needs-connector",
      },
      next: [],
      later: [],
      updated_at: "2026-07-13T10:00:00Z",
    };
    const html = renderToStaticMarkup(<GrowthLeadDashboard />);
    expect(html).toContain("Connect your data");
    expect(html).toContain("Start here");
    expect(html).toContain("Get a real funnel signal first");
    expect(html).not.toContain("Working loop");
    expect(html).not.toContain("Before the loop");
  });

  it("renders the data_not_ready 'too thin' state (connected tenant) with the 'Needs more data' pill, not a connect CTA", () => {
    h.plan = {
      stage: "data_not_ready",
      now: {
        action:
          "Your funnel data is too thin to diagnose yet — keep your events and orders flowing; no new connector needed.",
        exec: "needs-data",
      },
      next: [],
      later: [],
      updated_at: "2026-07-13T10:00:00Z",
    };
    const html = renderToStaticMarkup(<GrowthLeadDashboard />);
    expect(html).toContain("Needs more data");
    expect(html).toContain("too thin to diagnose");
    expect(html).not.toContain("Needs a connector");
  });

  it("renders the null-plan empty state", () => {
    h.plan = null;
    const html = renderToStaticMarkup(<GrowthLeadDashboard />);
    expect(html).toContain("This week");
    expect(html).toContain("hasn");
    expect(html).toContain("set a plan yet");
  });
});
