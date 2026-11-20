
import { describe, it, expect, vi } from "vitest";
import React from "react";
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

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab: () => "" }),
}));

const { DisputeResponseDashboard } = await import("./DisputeResponseDashboard");

function baseState<T>(data: T): DashboardState<T> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    refresh: () => {},
    newRowIds: new Set<string>(),
  };
}

function render(): string {
  return renderToStaticMarkup(React.createElement(DisputeResponseDashboard));
}

const NOW = Math.floor(Date.now() / 1000);
const H = 3600;
const D = 86400;

describe("DisputeResponseDashboard — connect / empty paths", () => {
  it("shows the connect empty-state when the backend returns generic:true", () => {
    mockState = baseState({ generic: true }) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Connect Stripe to open the docket");
    expect(html).not.toContain("Active docket");
  });

  it("shows the connect empty-state when Stripe is not connected", () => {
    mockState = baseState({
      generic: false,
      connected: false,
      kpis: {
        open_count: 0,
        amount_at_risk_usd: 0,
        win_rate: null,
        resolved_count: 0,
        recovered_usd: 0,
      },
      open: [],
      by_reason: [],
    }) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Connect Stripe to open the docket");
  });

  it("shows the 'no open disputes' state when connected with an empty docket", () => {
    mockState = baseState({
      generic: false,
      connected: true,
      kpis: {
        open_count: 0,
        amount_at_risk_usd: 0,
        win_rate: null,
        resolved_count: 2,
        recovered_usd: 0,
      },
      open: [],
      by_reason: [],
    }) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("No open disputes");
    expect(html).toContain("Active docket");
  });
});

describe("DisputeResponseDashboard — populated docket", () => {
  const FULL = {
    generic: false,
    connected: true,
    kpis: {
      open_count: 3,
      amount_at_risk_usd: 1624.5,
      win_rate: 0.58,
      resolved_count: 19,
      recovered_usd: 4180,
    },
    open: [
      {
        id: "dp_1PqrLatewindow99",
        amount_usd: 646,
        currency: "USD",
        reason: "product_not_received",
        due_by: NOW - 5 * H,
        past_due: true,
        has_evidence: false,
        submission_count: 0,
        ce3_status: "n/a",
        ce3_required_actions: [],
      },
      {
        id: "dp_1JklFraudQ77m",
        amount_usd: 899,
        currency: "USD",
        reason: "fraudulent",
        due_by: NOW + 40 * H,
        past_due: false,
        has_evidence: true,
        submission_count: 0,
        ce3_status: "requires_action",
        ce3_required_actions: [
          "Add 2+ prior undisputed transactions (120–365d old)",
        ],
      },
      {
        id: "dp_1MnoDup0031bb",
        amount_usd: 129,
        currency: "USD",
        reason: "duplicate",
        due_by: NOW + 6 * D,
        past_due: false,
        has_evidence: true,
        submission_count: 1,
        ce3_status: "qualified",
        ce3_required_actions: [],
      },
    ],
    by_reason: [
      {
        reason: "fraudulent",
        count: 1,
        total_usd: 899,
        won: 7,
        resolved: 11,
        win_rate: 7 / 11,
      },
      {
        reason: "duplicate",
        count: 1,
        total_usd: 129,
        won: 1,
        resolved: 1,
        win_rate: 1 / 1,
      },
    ],
  };

  it("renders KPIs, case files, reason labels, amounts, and the ledger", () => {
    mockState = baseState(FULL) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Amount at risk");
    expect(html).toContain("Win rate · 90d");
    expect(html).toContain("Recovered · 90d");
    expect(html).toContain("$4,180.00");
    expect(html).toContain("58%");
    expect(html).toContain("Active docket");
    expect(html).toContain("$899.00");
    expect(html).toContain("Fraud (Visa 10.4)");
    expect(html).toContain("Not received");
    expect(html).toContain("Duplicate");
    expect(html).toContain("By reason");
    expect(html).toContain("7 / 11");
  });

  it("conveys deadline status with text labels + caption, not color alone (a11y)", () => {
    mockState = baseState(FULL) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Past due");
    expect(html).toContain("Past due:");
    expect(html).toContain("Filing window closed");
    expect(html).toContain("Closing soon");
    expect(html).toContain("aria-label");
  });

  it("renders win-rate as a percentage only once 5+ resolved, else an em dash", () => {
    mockState = baseState(FULL) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("64%");
    expect(html).toContain("-");
  });

  it("surfaces Stripe CE 3.0 verdicts + evidence-staged state with text labels (a11y, not color-only)", () => {
    mockState = baseState(FULL) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("CE 3.0: action needed");
    expect(html).toContain("CE 3.0 qualified");
    expect(html).toContain("Evidence staged");
    expect(html).toContain("Submitted");
    expect(html).not.toContain("CE 3.0 not eligible");
    expect(html).toContain("To qualify for CE 3.0");
    expect(html).toContain("Add 2+ prior undisputed transactions");
  });

  it("older payload without evidence fields renders the card unchanged (no crash, no footer)", () => {
    const legacy = {
      ...FULL,
      open: [
        {
          id: "dp_legacy01",
          amount_usd: 200,
          currency: "USD",
          reason: "fraudulent",
          due_by: NOW + 4 * D,
          past_due: false,
        },
      ],
    };
    mockState = baseState(legacy) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("$200.00");
    expect(html).not.toContain("To qualify for CE 3.0");
    expect(html).not.toContain("Evidence staged");
  });
});
