
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "./dashboard-ui";

let mockState: DashboardState<unknown>;
vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>(
    "./dashboard-ui",
  );
  return { ...actual, useAgentDashboard: () => mockState };
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab: () => {} }),
  useWorkspaceOptional: () => null,
}));

import { EngineerDashboard } from "./EngineerDashboard";

const DAY = 24 * 60 * 60 * 1000;

function pr(over: Record<string, unknown> = {}) {
  return {
    run_id: "run-aaaaaaaa",
    number: 42,
    title: "Fix the thing",
    repo: "acme/repo",
    status: "open",
    url: "https://github.com/acme/repo/pull/42",
    opened_at: new Date(Date.now() - 1 * DAY).toISOString(),
    warn_flags: [],
    signals: {
      risk_class: "low",
      typecheck: "green",
      tests: { passed: 8, failed: 0, ran: true },
    },
    ...over,
  };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    generic: false,
    connected: true,
    kpis: { opened_30d: 1, merged: 0, awaiting_merge: 1, no_pr_runs: 0 },
    attention: [],
    prs: [pr()],
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

function flaggedPr(over: Record<string, unknown> = {}) {
  return pr({
    warn_flags: ["tests_warning"],
    ...over,
  });
}

describe("EngineerDashboard — signal chips (WarrantyCard)", () => {
  it("renders risk + green typecheck + test count chips with humble framing", () => {
    mockState = stateOf(
      payload({
        prs: [
          flaggedPr({
            signals: {
              risk_class: "low",
              typecheck: "green",
              tests: { passed: 8, failed: 0, ran: true },
            },
          }),
        ],
      }),
    );
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).toContain("Risk: low");
    expect(html).toContain("Typecheck green");
    expect(html).toContain("Tests 8/8");
    expect(html).toContain("agent-reported");
  });

  it("renders honest fallbacks for absent typecheck + no sandbox test run", () => {
    mockState = stateOf(
      payload({
        prs: [
          flaggedPr({
            signals: {
              risk_class: "trivial",
              typecheck: "not_reported",
              tests: { passed: 0, failed: 0, ran: false },
            },
          }),
        ],
      }),
    );
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).toContain("Typecheck not captured");
    expect(html).toContain("No sandbox test run");
    expect(html).not.toContain("24/24");
  });

  it("flags a red typecheck and a failing test count", () => {
    mockState = stateOf(
      payload({
        prs: [
          flaggedPr({
            signals: {
              risk_class: "medium",
              typecheck: "red",
              tests: { passed: 1, failed: 2, ran: true },
            },
          }),
        ],
      }),
    );
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).toContain("Typecheck red");
    expect(html).toContain("Tests 1/3");
    expect(html).toContain("Risk: medium");
  });

  it("does not throw when a PR row omits signals (older/cached wire)", () => {
    mockState = stateOf(payload({ prs: [flaggedPr({ signals: undefined })] }));
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).toContain("Fix the thing");
    expect(html).not.toContain("agent-reported");
  });
});

describe("EngineerDashboard — compact signal cell (inspection ledger table)", () => {
  it("renders tsc/tests/risk for a clean PR in the table", () => {
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).toContain("tsc green");
    expect(html).toContain("tests 8/8");
    expect(html).toContain("risk low");
  });

  it("shows n/a fallbacks (never a fabricated count) for unrun signals", () => {
    mockState = stateOf(
      payload({
        prs: [
          pr({
            signals: {
              risk_class: null,
              typecheck: "not_reported",
              tests: { passed: 0, failed: 0, ran: false },
            },
          }),
        ],
      }),
    );
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).toContain("tsc n/a");
    expect(html).toContain("tests n/a");
    expect(html).toContain("risk n/a");
    expect(html).not.toContain("24/24");
  });

  it("renders a dash (not chips) for a proposed never-inspected PR", () => {
    mockState = stateOf(
      payload({
        prs: [pr({ status: "proposed", number: null, url: null })],
      }),
    );
    const html = renderToStaticMarkup(<EngineerDashboard />);
    expect(html).not.toContain("agent-reported");
    expect(html).not.toContain("tsc green");
  });
});
