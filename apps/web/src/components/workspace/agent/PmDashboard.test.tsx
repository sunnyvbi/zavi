
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-ui")>();
  return {
    ...actual,
    AttentionList: () => null,
    useAgentDashboard: () => ({
      data: {
        generic: false,
        kpis: { in_flight: 1, shipped_measured: 1, won: 1, recurred: 1 },
        rows: [
          {
            id: "r1",
            theme: "Slack reply swallow",
            status: "in_flight",
            outcome: null,
            child_run_id: "abcdef1234",
            child_status: "running",
            updated_at: "2026-06-16T10:00:00Z",
          },
          {
            id: "r3",
            theme: "Courtesy turn boots sandbox",
            status: "proposed",
            outcome: "recurred",
            child_run_id: null,
            child_status: null,
            updated_at: "2026-06-18T00:00:00Z",
          },
        ],
        attention: [],
        flow_vitals: {
          inflow_vs_dispatch: [
            { week_start: "2026-05-18T00:00:00.000Z", inflow: 0, dispatched: 0 },
            { week_start: "2026-05-25T00:00:00.000Z", inflow: 1, dispatched: 0 },
            { week_start: "2026-06-01T00:00:00.000Z", inflow: 1, dispatched: 0 },
            { week_start: "2026-06-08T00:00:00.000Z", inflow: 0, dispatched: 1 },
            { week_start: "2026-06-15T00:00:00.000Z", inflow: 1, dispatched: 1 },
          ],
          outcomes: {
            proposed: 1,
            in_flight: 1,
            shipped_measured: 1,
            won: 1,
            recurred: 1,
          },
        },
      },
      loading: false,
      refreshing: false,
      error: null,
      refresh: () => {},
      newRowIds: new Set<string>(),
    }),
  };
});

import { PmDashboard } from "./PmDashboard";

describe("PmDashboard — flow-vitals richness", () => {
  const html = renderToStaticMarkup(<PmDashboard />);

  it("renders the Flow vitals panel (no longer a coming-soon placeholder)", () => {
    expect(html).toContain("Flow vitals");
    expect(html).not.toContain("coming soon");
  });

  it("renders the inflow-vs-dispatch widget with both legends + counts", () => {
    expect(html).toContain("Inflow vs dispatch");
    expect(html).toContain("inflow (3)");
    expect(html).toContain("dispatched (2)");
  });

  it("renders the weekly bars with an accessible image summary (a11y)", () => {
    expect(html).toContain('role="img"');
    expect(html).toContain("Weekly inflow versus dispatch");
    expect(html).toContain("Jun 15");
  });

  it("renders the lifecycle distribution with word labels, never color-only", () => {
    expect(html).toContain("Lifecycle distribution");
    expect(html).toContain("Held (won)");
    expect(html).toContain("Recurred");
    expect(html).toContain("Shipped / measured");
  });

  it("still renders the verdict banner + ledger (no on-wire data dropped)", () => {
    expect(html).toContain("shipped / measured ÷ recurred");
    expect(html).not.toContain("held ÷ recurred");
    expect(html).toContain("Backlog ledger");
    expect(html).toContain("Slack reply swallow");
  });
});
